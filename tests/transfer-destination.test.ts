import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Client, SFTPWrapper } from 'ssh2'
import { expect, it, vi } from 'vitest'
import { SshEngine } from '../src/engine.ts'
import { HostStore } from '../src/store.ts'
import { DEFAULTS, type PoolEngine } from '../src/engine/connection-pool.ts'
import { DEFAULT_KNOWN_HOSTS } from '../src/engine/known-hosts.ts'
import { inspectDestination } from '../src/engine/sftp.ts'
import { makeRoutes } from '../src/routes.ts'
import { SSH_API } from '../src/protocol.ts'
import { TestSshd } from './helpers/sshd.ts'
import { gatedTcp } from './helpers/gated-tcp.ts'

async function fixture(held = false) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-destination-')), remote = join(root, 'remote'); mkdirSync(remote)
  const sshd = await TestSshd.start({ home: remote }), gate = held ? await gatedTcp(sshd.port) : undefined
  if (gate) {
    const key = readFileSync(DEFAULT_KNOWN_HOSTS[0]!, 'utf8').split('\n').find(line => line.startsWith(`[127.0.0.1]:${sshd.port} `))!
    appendFileSync(DEFAULT_KNOWN_HOSTS[0]!, key.replace(`[127.0.0.1]:${sshd.port}`, `[127.0.0.1]:${gate.port}`) + '\n')
  }
  const store = new HostStore(join(root, 'hosts.json')), engine = new SshEngine(store)
  const entry = store.create({ alias: 'fixture', host: '127.0.0.1', port: gate?.port ?? sshd.port, user: process.env.USER!, auth: { kind: 'key', keyPath: sshd.clientKey } })
  const { routes } = makeRoutes({ store, engine, stagingDir: join(root, 'staging'), requestRejection: req => req.headers['x-reject-fixture'] ? 401 : undefined })
  const server = createServer((req, res) => { void routes.find(route => route.path === req.url?.split('?')[0])!.handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }, origin = `http://127.0.0.1:${address.port}`
  const url = (path: string, version?: string) => origin + SSH_API.transferDestination + '?' + new URLSearchParams({ alias: 'fixture', path, ...(version === undefined ? { expectedUpdatedAt: String(entry.updatedAt) } : version ? { expectedUpdatedAt: version } : {}) })
  return { root, remote, gate, engine, store, version: entry.updatedAt, url,
    async close() { engine.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await gate?.close(); sshd.stop(); rmSync(root, { recursive: true, force: true }) } }
}

it('reads file, empty file, directory, link and absence over real SFTP without changing bytes or receipt state', async () => {
  const f = await fixture(), file = join(f.remote, 'file.bin'); writeFileSync(file, 'original payload'); writeFileSync(join(f.remote, 'empty.bin'), '')
  mkdirSync(join(f.remote, 'folder')); symlinkSync(file, join(f.remote, 'link')); symlinkSync(join(f.remote, 'missing.bin'), join(f.remote, 'broken-link')); const before = statSync(file)
  try {
    const response = await fetch(f.url(file)); expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ exists: true, type: 'file', size: 16, mtimeMs: Math.floor(before.mtimeMs / 1000) * 1000, checkedAt: expect.any(Number) })
    expect(await (await fetch(f.url(join(f.remote, 'empty.bin')))).json()).toMatchObject({ exists: true, type: 'file', size: 0 })
    expect(await (await fetch(f.url(join(f.remote, 'folder')))).json()).toMatchObject({ exists: true, type: 'dir' })
    expect(await (await fetch(f.url(join(f.remote, 'link')))).json()).toMatchObject({ exists: true, type: 'symlink' })
    expect(await (await fetch(f.url(join(f.remote, 'missing.bin')))).json()).toMatchObject({ exists: false })
    expect(await (await fetch(f.url(join(f.remote, 'broken-link')))).json()).toMatchObject({ exists: true, type: 'symlink' })
    expect(readFileSync(file, 'utf8')).toBe('original payload'); expect(statSync(file).mtimeMs).toBe(before.mtimeMs)
    expect((await f.engine.exec('fixture', 'printf STILL_USABLE')).stdout).toBe('STILL_USABLE')
  } finally { await f.close() }
})

it('rejects missing/malformed versions, relative paths, stale targets, wrong methods and unauthenticated requests before SSH', async () => {
  const f = await fixture()
  try {
    for (const version of ['', 'bad', '0', '-1']) expect((await fetch(f.url(f.remote, version))).status).toBe(400)
    expect((await fetch(f.url('relative'))).status).toBe(400)
    expect((await fetch(f.url(f.remote), { method: 'POST' })).status).toBe(405)
    expect((await fetch(f.url(f.remote), { headers: { 'x-reject-fixture': '1' } })).status).toBe(401)
    f.store.update('fixture', { description: 'changed identity' })
    const stale = await fetch(f.url(f.remote)); expect(stale.status).toBe(409); expect(await stale.text()).toContain('destination was not checked')
    expect(f.engine.pool.size).toBe(0); expect(f.engine.acquireQueue.size).toBe(0)
  } finally { await f.close() }
})

it('rechecks the frozen host after handshake and refuses a host edited while the check is waiting', async () => {
  const f = await fixture(true)
  try {
    const pending = fetch(f.url(f.remote)); await vi.waitFor(() => expect(f.gate?.activeConnections).toBe(1))
    f.store.update('fixture', { description: 'edited during handshake' }); f.gate!.release()
    const response = await pending; expect(response.status).toBe(409); expect(await response.text()).toContain('destination was not checked')
    expect(f.gate?.acceptedConnections).toBe(1)
  } finally { await f.close() }
})

it('cancels an HTTP check during a shared handshake and preserves the other caller', async () => {
  const f = await fixture(true), stop = new AbortController()
  try {
    const check = fetch(f.url(f.remote), { signal: stop.signal }).catch(error => error)
    const survivor = f.engine.exec('fixture', 'printf SURVIVOR')
    await vi.waitFor(() => expect(f.engine.acquireQueue.get('fixture')?.waiters).toBe(2))
    stop.abort(); expect(await check).toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(f.engine.acquireQueue.get('fixture')?.waiters).toBe(1))
    f.gate!.release(); expect(await survivor).toMatchObject({ success: true, stdout: 'SURVIVOR' })
    expect(f.gate?.acceptedConnections).toBe(1); expect(f.engine.acquireQueue.size).toBe(0)
  } finally { await f.close() }
})

function fake() {
  let ack!: (error: Error | undefined, sftp: SFTPWrapper) => void, reply!: (error?: Error, attrs?: unknown) => void
  const client = Object.assign(new EventEmitter(), { sftp: vi.fn((callback: typeof ack) => { ack = callback }), end: vi.fn() })
  const channel = Object.assign(new EventEmitter(), { end: vi.fn(() => channel.emit('close')), lstat: vi.fn((_path, callback: typeof reply) => { reply = callback }) })
  const record = { client: client as unknown as Client, hops: [], idleAt: Date.now(), pinned: false, broken: false, inFlight: 0 }
  const engine = { opts: DEFAULTS, store: { find: () => ({ updatedAt: 12 }) }, pool: new Map([['fixture', record]]) } as unknown as PoolEngine
  return { client, channel, engine, record, acknowledge: () => ack(undefined, channel as unknown as SFTPWrapper), reply: (error?: Error, attrs?: unknown) => reply(error, attrs) }
}
it('never labels permission or transport errors as a missing file', async () => {
  for (const code of [3, 4, 7]) {
    const f = fake(), pending = inspectDestination(f.engine, 'fixture', '/original/file', 12); f.acknowledge()
    f.reply(Object.assign(new Error('Permission or connection failed'), { code }))
    await expect(pending).rejects.toThrow('failed'); expect(f.channel.end).toHaveBeenCalledOnce(); expect(f.client.end).not.toHaveBeenCalled()
  }
})
it('closes a late SFTP channel after cancellation without lstat dispatch or pooling disruption', async () => {
  const f = fake(), stop = new AbortController(), pending = inspectDestination(f.engine, 'fixture', '/original/file', 12, stop.signal)
  stop.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); f.acknowledge()
  expect(f.channel.lstat).not.toHaveBeenCalled(); expect(f.channel.end).toHaveBeenCalledOnce(); expect(f.client.end).not.toHaveBeenCalled(); expect(f.record.inFlight).toBe(0)
})
it('ignores a late stat reply after stopping its own channel and leaves the connection reusable', async () => {
  const f = fake(), stop = new AbortController(), pending = inspectDestination(f.engine, 'fixture', '/original/file', 12, stop.signal); f.acknowledge()
  expect(f.channel.lstat).toHaveBeenCalledOnce(); stop.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  f.reply(undefined, { size: 4, mtime: 1, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true })
  expect(f.channel.end).toHaveBeenCalledOnce(); expect(f.client.end).not.toHaveBeenCalled(); expect(f.record.inFlight).toBe(0)
})
