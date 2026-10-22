import { afterEach, expect, it, vi } from 'vitest'
import { createServer as httpServer, get as httpGet } from 'node:http'
import { gzipSync } from 'node:zlib'
import { connect, createServer as tcpServer, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteGateway } from '../src/remote/gateway.ts'
import { RemoteWorkspaces } from '../src/remote/manager.ts'
import { HostStore } from '../src/store.ts'
import type { SshEngine } from '../src/engine.ts'
import { WebSocket, WebSocketServer } from 'ws'
import { once } from 'node:events'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function wait(test: () => boolean) {
  for (let n = 0; n < 200; n++) { if (test()) return; await delay(5) }
  throw new Error('Fixture condition timed out')
}
async function fixture(healthMisses = 2) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cancel-recovery-'))
  const hostStore = new HostStore(join(root, 'hosts.json'))
  const host = hostStore.create({ alias: 'fixture', host: '127.0.0.1', port: 22, user: 'fixture', auth: { kind: 'password', password: 'fixture-only' } })
  let dispatched = 0, releaseCancel: ((redirect?: boolean) => void) | undefined
  let healthDelay = 0, healthReads = 0, terminalFrames = 0, workspaceWrites = 0, upgradeDelay = 0
  let releaseBaseline: (() => void) | undefined
  let rootEncoding: string | undefined
  const asset = Buffer.from('window.generatedFixture = true;\n'.repeat(1000)), compressed = gzipSync(asset)
  const remote = httpServer((req, res) => {
    if (req.url?.startsWith('/?token=')) { res.writeHead(303, { 'Set-Cookie': 'fixture=only; Path=/' }); res.end(); return }
    if (req.url === '/fixture.js') {
      const zipped = req.headers['accept-encoding']?.includes('gzip')
      const bytes = zipped ? compressed : asset
      res.writeHead(200, { 'content-type': 'text/javascript', 'content-length': bytes.length, ...(zipped ? { 'content-encoding': 'gzip' } : {}) }); res.end(bytes); return
    }
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
    if (req.url === '/api/workspace/create') {
      let raw = ''; req.on('data', chunk => { raw += chunk }); req.once('end', () => {
        workspaceWrites++
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ rpcId: JSON.parse(raw).rpcId, result: { ok: true, value: { workspace: { workspaceId: 'fixture-project', path: root, title: 'fixture', sessionIds: [] } } } }))
      }); return
    }
    if (req.url === '/') { healthReads++; rootEncoding = req.headers['accept-encoding'] }
    const send = () => { if (!res.destroyed) { res.writeHead(200); res.end('ready') } }
    if (healthDelay && req.url === '/') setTimeout(send, healthDelay).unref(); else send()
  })
  const wss = new WebSocketServer({ noServer: true })
  remote.on('upgrade', (req, socket, head) => {
    const accept = () => { if (!socket.destroyed) wss.handleUpgrade(req, socket, head, ws => {
      ws.on('message', data => {
        let frame: any; try { frame = JSON.parse(data.toString()) } catch { /* plain terminal fixture */ }
        if (frame?.endpoint === 'workspace/follow') {
          releaseBaseline = () => ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'baseline', value: { items: [], archivedSessionIds: [] } } }))
          return
        }
        terminalFrames++; ws.send(data)
      })
    }) }
    socket.on('error', () => socket.destroy())
    if (upgradeDelay) setTimeout(accept, upgradeDelay).unref(); else accept()
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
  let replacements = 0
  const carrier = { broken: false }
  const stop = vi.fn((id: string) => { tunnels.get(id)?.stop(); return true })
  const engine = { find: (alias: string) => hostStore.find(alias), stopWorkspaceTunnel: stop, pool: new Map([['fixture', carrier]]),
    startWorkspaceTunnel: vi.fn(async () => { const id = ++replacements === 1 ? 'new' : `new-${replacements}`; carrier.broken = false; return { id, localPort: (await tunnel(id)).port } }) }
  const gateway = new RemoteGateway(first.port, { protocol: 1, pid: process.pid, port: remotePort, url: `http://127.0.0.1:${remotePort}/?token=fixture-only`,
    root, directory: root, userHome: root, version: '0.2.1-rc.2' }, 'fixture', 'http://127.0.0.1:1/', 'fixture', 'fixture')
  await gateway.start()
  const manager = new RemoteWorkspaces(engine as unknown as SshEngine, { root: join(root, 'manager'), installer: '', bootstrap: '', returnUrl: () => 'http://127.0.0.1:1/' })
  clearInterval((manager as any).recovery)
  const hostId = (manager as any).hostId('fixture')
  const runtime = { gateway, hostId, alias: 'fixture', updatedAt: host.updatedAt, tunnelId: 'old', retryAt: 0, failures: 0, healthMisses }
  ;(manager as any).runtimes.set(hostId, runtime)
  const login = await fetch(gateway.launch(), { redirect: 'manual' })
  const cookie = login.headers.getSetCookie().map(x => x.split(';')[0]).join('; ')
  cleanups.push(async () => {
    releaseCancel?.(); manager.dispose(); gateway.dispose(); for (const value of tunnels.values()) value.stop()
    for (const ws of wss.clients) ws.terminate()
    await new Promise<void>(resolve => wss.close(() => resolve()))
    remote.closeAllConnections(); await new Promise<void>(resolve => remote.close(() => resolve())); rmSync(root, { recursive: true, force: true })
  })
  const requestCancel = (signal?: AbortSignal) => fetch(gateway.origin + '/api/session/cancel', { method: 'POST', headers: { Cookie: cookie, Origin: gateway.origin, 'content-type': 'application/json' }, body: '{}', signal, redirect: 'manual' })
  const stream = () => {
    const ws = new WebSocket(gateway.origin.replace('http:', 'ws:') + '/api/remote.mux', { headers: { Cookie: cookie, Origin: gateway.origin } })
    ws.on('error', () => {}); return ws
  }
  return { gateway, manager, engine, first, stop, requestCancel, stream, runtime, carrier, root,
    cookie, asset, compressed, get rootEncoding() { return rootEncoding },
    setHealthDelay(ms: number) { healthDelay = ms }, setUpgradeDelay(ms: number) { upgradeDelay = ms },
    get healthReads() { return healthReads }, get terminalFrames() { return terminalFrames }, get workspaceWrites() { return workspaceWrites },
    get baselineWaiting() { return !!releaseBaseline }, releaseBaseline: () => releaseBaseline?.(),
    get dispatched() { return dispatched }, release: (redirect = false) => releaseCancel?.(redirect) }
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

async function echo(ws: WebSocket, text: string) {
  const reply = once(ws, 'message'); ws.send(text)
  expect((await reply)[0].toString()).toBe(text)
}
async function confirmedRepair(f: Awaited<ReturnType<typeof fixture>>) {
  f.runtime.healthMisses = 2
  vi.spyOn(f.gateway, 'healthy').mockResolvedValueOnce(false)
  await f.manager.repairConnections()
  vi.mocked(f.gateway.healthy).mockRestore()
}

it('coalesces slow health reads and keeps the same terminal across a 2.3 second response delay', async () => {
  const f = await fixture(0), ws = f.stream(); await once(ws, 'open')
  await echo(ws, 'before-latency')
  f.setHealthDelay(2300)
  const reads = [f.gateway.healthy(), f.gateway.healthy(), f.gateway.healthy()]
  await f.manager.repairConnections()
  expect(await Promise.all(reads)).toEqual([true, true, true])
  expect(f.healthReads).toBe(1)
  expect(f.engine.startWorkspaceTunnel).not.toHaveBeenCalled()
  expect(f.stop).not.toHaveBeenCalled()
  await echo(ws, 'after-latency')
  expect(f.terminalFrames).toBe(2)
  ws.close(); await once(ws, 'close')
}, 10000)

it('requires three consecutive failed rounds and resets suspicion after a success', async () => {
  const f = await fixture(0)
  const health = vi.spyOn(f.gateway, 'healthy').mockResolvedValue(false)
  await f.manager.repairConnections(); await f.manager.repairConnections()
  expect(f.engine.startWorkspaceTunnel).not.toHaveBeenCalled()
  health.mockResolvedValueOnce(true)
  await f.manager.repairConnections()
  await f.manager.repairConnections(); await f.manager.repairConnections()
  expect(f.engine.startWorkspaceTunnel).not.toHaveBeenCalled()
  await f.manager.repairConnections()
  expect(f.engine.startWorkspaceTunnel).toHaveBeenCalledTimes(1)
})

it('preserves upgraded terminal traffic through a confirmed carrier replacement and releases it only on close', async () => {
  const f = await fixture(0), ws = f.stream(); await once(ws, 'open')
  await echo(ws, 'original-terminal')
  await confirmedRepair(f)
  expect(f.gateway.localPort).not.toBe(f.first.port)
  expect(f.stop).not.toHaveBeenCalledWith('old')
  await echo(ws, 'same-terminal-after-repair')
  expect(f.terminalFrames).toBe(2)
  expect(await f.gateway.healthy()).toBe(true)
  ws.close(); await once(ws, 'close'); await wait(() => f.stop.mock.calls.some(([id]) => id === 'old'))
})

it('retains a pending WebSocket upgrade while changing the carrier', async () => {
  const f = await fixture(0); f.setUpgradeDelay(250)
  const ws = f.stream(), opening = once(ws, 'open')
  await wait(() => (f.gateway as any).streams.get(f.first.port)?.size === 1)
  await confirmedRepair(f)
  expect(f.stop).not.toHaveBeenCalledWith('old')
  await opening; await echo(ws, 'late-upgrade-same-terminal')
  ws.close(); await once(ws, 'close'); await wait(() => f.stop.mock.calls.some(([id]) => id === 'old'))
})

it('also retains an internal catalog observer until its original snapshot completes', async () => {
  const f = await fixture(0), reading = f.gateway.workspaceSnapshot()
  await wait(() => f.baselineWaiting)
  await confirmedRepair(f)
  expect(f.stop).not.toHaveBeenCalledWith('old')
  f.releaseBaseline()
  await expect(reading).resolves.toEqual({ items: [], archivedSessionIds: [] })
  await wait(() => f.stop.mock.calls.some(([id]) => id === 'old'))
})

it('repairs a proven broken SSH carrier immediately without replaying terminal input', async () => {
  const f = await fixture(0), ws = f.stream(); await once(ws, 'open'); await echo(ws, 'one-dispatch')
  const closed = once(ws, 'close'); f.carrier.broken = true; f.first.stop()
  await closed; await f.manager.repairConnections()
  expect(f.engine.startWorkspaceTunnel).toHaveBeenCalledTimes(1)
  expect(f.terminalFrames).toBe(1)
  expect(await f.gateway.healthy()).toBe(true)
})

it('bounds retained stream carriers without evicting live terminals and frees capacity on close', async () => {
  const f = await fixture(0), a = f.stream(); await once(a, 'open')
  await confirmedRepair(f)
  const b = f.stream(); await once(b, 'open'); await confirmedRepair(f)
  const c = f.stream(); await once(c, 'open'); await confirmedRepair(f)
  expect(f.engine.startWorkspaceTunnel).toHaveBeenCalledTimes(2)
  await echo(a, 'old-a'); await echo(b, 'old-b'); await echo(c, 'current-c')
  a.close(); await once(a, 'close'); await wait(() => f.stop.mock.calls.some(([id]) => id === 'old'))
  await confirmedRepair(f)
  expect(f.engine.startWorkspaceTunnel).toHaveBeenCalledTimes(3)
  await echo(b, 'still-b'); await echo(c, 'still-c')
  b.close(); c.close(); await Promise.all([once(b, 'close'), once(c, 'close')])
})

it('releases current and retained carriers on plugin shutdown without reconnecting', async () => {
  const f = await fixture(0), ws = f.stream(); await once(ws, 'open'); await confirmedRepair(f)
  const closed = once(ws, 'close'); f.manager.dispose(); await closed
  expect(f.stop).toHaveBeenCalledWith('old'); expect(f.stop).toHaveBeenCalledWith('new')
  await f.manager.repairConnections()
  expect(f.engine.startWorkspaceTunnel).toHaveBeenCalledTimes(1)
})

it('does not start a replacement when shutdown happens during the health read', async () => {
  const f = await fixture(2)
  let finish!: (healthy: boolean) => void
  vi.spyOn(f.gateway, 'healthy').mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const repairing = f.manager.repairConnections()
  await wait(() => !!finish)
  f.manager.dispose(); finish(false); await repairing
  expect(f.engine.startWorkspaceTunnel).not.toHaveBeenCalled()
})

it('does not probe or destroy a retained runtime when explicitly adding a project', async () => {
  const f = await fixture(0), ws = f.stream(); await once(ws, 'open')
  const health = vi.spyOn(f.gateway, 'healthy').mockResolvedValue(false)
  const operation = f.manager.connect('fixture', f.root)
  await wait(() => ['ready', 'failed'].includes(f.manager.operation(operation.id)!.phase))
  expect(f.manager.operation(operation.id)?.phase).toBe('ready')
  expect(f.workspaceWrites).toBe(1); expect(health).not.toHaveBeenCalled()
  expect(f.stop).not.toHaveBeenCalled(); await echo(ws, 'project-switch-preserved')
  ws.close(); await once(ws, 'close')
})

it('preserves compressed asset bytes and headers while requesting identity HTML for rewriting', async () => {
  const f = await fixture(0)
  const raw = (path: string) => new Promise<{ headers: Record<string, unknown>; bytes: Buffer }>((resolve, reject) => {
    httpGet(f.gateway.origin + path, { headers: { Cookie: f.cookie, Origin: f.gateway.origin, 'Accept-Encoding': 'gzip' } }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject)
      res.on('end', () => resolve({ headers: res.headers, bytes: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
  const asset = await raw('/fixture.js')
  expect(asset.headers['content-encoding']).toBe('gzip')
  expect(Number(asset.headers['content-length'])).toBe(f.compressed.length)
  expect(asset.bytes).toEqual(f.compressed)
  await raw('/')
  expect(f.rootEncoding).toBeUndefined()
})
