import { EventEmitter } from 'node:events'
import { createServer, connect, Server as NetServer, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Client } from 'ssh2'
import { expect, it, vi } from 'vitest'
import { HostStore } from '../src/store.ts'
import { SshEngine, type PoolRecord } from '../src/engine.ts'

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

async function expectPortFree(port: number): Promise<void> {
  const probe = createServer()
  try {
    await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve) })
    expect(probe.listening).toBe(true)
  } finally { await new Promise<void>(resolve => probe.close(() => resolve())) }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tunnel-startup-')), store = new HostStore(join(root, 'hosts.json'))
  store.create({ alias: 'fixture', host: '127.0.0.1', port: 65534, user: 'fixture', auth: { kind: 'password' } })
  const engine = new SshEngine(store)
  const client = Object.assign(new EventEmitter(), { end: vi.fn(), forwardOut: vi.fn() })
  const record: PoolRecord = { client: client as unknown as Client, hops: [], idleAt: Date.now(), pinned: false, broken: false, inFlight: 0 }
  engine.pool.set('fixture', record)
  return { engine, store, record, client, close() { engine.dispose(); rmSync(root, { recursive: true, force: true }) } }
}

it('rejects a tunnel after disposal without binding its local port', async () => {
  const f = fixture(), port = await unusedPort()
  try {
    f.engine.dispose()
    await expect(f.engine.startTunnel('fixture', { remotePort: 65534, localPort: port })).rejects.toThrow('engine is closed')
    expect(f.engine.listTunnels()).toEqual([])
    await expectPortFree(port)
  } finally { f.close() }
})

it.each([false, true])('rolls back its pending listener when disposal wins the listen callback (workspace=%s)', async workspace => {
  const f = fixture(), port = await unusedPort()
  try {
    const pending = workspace ? f.engine.startWorkspaceTunnel('fixture', 65534, f.store.find('fixture')!.updatedAt)
      : f.engine.startTunnel('fixture', { remotePort: 65534, localPort: port })
    f.engine.dispose()
    await expect(pending).rejects.toThrow('engine is closed')
    expect(f.engine.tunnels.size).toBe(0)
    expect(f.record.pinned).toBe(false)
    expect(f.client.forwardOut).not.toHaveBeenCalled()
    if (!workspace) await expectPortFree(port)
  } finally { f.close() }
})

it('keeps a sibling tunnel alive while rejecting an edited host during a new bind', async () => {
  const f = fixture(), port = await unusedPort()
  try {
    const sibling = await f.engine.startTunnel('fixture', { remotePort: 65534 })
    const pending = f.engine.startTunnel('fixture', { remotePort: 65534, localPort: port })
    f.store.update('fixture', { description: 'edited while the next listener starts' })
    await expect(pending).rejects.toThrow('Host settings changed')
    expect(f.engine.listTunnels().map(row => row.id)).toEqual([sibling.id])
    expect(f.engine.tunnels.get(sibling.id)?.server.listening).toBe(true)
    expect(f.record.pinned).toBe(true); expect(f.client.end).not.toHaveBeenCalled()
    await expectPortFree(port)
  } finally { f.close() }
})

it('does not pin an obsolete record or close its replacement during a pending bind', async () => {
  const f = fixture(), port = await unusedPort()
  try {
    const pending = f.engine.startTunnel('fixture', { remotePort: 65534, localPort: port })
    const replacement = { ...f.record, client: { end: vi.fn() } as unknown as Client }
    f.engine.pool.set('fixture', replacement)
    await expect(pending).rejects.toThrow('SSH connection changed')
    expect(f.engine.pool.get('fixture')).toBe(replacement)
    expect(replacement.client.end).not.toHaveBeenCalled()
    expect(f.engine.tunnels.size).toBe(0); expect(f.record.pinned).toBe(false)
    await expectPortFree(port)
  } finally { f.close() }
})

it('still releases an established listener when disposed after startup', async () => {
  const f = fixture()
  try {
    const ready = await f.engine.startTunnel('fixture', { remotePort: 65534 })
    expect(f.engine.tunnels.get(ready.id)?.server.listening).toBe(true)
    f.engine.dispose()
    expect(f.engine.tunnels.size).toBe(0)
    await expectPortFree(ready.localPort)
  } finally { f.close() }
})

it('closes sockets accepted by an abandoned bind and releases a late forwarding channel', async () => {
  const f = fixture(), port = await unusedPort(), originalListen = NetServer.prototype.listen
  let acknowledgeListening: (() => void) | undefined, listeningServer: NetServer | undefined, peer: Socket | undefined
  const listen = vi.spyOn(NetServer.prototype, 'listen').mockImplementation(function (this: NetServer, ...args: unknown[]) {
    const callback = args.at(-1) as () => void
    args[args.length - 1] = function (this: NetServer) { listeningServer = this; acknowledgeListening = callback }
    return originalListen.apply(this, args as Parameters<typeof originalListen>)
  })
  const pending = f.engine.startTunnel('fixture', { remotePort: 65534, localPort: port })
  try {
    await vi.waitFor(() => expect(acknowledgeListening).toBeTypeOf('function'))
    peer = connect(port, '127.0.0.1'); peer.on('error', () => {})
    const closed = new Promise<void>(resolve => peer!.once('close', () => resolve()))
    await vi.waitFor(() => expect(f.client.forwardOut).toHaveBeenCalledOnce())
    f.engine.dispose(); acknowledgeListening!()
    await expect(pending).rejects.toThrow('engine is closed')
    await closed
    const late = Object.assign(new PassThrough(), { close: vi.fn(() => late.destroy()) })
    f.client.forwardOut.mock.calls[0]![4](undefined, late)
    expect(late.close).toHaveBeenCalledOnce()
    expect(() => late.emit('error', new Error('late channel failure'))).not.toThrow()
    expect(listeningServer?.listening).toBe(false); expect(f.engine.tunnels.size).toBe(0)
    listen.mockRestore(); await expectPortFree(port)
  } finally {
    listen.mockRestore(); peer?.destroy(); listeningServer?.close(); f.close()
  }
})
