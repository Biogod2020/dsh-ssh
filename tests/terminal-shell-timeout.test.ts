import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { Client, ClientChannel } from 'ssh2'
import { HostStore } from '../src/store.ts'
import { SshEngine } from '../src/engine.ts'
import { openShell } from '../src/engine/pty.ts'
import * as connectionPool from '../src/engine/connection-pool.ts'
import { InteractiveSsh } from './helpers/interactive-ssh.ts'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

function deferredShell() {
  const client = Object.assign(new EventEmitter(), { destroy: vi.fn(), shell: vi.fn() })
  const hop = { destroy: vi.fn() }
  let acknowledge!: (error: Error | undefined, stream: ClientChannel) => void
  client.shell.mockImplementation((_options, callback) => { acknowledge = callback })
  vi.spyOn(connectionPool, 'connectChain').mockResolvedValue({ client: client as unknown as Client, hops: [hop as unknown as Client] })
  const target = { alias: 'fixture', user: 'fixture', host: '127.0.0.1', port: 22, updatedAt: 1 }
  const engine = { store: { find: () => target }, opts: { ...connectionPool.DEFAULTS, connectTimeoutMs: 500 } } as unknown as SshEngine
  const channel = Object.assign(new EventEmitter(), { write: vi.fn(), setWindow: vi.fn(), close: vi.fn(), destroy: vi.fn(), pause: vi.fn(), resume: vi.fn() })
  return { client, hop, engine, channel, acknowledge: () => acknowledge(undefined, channel as unknown as ClientChannel) }
}

it('bounds a missing shell acknowledgement after successful authentication without replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-shell-ack-timeout-')), ssh = await InteractiveSsh.start(true)
  const store = new HostStore(join(root, 'hosts.json'))
  const engine = new SshEngine(store, { connectTimeoutMs: 500 })
  store.create({ alias: 'fixture', host: '127.0.0.1', port: ssh.port, user: 'fixture', auth: { kind: 'password' } })
  const controller = new AbortController()
  const pending = engine.openShell('fixture', { cols: 80, rows: 24 }, (_name, _instructions, _lang, _prompts, finish) => {
    finish([ssh.answers[ssh.challenges - 1]!])
  }, controller.signal)
  // Observe both outcomes immediately so fixture cleanup cannot leave a late
  // rejection unhandled after the bounded assertion below.
  const outcome = pending.then(() => ({ kind: 'ready', error: '' }), cause => ({ kind: 'error', error: String(cause) }))
  try {
    for (let n = 0; n < 200 && ssh.shellRequests === 0; n++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(ssh.shellRequests).toBe(1)
    const actual = await Promise.race([outcome, new Promise<{ kind: string; error: string }>(resolve => setTimeout(() => resolve({ kind: 'pending', error: '' }), 1000))])
    expect(actual.kind).toBe('error')
    expect(actual.error).toMatch(/shell.*timed out|terminal.*timed out/i)
    expect(ssh.shellRequests).toBe(1)
    expect(ssh.shells).toBe(0)
    expect(ssh.inputs).toEqual([])
  } finally {
    controller.abort(); await outcome
    engine.dispose(); await ssh.stop(); rmSync(root, { recursive: true, force: true })
  }
})

it('releases a late shell acknowledgement once after timeout without opening again', async () => {
  vi.useFakeTimers()
  const f = deferredShell(), pending = openShell(f.engine, 'fixture', { cols: 80, rows: 24 })
  const outcome = pending.catch(error => error)
  await Promise.resolve(); await vi.advanceTimersByTimeAsync(501)
  expect(String(await outcome)).toMatch(/opening timed out.*outcome unknown.*not retried/i)
  expect(f.client.destroy).toHaveBeenCalledOnce(); expect(f.hop.destroy).toHaveBeenCalledOnce()
  expect(f.client.listenerCount('close')).toBe(0); expect(f.client.listenerCount('error')).toBe(0)
  f.acknowledge()
  expect(f.channel.destroy).toHaveBeenCalledOnce()
  expect(() => f.channel.emit('error', new Error('late channel failure'))).not.toThrow()
  expect(f.client.shell).toHaveBeenCalledOnce(); expect(f.client.destroy).toHaveBeenCalledOnce()
})

it.each(['close', 'error'])('settles an outstanding shell request on SSH %s without replay', async event => {
  const f = deferredShell(), pending = openShell(f.engine, 'fixture', { cols: 80, rows: 24 })
  const outcome = pending.catch(error => error)
  await Promise.resolve()
  f.client.emit(event, new Error('fixture transport failed'))
  expect(String(await outcome)).toMatch(/opening terminal.*outcome unknown.*not retried/i)
  expect(f.client.shell).toHaveBeenCalledOnce(); expect(f.client.destroy).toHaveBeenCalledOnce()
  expect(f.hop.destroy).toHaveBeenCalledOnce()
})

it('clears the opening deadline when the shell is ready and preserves subsequent input', async () => {
  vi.useFakeTimers()
  const f = deferredShell(), pending = openShell(f.engine, 'fixture', { cols: 80, rows: 24 })
  await Promise.resolve(); f.acknowledge()
  const shell = await pending
  await vi.advanceTimersByTimeAsync(5000)
  expect(f.client.destroy).not.toHaveBeenCalled(); expect(f.hop.destroy).not.toHaveBeenCalled()
  shell.send('one explicit input')
  expect(f.channel.write).toHaveBeenCalledExactlyOnceWith('one explicit input')
  shell.close()
  expect(f.channel.close).toHaveBeenCalledOnce(); expect(f.client.destroy).toHaveBeenCalledOnce()
})
