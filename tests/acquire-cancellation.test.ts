import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SshEngine } from '../src/engine.ts'
import { HostStore } from '../src/store.ts'
import { DEFAULT_KNOWN_HOSTS } from '../src/engine/known-hosts.ts'
import { gatedTcp } from './helpers/gated-tcp.ts'
import { TestSshd } from './helpers/sshd.ts'

async function wait(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(check()).toBe(true)
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-acquire-cancel-')), sshd = await TestSshd.start({ home: root })
  const gate = await gatedTcp(sshd.port)
  const hostKey = readFileSync(DEFAULT_KNOWN_HOSTS[0]!, 'utf8').split('\n').find(line => line.startsWith(`[127.0.0.1]:${sshd.port} `))!
  appendFileSync(DEFAULT_KNOWN_HOSTS[0]!, hostKey.replace(`[127.0.0.1]:${sshd.port}`, `[127.0.0.1]:${gate.port}`) + '\n')
  const store = new HostStore(join(root, 'hosts.json')), engine = new SshEngine(store, { connectTimeoutMs: 5000 })
  store.create({ alias: 'held', host: '127.0.0.1', port: gate.port, user: process.env.USER!, auth: { kind: 'key', keyPath: sshd.clientKey } })
  const marker = join(root, 'command-count')
  return { root, sshd, gate, engine, store, marker,
    command: `printf 'once\\n' >> '${marker}'; printf 'done'`,
    async close() { engine.dispose(); await gate.close(); sshd.stop(); rmSync(root, { recursive: true, force: true }) },
  }
}

it('cancels its last SSH waiter promptly, closes establishment and never dispatches or retries', async () => {
  const f = await fixture(), controller = new AbortController()
  try {
    const pending = f.engine.exec('held', f.command, 5000, controller.signal).catch(error => error)
    await wait(() => f.gate.activeConnections === 1)
    const start = Date.now(); controller.abort()
    expect(await pending).toMatchObject({ name: 'AbortError', message: expect.stringContaining('before dispatch') })
    expect(Date.now() - start).toBeLessThan(500)
    await wait(() => f.gate.activeConnections === 0 && f.engine.connectionStatus()[0]?.state === 'disconnected')
    expect(f.engine.acquireQueue.size).toBe(0); expect(f.engine.pool.size).toBe(0)
    f.gate.release(); await new Promise(resolve => setTimeout(resolve, 50))
    expect(f.gate.acceptedConnections).toBe(1); expect(existsSync(f.marker)).toBe(false)
  } finally { await f.close() }
})

it('cancels one caller while another shares the same handshake and executes exactly once', async () => {
  const f = await fixture(), controller = new AbortController()
  try {
    const cancelled = f.engine.exec('held', f.command, 5000, controller.signal).catch(error => error)
    const survivor = f.engine.exec('held', f.command, 5000)
    await wait(() => f.gate.activeConnections === 1)
    controller.abort(); expect(await cancelled).toMatchObject({ name: 'AbortError' })
    expect(f.gate.activeConnections).toBe(1); expect(f.engine.acquireQueue.get('held')?.waiters).toBe(1)
    f.gate.release()
    expect(await survivor).toMatchObject({ success: true, stdout: 'done' })
    expect(readFileSync(f.marker, 'utf8')).toBe('once\n'); expect(f.gate.acceptedConnections).toBe(1)
    expect((await f.engine.exec('held', 'printf followup')).stdout).toBe('followup')
  } finally { await f.close() }
})

it('lets a new explicit operation establish fresh ownership immediately after the last waiter cancels', async () => {
  const f = await fixture(), controller = new AbortController()
  try {
    const abandoned = f.engine.exec('held', f.command, 5000, controller.signal).catch(error => error)
    await wait(() => f.gate.activeConnections === 1)
    controller.abort()
    // Do not await old handshake cleanup before starting the independent call.
    const fresh = f.engine.exec('held', f.command, 5000)
    expect(await abandoned).toMatchObject({ name: 'AbortError' })
    await wait(() => f.gate.acceptedConnections === 2)
    f.gate.release(); expect(await fresh).toMatchObject({ success: true })
    expect(readFileSync(f.marker, 'utf8')).toBe('once\n'); expect(f.engine.pool.size).toBe(1)
    expect(f.engine.acquireQueue.size).toBe(0)
  } finally { await f.close() }
})

it('cancels upload and download before SFTP starts without creating either destination', async () => {
  const f = await fixture(), controller = new AbortController()
  const source = join(f.root, 'source.bin'), remote = join(f.root, 'remote.bin'), local = join(f.root, 'download.bin')
  writeFileSync(source, Buffer.alloc(32 * 1024, 17))
  try {
    const upload = f.engine.upload('held', source, remote, false, undefined, controller.signal).catch(error => error)
    const download = f.engine.download('held', source, local, undefined, controller.signal).catch(error => error)
    await wait(() => f.gate.activeConnections === 1); controller.abort()
    expect(await upload).toMatchObject({ name: 'AbortError' }); expect(await download).toMatchObject({ name: 'AbortError' })
    await wait(() => f.gate.activeConnections === 0)
    expect(existsSync(remote)).toBe(false); expect(existsSync(local)).toBe(false)
    expect(f.engine.pool.size).toBe(0)
  } finally { await f.close() }
})

it('keeps a download waiting when a same-alias command is cancelled, then transfers exact bytes', async () => {
  const f = await fixture(), controller = new AbortController()
  const source = join(f.root, 'source.bin'), local = join(f.root, 'download.bin'), bytes = Buffer.alloc(65536, 29)
  writeFileSync(source, bytes)
  try {
    const command = f.engine.exec('held', f.command, 5000, controller.signal).catch(error => error)
    const download = f.engine.download('held', source, local)
    await wait(() => f.gate.activeConnections === 1); controller.abort()
    expect(await command).toMatchObject({ name: 'AbortError' }); expect(f.gate.activeConnections).toBe(1)
    f.gate.release(); expect(await download).toEqual({ bytes: bytes.length })
    expect(readFileSync(local)).toEqual(bytes); expect(existsSync(f.marker)).toBe(false)
  } finally { await f.close() }
})

it('stops a cluster in establishment and leaves every queued command undispatched', async () => {
  const f = await fixture(), controller = new AbortController(), states: string[] = []
  const entry = f.store.find('held')!
  f.store.create({ alias: 'queued', host: entry.host, port: entry.port, user: entry.user, auth: entry.auth })
  try {
    const pending = f.engine.cluster({ aliases: ['held', 'queued'], command: f.command, maxWorkers: 1, signal: controller.signal,
      onEvent: event => { if (event.type === 'state') states.push(`${event.alias}:${event.state}`) } })
    await wait(() => f.gate.activeConnections === 1); const start = Date.now(); controller.abort()
    expect(await pending).toEqual([
      expect.objectContaining({ alias: 'held', cancelled: true, dispatched: false }),
      expect.objectContaining({ alias: 'queued', cancelled: true, dispatched: false }),
    ])
    expect(Date.now() - start).toBeLessThan(500); expect(states).toEqual(['held:connecting'])
    await wait(() => f.gate.activeConnections === 0); expect(existsSync(f.marker)).toBe(false)
  } finally { await f.close() }
})

it('invalidates an in-progress handshake on host edit and cannot publish or use its old identity', async () => {
  const f = await fixture()
  try {
    const pending = f.engine.exec('held', f.command).catch(error => error)
    await wait(() => f.gate.activeConnections === 1)
    f.store.update('held', { port: f.sshd.port }); f.engine.dropAlias('held')
    expect(await pending).toMatchObject({ message: expect.stringContaining('no operation was dispatched') })
    await wait(() => f.gate.activeConnections === 0)
    f.gate.release(); expect(f.engine.pool.size).toBe(0)
    expect((await f.engine.exec('held', f.command)).success).toBe(true)
    expect(readFileSync(f.marker, 'utf8')).toBe('once\n')
  } finally { await f.close() }
})

it('plugin disposal cancels pending establishment and prevents late publication or new work', async () => {
  const f = await fixture()
  try {
    const pending = f.engine.exec('held', f.command).catch(error => error)
    await wait(() => f.gate.activeConnections === 1); f.engine.dispose()
    expect(await pending).toMatchObject({ message: expect.stringContaining('SSH engine closed') })
    await wait(() => f.gate.activeConnections === 0)
    f.gate.release(); expect(f.engine.pool.size).toBe(0); expect(f.engine.acquireQueue.size).toBe(0)
    await expect(f.engine.exec('held', f.command)).rejects.toThrow('SSH engine is closed')
    expect(existsSync(f.marker)).toBe(false)
  } finally { await f.close() }
})

it('rejects a version changed during authentication even when no explicit invalidation was sent', async () => {
  const f = await fixture()
  try {
    const pending = f.engine.exec('held', f.command).catch(error => error)
    await wait(() => f.gate.activeConnections === 1)
    f.store.update('held', { description: 'edited while connecting' }); f.gate.release()
    expect(await pending).toMatchObject({ message: expect.stringContaining('Host configuration changed') })
    await wait(() => f.gate.activeConnections === 0)
    expect(f.engine.pool.size).toBe(0); expect(existsSync(f.marker)).toBe(false)
    expect((await f.engine.exec('held', f.command)).success).toBe(true)
    expect(readFileSync(f.marker, 'utf8')).toBe('once\n')
  } finally { await f.close() }
})
