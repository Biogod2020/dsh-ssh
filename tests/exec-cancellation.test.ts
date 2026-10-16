import { expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Client, ClientChannel } from 'ssh2'
import { DEFAULTS, execCommand, type PoolEngine } from '../src/engine/connection-pool.ts'

function fixture() {
  let acknowledged: (error: Error | undefined, channel: ClientChannel) => void
  const client = Object.assign(new EventEmitter(), {
    exec: vi.fn((_command, callback) => { acknowledged = callback }),
  })
  const record = { client: client as unknown as Client, hops: [], idleAt: Date.now(), pinned: false, broken: false, inFlight: 0 }
  const engine = { opts: DEFAULTS, pool: new Map([['fixture', record]]) } as unknown as PoolEngine
  const channel = Object.assign(new EventEmitter(), {
    signal: vi.fn(), close: vi.fn(() => channel.emit('error', new Error('late channel closed'))),
  }) as unknown as ClientChannel
  return { engine, client, record, channel, acknowledge: () => acknowledged(undefined, channel) }
}

it('cancels while dispatch acknowledgement is missing, then closes the late channel exactly once', async () => {
  const f = fixture(), controller = new AbortController()
  const pending = execCommand(f.engine, 'fixture', 'write-side-effect', 10000, controller.signal)
  controller.abort()
  expect(await pending).toMatchObject({ success: false, exitCode: null, timedOut: false, error: expect.stringContaining('outcome unknown') })
  expect(f.record.inFlight).toBe(0)
  expect(f.client.listenerCount('close')).toBe(0)
  expect(() => f.acknowledge()).not.toThrow()
  expect(f.channel.close).toHaveBeenCalledTimes(1)
  expect(f.client.exec).toHaveBeenCalledTimes(1)
})

it('enforces the execution budget before acknowledgement and removes connection listeners', async () => {
  const f = fixture()
  const result = await execCommand(f.engine, 'fixture', 'hang', 20)
  expect(result).toMatchObject({ success: false, timedOut: true })
  expect(f.record.inFlight).toBe(0)
  expect(f.client.listenerCount('close')).toBe(0)
  expect(() => f.acknowledge()).not.toThrow()
  expect(f.channel.close).toHaveBeenCalledTimes(1)
})

it('releases listeners and its execution budget when dispatch throws synchronously', async () => {
  const f = fixture()
  f.client.exec.mockImplementation(() => { throw new Error('channel limit') })
  await expect(execCommand(f.engine, 'fixture', 'write', 10000)).rejects.toThrow('channel limit')
  expect(f.record.inFlight).toBe(0)
  expect(f.client.listenerCount('close')).toBe(0)
  expect(f.client.exec).toHaveBeenCalledTimes(1)
})
