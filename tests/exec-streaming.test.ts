import { EventEmitter } from 'node:events'
import type { Client, ClientChannel } from 'ssh2'
import { expect, it, vi } from 'vitest'
import { DEFAULTS, execCommand, type PoolEngine } from '../src/engine/connection-pool.ts'

function fixture(maxOutputBytes = 100) {
  let ack: (error: Error | undefined, stream: ClientChannel) => void
  const stderr = Object.assign(new EventEmitter(), { pause: vi.fn(), resume: vi.fn() })
  const stream = Object.assign(new EventEmitter(), { stderr, pause: vi.fn(), resume: vi.fn() })
  const client = Object.assign(new EventEmitter(), { exec: vi.fn((_command, callback) => { ack = callback }) })
  const engine = { opts: { ...DEFAULTS, maxOutputBytes }, store: { find: () => ({ updatedAt: 2 }) },
    pool: new Map([['fixture', { client: client as unknown as Client, hops: [], idleAt: Date.now(), pinned: false, broken: false, inFlight: 0 }]]) } as unknown as PoolEngine
  return { engine, stream, client, ack: () => ack(undefined, stream as unknown as ClientChannel) }
}

it('streams UTF-8 across chunk boundaries and pauses both output lanes under backpressure', async () => {
  const f = fixture(), events: unknown[] = []
  const pending = execCommand(f.engine, 'fixture', 'read', 1000, undefined, (event, flow) => {
    events.push(event)
    if (event.type === 'output') { flow?.pause(); flow?.resume() }
  })
  f.ack()
  const bytes = Buffer.from('你好😊')
  f.stream.emit('data', bytes.subarray(0, 2)); f.stream.emit('data', bytes.subarray(2, 7)); f.stream.emit('data', bytes.subarray(7))
  f.stream.stderr.emit('data', Buffer.from('warning')); f.stream.emit('close', 0)
  const result = await pending
  expect(result.stdout).toBe('你好😊'); expect(result.stderr).toBe('warning')
  expect(events).toContainEqual({ type: 'dispatch' })
  expect(f.stream.pause).toHaveBeenCalled(); expect(f.stream.stderr.pause).toHaveBeenCalled()
  expect(f.stream.resume).toHaveBeenCalled(); expect(f.stream.stderr.resume).toHaveBeenCalled()
  expect(f.client.exec).toHaveBeenCalledOnce()
})

it('bounds multi-byte output in bytes and marks truncation once in the live stream', async () => {
  const f = fixture(5), parts: string[] = []
  const pending = execCommand(f.engine, 'fixture', 'read', 1000, undefined, event => { if (event.type === 'output') parts.push(event.data) })
  f.ack(); f.stream.emit('data', Buffer.from('你')); f.stream.emit('data', Buffer.from('好')); f.stream.emit('data', Buffer.from('extra')); f.stream.emit('close', 0)
  const result = await pending
  expect(result.stdout).toBe('你…[output truncated]'); expect(parts.join('')).toBe(result.stdout)
})

it('refuses a changed host after acquiring its connection without dispatching', async () => {
  const f = fixture()
  await expect(execCommand(f.engine, 'fixture', 'write', 1000, undefined, undefined, 1)).rejects.toThrow('configuration changed')
  expect(f.client.exec).not.toHaveBeenCalled()
})
