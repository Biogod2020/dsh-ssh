import { afterEach, expect, it, vi } from 'vitest'
import { createServer as httpServer } from 'node:http'
import { connect, createServer as tcpServer, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteGateway } from '../src/remote/gateway.ts'
import { RemoteWorkspaces } from '../src/remote/manager.ts'
import { HostStore } from '../src/store.ts'
import type { SshEngine } from '../src/engine.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function wait(test: () => boolean) {
  for (let n = 0; n < 200; n++) { if (test()) return; await delay(5) }
  throw new Error('Fixture condition timed out')
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cancel-recovery-'))
  const hostStore = new HostStore(join(root, 'hosts.json'))
  const host = hostStore.create({ alias: 'fixture', host: '127.0.0.1', port: 22, user: 'fixture', auth: { kind: 'password', password: 'fixture-only' } })
  let dispatched = 0, releaseCancel: ((redirect?: boolean) => void) | undefined
  const remote = httpServer((req, res) => {
    if (req.url?.startsWith('/?token=')) { res.writeHead(303, { 'Set-Cookie': 'fixture=only; Path=/' }); res.end(); return }
    if (req.url === '/api/session/cancel') {
      let raw = ''
      req.on('data', chunk => { raw += chunk })
      req.once('end', () => {
        dispatched++
        const { rpcId } = JSON.parse(raw)
        releaseCancel = redirect => {
          if (res.writableEnded || res.destroyed) return
          if (redirect) { res.writeHead(302, { Location: `http://${req.headers.host}/after-cancel` }); res.end(); return }
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: { accepted: true } } }))
        }
      })
      return
    }
    res.writeHead(200); res.end('ready')
  })
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve))
  const remotePort = (remote.address() as { port: number }).port
  const tunnels = new Map<string, { port: number; stop(): void }>()
  async function tunnel(id: string) {
    const sockets = new Set<Socket>()
    const server = tcpServer(socket => {
      const upstream = connect(remotePort, '127.0.0.1')
      sockets.add(socket); sockets.add(upstream)
      const close = () => { socket.destroy(); upstream.destroy(); sockets.delete(socket); sockets.delete(upstream) }
      socket.on('error', close); upstream.on('error', close); socket.on('close', close); upstream.on('close', close)
      socket.pipe(upstream).pipe(socket)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const value = { port: (server.address() as { port: number }).port, stop() { server.close(); for (const socket of sockets) socket.destroy(); sockets.clear() } }
    tunnels.set(id, value); return value
  }
  const first = await tunnel('old')
  const stop = vi.fn((id: string) => { tunnels.get(id)?.stop(); return true })
  const engine = { find: (alias: string) => hostStore.find(alias), stopWorkspaceTunnel: stop,
    startWorkspaceTunnel: vi.fn(async () => ({ id: 'new', localPort: (await tunnel('new')).port })) }
  const gateway = new RemoteGateway(first.port, { protocol: 1, pid: process.pid, port: remotePort, url: `http://127.0.0.1:${remotePort}/?token=fixture-only`,
    root, directory: root, userHome: root, version: '0.2.1-rc.2' }, 'fixture', 'http://127.0.0.1:1/', 'fixture', 'fixture')
  await gateway.start()
  const manager = new RemoteWorkspaces(engine as unknown as SshEngine, { root: join(root, 'manager'), installer: '', bootstrap: '', returnUrl: () => 'http://127.0.0.1:1/' })
  clearInterval((manager as any).recovery)
  const hostId = (manager as any).hostId('fixture')
  ;(manager as any).runtimes.set(hostId, { gateway, hostId, alias: 'fixture', updatedAt: host.updatedAt, tunnelId: 'old', retryAt: 0, failures: 0 })
  const login = await fetch(gateway.launch(), { redirect: 'manual' })
  const cookie = login.headers.getSetCookie().map(x => x.split(';')[0]).join('; ')
  cleanups.push(async () => {
    releaseCancel?.(); manager.dispose(); gateway.dispose(); for (const value of tunnels.values()) value.stop()
    remote.closeAllConnections(); await new Promise<void>(resolve => remote.close(() => resolve())); rmSync(root, { recursive: true, force: true })
  })
  const requestCancel = (signal?: AbortSignal) => fetch(gateway.origin + '/api/session/cancel', { method: 'POST', headers: { Cookie: cookie, Origin: gateway.origin, 'content-type': 'application/json' }, body: '{}', signal, redirect: 'manual' })
  return { gateway, manager, engine, first, stop, requestCancel, get dispatched() { return dispatched }, release: (redirect = false) => releaseCancel?.(redirect) }
}

it('keeps a dispatched cancellation acknowledgement intact while replacing the SSH carrier, without resending it', async () => {
  const f = await fixture()
  const cancelling = f.requestCancel()
  await wait(() => f.dispatched === 1)
  vi.spyOn(f.gateway, 'healthy').mockResolvedValueOnce(false)
  const repairing = f.manager.repairConnections()
  await wait(() => f.gateway.localPort !== f.first.port)
  expect(f.stop).not.toHaveBeenCalledWith('old')
  expect(await f.gateway.healthy()).toBe(true)
  f.release()
  const response = await cancelling
  await repairing
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ result: { ok: true, value: { accepted: true } } })
  expect(f.dispatched).toBe(1)
  expect(f.stop).toHaveBeenCalledWith('old')
  expect(await f.gateway.healthy()).toBe(true)
})

it('also drains a dispatched controller RPC before retiring its old carrier', async () => {
  const f = await fixture()
  const cancelling = f.gateway.rpc('session/cancel', { request: { sessionId: 'fixture' } })
  await wait(() => f.dispatched === 1)
  vi.spyOn(f.gateway, 'healthy').mockResolvedValueOnce(false)
  const repairing = f.manager.repairConnections()
  await wait(() => f.gateway.localPort !== f.first.port)
  expect(f.stop).not.toHaveBeenCalledWith('old')
  f.release()
  await expect(cancelling).resolves.toEqual({ accepted: true })
  await repairing
  expect(f.dispatched).toBe(1)
})

it('releases both tunnels when disposal interrupts the grace period', async () => {
  const f = await fixture()
  const cancelling = f.requestCancel().catch(() => undefined)
  await wait(() => f.dispatched === 1)
  vi.spyOn(f.gateway, 'healthy').mockResolvedValueOnce(false)
  const repairing = f.manager.repairConnections()
  await wait(() => f.gateway.localPort !== f.first.port)
  f.manager.dispose()
  await repairing; await cancelling
  expect(f.stop).toHaveBeenCalledWith('old')
  expect(f.stop).toHaveBeenCalledWith('new')
  expect(f.dispatched).toBe(1)
})

it('bounds the grace period without repeating an unconfirmed cancellation', async () => {
  const f = await fixture()
  const cancelling = f.requestCancel()
  await wait(() => f.dispatched === 1)
  await f.gateway.drainRequests(f.first.port, 10)
  expect(f.dispatched).toBe(1)
  f.release()
  expect((await cancelling).status).toBe(200)
})

it('releases the old request when the browser abandons it, without resending', async () => {
  const f = await fixture(), controller = new AbortController()
  const cancelling = f.requestCancel(controller.signal).catch(() => undefined)
  await wait(() => f.dispatched === 1)
  controller.abort(); await cancelling
  await f.gateway.drainRequests(f.first.port)
  expect(f.dispatched).toBe(1)
})

it('still reports an unconfirmed outcome on a genuinely broken carrier, without retrying the cancellation', async () => {
  const f = await fixture()
  const cancelling = f.requestCancel()
  await wait(() => f.dispatched === 1)
  f.first.stop()
  const response = await cancelling
  expect(response.status).toBe(502)
  expect(await response.text()).toContain('not replayed')
  await f.gateway.drainRequests(f.first.port)
  expect(f.dispatched).toBe(1)
  expect(f.engine.startWorkspaceTunnel).not.toHaveBeenCalled()
})

it('rewrites an old-carrier redirect against that request origin while the replacement is active', async () => {
  const f = await fixture()
  const cancelling = f.requestCancel()
  await wait(() => f.dispatched === 1)
  vi.spyOn(f.gateway, 'healthy').mockResolvedValueOnce(false)
  const repairing = f.manager.repairConnections()
  await wait(() => f.gateway.localPort !== f.first.port)
  f.release(true)
  const response = await cancelling
  await repairing
  expect(response.status).toBe(302)
  expect(response.headers.get('location')).toBe('/after-cancel')
  expect(f.dispatched).toBe(1)
})
