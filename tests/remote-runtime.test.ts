import { beforeAll, afterAll, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TestSshd } from './helpers/sshd.ts'
import { HostStore } from '../src/store.ts'
import { SshEngine } from '../src/engine.ts'
import { RemoteWorkspaces } from '../src/remote/manager.ts'
import { RemoteActivityStore } from '../src/remote/activity-store.ts'
import { RemoteHistoryCache } from '../src/remote/history-cache.ts'
import { compatibleRemoteVersion } from '../src/remote/types.ts'
import * as transport from '../src/remote/transport.ts'
import { shellQuote } from '../src/remote/transport.ts'

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-remote-runtime-test-')))
const remoteRoot = join(dir, "remote runtime ' quoted"), project = join(dir, 'project')
let sshd: TestSshd, engine: SshEngine, manager: RemoteWorkspaces
const options = {
  installer: readFileSync(new URL('../assets/remote-install.sh', import.meta.url), 'utf8'),
  bootstrap: readFileSync(new URL('../assets/remote-bootstrap.mjs', import.meta.url), 'utf8'),
  root: join(dir, 'local-state'), remoteRoot, returnUrl: () => 'http://127.0.0.1:3080/',
}
beforeAll(async () => {
  const run = promisify(execFile)
  const dsh = process.env.DSH_REMOTE_TEST_DSH ?? (await run('/usr/bin/which', ['dsh'])).stdout.trim()
  const version = (await run(dsh, ['--version'])).stdout.trim()
  if (!dsh.startsWith('/') || !compatibleRemoteVersion(version)) throw new Error('Set DSH_REMOTE_TEST_DSH to an installed, supported DSH binary')
  // Integration verifies real DSH over real SSH. Cold installation has its own
  // acceptance fixture; npm/network latency must not obscure transport failures.
  const installed = { node: process.execPath, dsh, root: remoteRoot, version }
  options.installer = `printf 'DSH_INSTALL:%s\\n' ${shellQuote(JSON.stringify(installed))}\n`
  mkdirSync(project)
  const plugin = join(dir, 'fixture-plugin'); mkdirSync(plugin)
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: '@fixture/remote-fs', version: '1.0.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: remote-fs-fixture\n      name: "@fixture/remote-fs"\n')
  writeFileSync(join(plugin, 'index.js'), `
import { readFile, writeFile } from 'node:fs/promises';
export const inject=['webServer','connection','sessions'];
export function apply(ctx){ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/fixture/direct-fs',handler:async(req,res)=>{
 const denied=ctx.connection.requestRejection(req);if(denied){res.writeHead(denied);res.end();return}
 const path=${JSON.stringify(join(project, 'plugin.txt'))};
 if(req.method==='POST')await writeFile(path,'remote-plugin-write');
 res.writeHead(200,{'content-type':'text/plain'});res.end(await readFile(path,'utf8'));
}}));
ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/fixture/history',handler:async(req,res)=>{
 const denied=ctx.connection.requestRejection(req);if(denied){res.writeHead(denied);res.end();return}
 let raw='';for await(const bytes of req)raw+=bytes;const {id,count}=JSON.parse(raw);
 if(!Number.isInteger(count)||count<1||count>1200)throw Error('Invalid fixture size');
 const session=ctx.sessions.get(id);if(!session)throw Error('Fixture Session is not attached');
 for(let n=0;n<count;n++)session.append('user/message',{role:'user',source:{kind:'user'},content:[{type:'text',text:'Generated history fixture '+n+' '.repeat(64)}],requestId:'fixture-'+n},{surfaceOp:'append'});
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({added:count}));
}}));}
`)
  await run(dsh, ['plugin', '--profile', 'web', 'add', `link:${plugin}`], { env: { ...process.env, DSH_HOME: join(remoteRoot, 'data') }, timeout: 60000 })
  sshd = await TestSshd.start()
  const store = new HostStore(join(dir, 'hosts.json'))
  store.create({ alias: 'fixture', host: '127.0.0.1', port: sshd.port, user: process.env.USER!, auth: { kind: 'key', keyPath: sshd.clientKey } })
  engine = new SshEngine(store); manager = new RemoteWorkspaces(engine, options)
}, 75000)
afterAll(() => {
  manager?.dispose(); engine?.dispose(); sshd?.stop()
  const path = join(remoteRoot, 'state/server.json')
  if (existsSync(path)) {
    const receipt = JSON.parse(readFileSync(path, 'utf8'))
    if (receipt.root === remoteRoot && Number.isInteger(receipt.pid)) { try { process.kill(receipt.pid, 'SIGTERM') } catch {} }
  }
  // Retain private diagnostics on failure; never dump the launch token into a test report.
  if (process.env.DSH_REMOTE_TEST_CLEANUP === '1') rmSync(dir, { recursive: true, force: true })
})
async function ready(op: ReturnType<RemoteWorkspaces['connect']>) {
  for (let i = 0; i < 400; i++) {
    const state = manager.operation(op.id)!
    if (state.phase === 'failed') throw new Error(`${state.message}; private diagnostics: ${dir}`)
    if (state.phase === 'ready') return state.workspace!
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('Remote setup exceeded the test deadline')
}
async function connected() { return ready(manager.connect('fixture', project)) }
it('starts a full DSH through real SSH, routes authenticated RPC, and reconnects without restarting its daemon', async () => {
  const preparing = manager.connect('fixture', project)
  expect(preparing.remotePath).toBe(project)
  expect(manager.activity()).toEqual([preparing])
  expect(() => manager.dismiss(preparing.id)).toThrow('completed failure')
  expect(await manager.status()).toEqual([{ hostId: preparing.hostId, phase: 'checking' }])
  const first = await ready(preparing)
  expect(manager.activity()).toEqual([])
  expect(first.remotePath).toBe(project)
  expect(first).not.toHaveProperty('localPath')
  expect(await manager.status()).toEqual([{ hostId: first.hostId, phase: 'ready' }])
  const receipt = JSON.parse(readFileSync(join(remoteRoot, 'state/server.json'), 'utf8'))
  const { url } = await manager.open(first.id)
  const login = new URL(url)
  expect((await fetch(login.origin)).status).toBe(401)
  const exchange = await fetch(url, { redirect: 'manual' })
  expect(exchange.status).toBe(303)
  const cookie = exchange.headers.getSetCookie().map(x => x.split(';')[0]).join('; ')
  expect((await fetch(url, { redirect: 'manual' })).status).toBe(401)
  const html = await (await fetch(login.origin, { headers: { Cookie: cookie } })).text()
  expect(html).toContain('dsh-remote-host')
  expect(html).toContain('dsh.sessions.current')
  expect(html).not.toContain(new URL(receipt.url).searchParams.get('token'))
  const embedded = new URL((await manager.open(first.id)).url)
  embedded.searchParams.set('dsh-remote-view', 'desktop')
  const embeddedExchange = await fetch(embedded, { redirect: 'manual' })
  expect(embeddedExchange.status).toBe(303)
  expect(embeddedExchange.headers.get('location')).toBe('/')
  expect(embeddedExchange.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict')
  const embeddedCookie = embeddedExchange.headers.getSetCookie().map(x => x.split(';')[0]).join('; ')
  expect(await (await fetch(embedded.origin, { headers: { Cookie: embeddedCookie } })).text()).toContain('data-desktop="true"')
  expect(html).not.toContain('data-desktop="true"')
  expect((await fetch(embedded.origin + '/?dsh-remote-view=desktop')).status).toBe(401)
  const authHeaders = { Cookie: cookie, Origin: login.origin, 'Content-Type': 'application/json' }
  const pluginWrite = await fetch(login.origin + '/api/fixture/direct-fs', { method: 'POST', headers: authHeaders })
  expect(pluginWrite.status).toBe(200)
  expect(await pluginWrite.text()).toBe('remote-plugin-write')
  expect(readFileSync(join(project, 'plugin.txt'), 'utf8')).toBe('remote-plugin-write')
  expect(existsSync(join(options.root, 'plugin.txt'))).toBe(false)
  async function rpc(method: string, args: object, extra = {}) {
    const rpcId = randomUUID()
    const response = await fetch(login.origin + '/api/' + method, { method: 'POST', headers: authHeaders, body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args, ...extra } }) })
    expect(response.status).toBe(200)
    const body = await response.json(); expect(body.result.ok, body.result.error?.message).toBe(true); return body.result.value
  }
  const { sessionId } = await rpc('session/create', { request: { workspaceId: first.workspaceId } })
  await rpc('session/rename', { request: { sessionId, title: 'Unified sidebar fixture' } })
  const catalog = await manager.sessions(first.id)
  expect(catalog.stale).toBe(false)
  expect(catalog.sessions).toContainEqual(expect.objectContaining({ sessionId, title: 'Unified sidebar fixture' }))
  const added = await manager.createSession(first.id)
  expect(added.sessionId).not.toBe(sessionId)
  expect((await manager.sessions(first.id)).sessions.some(x => x.sessionId === added.sessionId)).toBe(true)
  const terminal = await rpc('terminal/create', { agentId: sessionId, request: { id: 'remote-smoke-terminal', cols: 80, rows: 24 } })
  expect(terminal.cwd).toBe(project)
  expect(terminal.state).toBe('running')
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(login.origin.replace('http:', 'ws:') + '/api/remote.mux', { headers: authHeaders, handshakeTimeout: 5000 })
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error('Remote stream did not deliver its initial state')) }, 8000)
    ws.once('open', () => ws.send(JSON.stringify({ type: 'open', streamId: 'fixture-events', endpoint: '$events', payload: { args: {} } })))
    ws.once('message', bytes => {
      clearTimeout(timeout)
      try { const frame = JSON.parse(bytes.toString()); expect(frame.streamId).toBe('fixture-events'); expect(JSON.stringify(frame)).toContain('ready'); ws.close(); resolve() } catch (error) { ws.terminate(); reject(error) }
    })
    ws.once('error', error => { clearTimeout(timeout); reject(error) })
  })
  const forbidden = await fetch(login.origin + '/api/workspace/create', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://untrusted.invalid' } })
  expect(forbidden.status).toBe(401)
  engine.dropAlias('fixture')
  await manager.repairConnections()
  expect((await fetch(login.origin, { headers: { Cookie: cookie } })).status).toBe(200)
  expect(readFileSync(join(project, 'plugin.txt'), 'utf8')).toBe('remote-plugin-write')
  expect(JSON.parse(readFileSync(join(remoteRoot, 'state/server.json'), 'utf8')).pid).toBe(receipt.pid)
  const attachmentId = randomUUID(), terminalId = 'remote-smoke-terminal'
  // DSH's root version does not pin every runtime dependency. Negotiate only
  // the read-only attachment; never probe or repeat a terminal write.
  async function attach(endpoint: 'terminal/attach' | 'terminal/follow') {
    const stream = new WebSocket(login.origin.replace('http:', 'ws:') + '/api/remote.mux', { headers: authHeaders, handshakeTimeout: 5000 })
    await new Promise<void>((resolve, reject) => {
      const fail = (error: unknown) => { clearTimeout(timer); stream.terminate(); reject(error) }
      const timer = setTimeout(() => fail(new Error('Terminal attachment did not open')), 8000)
      stream.once('error', fail)
      stream.once('open', () => stream.send(JSON.stringify({ type: 'open', streamId: 'terminal-continuity', endpoint,
        payload: { args: { agentId: sessionId, id: terminalId, ...(endpoint === 'terminal/follow' ? { attachmentId } : {}) } } })))
      stream.once('message', bytes => {
        clearTimeout(timer)
        try { const frame = JSON.parse(bytes.toString()); if (frame.type === 'error') throw new Error(frame.error?.message ?? 'Terminal attachment failed'); expect(frame.value?.type).toBe('snapshot'); resolve() } catch (error) { fail(error) }
      })
    })
    return stream
  }
  let duplex = true, terminalStream: WebSocket
  try { terminalStream = await attach('terminal/attach') }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes('terminal/attach: no active Remote method exports this endpoint')) throw error
    duplex = false
    terminalStream = await attach('terminal/follow')
  }
  const originalShell = join(project, 'original-shell.txt'), repairedShell = join(project, 'repaired-shell.txt')
  const onceMarker = join(project, 'terminal-dispatched-once.txt')
  const beforeRepair = `printf '%s\\n' "$$" > ${shellQuote(originalShell)}\n`
  if (duplex) terminalStream.send(JSON.stringify({ type: 'item', streamId: 'terminal-continuity', value: { type: 'write', sequence: 1, data: beforeRepair } }))
  else await rpc('terminal/write', { agentId: sessionId, id: terminalId, attachmentId, data: beforeRepair })
  for (let n = 0; n < 160 && !existsSync(originalShell); n++) await new Promise(resolve => setTimeout(resolve, 25))
  expect(existsSync(originalShell)).toBe(true)
  const runtime = (manager as any).runtimes.get(first.hostId), previousTunnel = runtime.tunnelId
  runtime.healthMisses = 2 // Force a confirmed HTTP-health repair while SSH and the PTY remain healthy.
  const health = vi.spyOn(runtime.gateway, 'healthy').mockResolvedValueOnce(false)
  try { await manager.repairConnections() } finally { health.mockRestore() }
  expect(runtime.tunnelId).not.toBe(previousTunnel)
  expect(engine.tunnels.has(previousTunnel)).toBe(true)
  expect(terminalStream.readyState).toBe(WebSocket.OPEN)
  const started = join(project, 'detached-started.txt'), completed = join(project, 'detached-completed.txt')
  const data = `printf '%s\\n' "$$" > ${shellQuote(repairedShell)}; printf once >> ${shellQuote(onceMarker)}; printf started > ${shellQuote(started)}; sleep 1; printf completed > ${shellQuote(completed)}\n`
  if (duplex) terminalStream.send(JSON.stringify({ type: 'item', streamId: 'terminal-continuity', value: { type: 'write', sequence: 2, data } }))
  else await rpc('terminal/write', { agentId: sessionId, id: terminalId, attachmentId, data })
  for (let n = 0; n < 80 && !existsSync(started); n++) await new Promise(resolve => setTimeout(resolve, 25))
  expect(existsSync(started)).toBe(true); expect(existsSync(completed)).toBe(false)
  expect(readFileSync(repairedShell, 'utf8')).toBe(readFileSync(originalShell, 'utf8'))
  expect(readFileSync(onceMarker, 'utf8')).toBe('once')
  manager.setEnabled(false)
  engine.dropAlias('fixture')
  for (let n = 0; n < 160 && (!existsSync(completed) || readFileSync(completed, 'utf8') !== 'completed'); n++) await new Promise(resolve => setTimeout(resolve, 25))
  expect(readFileSync(completed, 'utf8')).toBe('completed')
  terminalStream.close()
  expect(engine.listTunnels()).toHaveLength(0)
  expect(() => manager.connect('fixture', project)).toThrow('stopped')
  await expect(manager.open(first.id)).rejects.toThrow('stopped')
  expect(() => process.kill(receipt.pid, 0)).not.toThrow()
  manager.setEnabled(true)
  expect((await connected()).id).toBe(first.id)
  const recoveryProof = manager.recoveryProof(first.hostId)
  manager.dispose()
  const disconnectedCatalog = await manager.sessions(first.id)
  expect(disconnectedCatalog.stale).toBe(true)
  expect(disconnectedCatalog.sessions.some(x => x.sessionId === sessionId)).toBe(true)
  expect(() => process.kill(receipt.pid, 0)).not.toThrow()
  manager = new RemoteWorkspaces(engine, options)
  expect(manager.list()).toEqual([first])
  expect(manager.operation(preparing.id)).toMatchObject({ phase: 'ready', workspace: first })
  expect(manager.history().every(x => x.phase === 'ready')).toBe(true)
  expect(engine.listTunnels()).toHaveLength(0)
  expect(manager.recoveryProof(first.hostId)).toBe(recoveryProof)
  expect(() => manager.recover(first.hostId, '0'.repeat(64))).toThrow('Unknown remote recovery link')
  const reopened = await ready(manager.recover(first.hostId, recoveryProof))
  expect(reopened.id).toBe(first.id)
  const recovered = await manager.open(first.id, sessionId)
  const recoveredLogin = await fetch(recovered.url, { redirect: 'manual' })
  expect(recoveredLogin.status).toBe(303)
  const recoveredCookie = recoveredLogin.headers.getSetCookie().map(x => x.split(';')[0]).join('; ')
  const recoveredHtml = await (await fetch(new URL(recovered.url).origin, { headers: { Cookie: recoveredCookie } })).text()
  expect(recoveredHtml).toContain(sessionId)
  expect(recoveredHtml).toContain('dsh-remote-recover')
  expect(JSON.parse(readFileSync(join(remoteRoot, 'state/server.json'), 'utf8')).pid).toBe(receipt.pid)
  const bad = manager.connect('fixture', join(dir, 'missing-folder'))
  await expect(ready(bad)).rejects.toThrow('cannot create a Workspace')
  expect(manager.activity().find(x => x.id === bad.id)?.phase).toBe('failed')
  if (['0.2.0-rc.2', '0.2.1-alpha.4'].includes(receipt.version)) expect(manager.operation(bad.id)?.errorCode).toBe('workspace/invalid-path')
  manager.dismiss(bad.id)
  expect(manager.activity().some(x => x.id === bad.id)).toBe(false)
  expect(manager.operation(bad.id)?.phase).toBe('failed')
  const failedReceipt = manager.operation(bad.id)
  manager.dispose(); manager = new RemoteWorkspaces(engine, options)
  expect(manager.operation(bad.id)).toEqual(failedReceipt)
  expect(manager.history().find(x => x.id === bad.id)?.dismissed).toBe(true)
  expect(manager.activity()).toEqual([])
  expect(engine.listTunnels()).toHaveLength(0)
  expect(JSON.parse(readFileSync(join(remoteRoot, 'state/server.json'), 'utf8')).pid).toBe(receipt.pid)
}, 120000)

it('saves real remote history as restartable disk prefixes and transfers only new events over SSH', async () => {
  const workspace = await connected(), runtime = (manager as any).runtimes.get(workspace.hostId)
  const pid = runtime.gateway.receipt.pid, { sessionId } = await manager.createSession(workspace.id)
  const opened = new URL((await manager.open(workspace.id, sessionId)).url)
  const exchange = await fetch(opened, { redirect: 'manual' })
  const cookie = exchange.headers.getSetCookie().map(x => x.split(';')[0]).join('; ')
  const copies = (manager as any).historyCache
  await vi.waitFor(async () => expect((await copies.status()).syncing).toHaveLength(0), { timeout: 10000 })
  const seed = await fetch(opened.origin + '/api/fixture/history', { method: 'POST',
    headers: { Cookie: cookie, Origin: opened.origin, 'content-type': 'application/json' }, body: JSON.stringify({ id: sessionId, count: 1100 }) })
  expect(seed.status).toBe(200)
  const reads: Array<{ after: number; count: number; bytes: number }> = []
  let wireBytes = 0
  const dispatch = transport.remoteScript
  const wire = vi.spyOn(transport, 'remoteScript').mockImplementation((engine, alias, command, source, onLine, ...options) =>
    dispatch(engine, alias, command, source, line => {
      if (line.startsWith('DSH_HISTORY')) wireBytes += Buffer.byteLength(line) + 1
      onLine(line)
    }, ...options))
  const source = copies.source
  copies.source = async (...args: any[]) => {
    const result = await source(...args), original = result.delta
    result.delta = async (after: number, cut?: number) => {
      const value = await original(after, cut)
      reads.push({ after, count: value.records.length, bytes: Buffer.byteLength(JSON.stringify(value)) }); return value
    }
    return result
  }
  await copies.sync(workspace, sessionId)
  const saved = (await manager.cachedHistory(workspace.id, sessionId))!
  expect(saved, JSON.stringify((await copies.status()).failures)).toBeDefined()
  expect(saved.meta.complete).toBe(true)
  expect(saved.records.filter(x => x.event.type === 'user/message')).toHaveLength(1100)
  expect(reads.every(x => x.count <= 500)).toBe(true)
  expect(reads.reduce((n, x) => n + x.count, 0)).toBeGreaterThanOrEqual(1100)
  const fullWireBytes = wireBytes, fullJsonBytes = reads.reduce((n, x) => n + x.bytes, 0)
  expect(fullWireBytes).toBeLessThan(fullJsonBytes / 2)
  const firstCursor = saved.meta.cursor
  wireBytes = 0; reads.length = 0; await copies.sync(workspace, sessionId)
  expect(reads).toEqual([{ after: firstCursor, count: 0, bytes: expect.any(Number) }])
  const unchangedWireBytes = wireBytes; expect(unchangedWireBytes).toBeLessThan(256)
  // Rename appends an event without a new user message/list activity timestamp.
  await runtime.gateway.rpc('session/rename', { request: { sessionId, title: 'Incremental fixture' } })
  wireBytes = 0; reads.length = 0; await copies.sync(workspace, sessionId)
  const changed = (await manager.cachedHistory(workspace.id, sessionId))!
  expect(changed.meta.cursor).toBeGreaterThan(firstCursor)
  expect(reads.reduce((n, x) => n + x.count, 0)).toBe(changed.meta.cursor - firstCursor)
  expect(changed.records.slice(0, saved.records.length)).toEqual(saved.records)
  const deltaWireBytes = wireBytes
  wire.mockRestore()
  if (process.env.DSH_HISTORY_REPORT) writeFileSync(process.env.DSH_HISTORY_REPORT, JSON.stringify({
    runtime: runtime.gateway.receipt.version, generatedMessages: 1100, fullWireBytes, fullJsonBytes, unchangedRecords: 0, unchangedWireBytes,
    deltaRecords: changed.meta.cursor - firstCursor, deltaWireBytes, note: 'gzip/base64 history payload only; SSH framing and outgoing helper source excluded',
  }, null, 2), {mode: 0o600})
  const beforeRestart = JSON.parse(JSON.stringify(changed))
  manager.dispose(); engine.dropAlias('fixture')
  const offline = new RemoteHistoryCache(join(options.root, 'history'))
  expect((await offline.read(changed.meta.key))?.records).toEqual(beforeRestart.records)
  expect(engine.pool.size).toBe(0)
  manager = new RemoteWorkspaces(engine, options)
  const reconnected = await connected(), restarted = (manager as any).historyCache
  await restarted.sync(reconnected, sessionId)
  expect((await manager.cachedHistory(workspace.id, sessionId))?.records).toEqual(beforeRestart.records)
  expect((manager as any).runtimes.get(workspace.hostId).gateway.receipt.pid).toBe(pid)
}, 120000)

it('retains dispatched preparation after a controller stop without replaying installation or starting DSH', async () => {
  const root = join(dir, 'interrupted-state'), marker = join(dir, 'interrupted-once'), startup = join(dir, 'interrupted-startup')
  const isolated = { ...options, root,
    installer: `printf once >> ${shellQuote(marker)}\nprintf 'DSH_PROGRESS:installing-dsh\\n'\nsleep 1\n${options.installer}`,
    bootstrap: `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(startup)}, 'unexpected');\n${options.bootstrap}`,
  }
  const stopped = new RemoteWorkspaces(engine, isolated)
  const operation = stopped.connect('fixture', project)
  for (let i = 0; i < 200 && !existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 25))
  expect(existsSync(marker)).toBe(true)
  stopped.dispose()
  const restarted = new RemoteWorkspaces(engine, isolated)
  try {
    const retained = restarted.operation(operation.id)!
    expect(retained).toMatchObject({ phase: 'failed', errorCode: 'ssh/setup-interrupted' })
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(readFileSync(marker, 'utf8')).toBe('once')
    expect(existsSync(startup)).toBe(false)
    expect(restarted.operation(operation.id)).toEqual(retained)
    expect(stopped.operation(operation.id)).toEqual(retained)
  } finally { restarted.dispose() }
}, 10000)

it('retains the persistence failure code after dispatch and ignores late installer output without startup or replay', async () => {
  const root = join(dir, 'failed-write-state'), marker = join(dir, 'failed-write-once'), startup = join(dir, 'failed-write-startup')
  const isolated = { ...options, root,
    installer: `printf once >> ${shellQuote(marker)}\nprintf 'DSH_PROGRESS:installing-dsh\\n'\nsleep 1\n${options.installer}`,
    bootstrap: `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(startup)}, 'unexpected');\n${options.bootstrap}`,
  }
  const owned = new RemoteWorkspaces(engine, isolated), save = RemoteActivityStore.prototype.save
  let writes = 0
  const spy = vi.spyOn(RemoteActivityStore.prototype, 'save').mockImplementation(function (this: RemoteActivityStore, entries) {
    if (++writes > 1) throw new Error('fixture full disk')
    return save.call(this, entries)
  })
  let id = ''
  try {
    id = owned.connect('fixture', project).id
    await vi.waitFor(() => expect(owned.operation(id)).toMatchObject({ phase: 'failed', errorCode: 'ssh/activity-unavailable' }))
    expect(owned.activityWarning()).toContain('may still be running')
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(owned.operation(id)?.errorCode).toBe('ssh/activity-unavailable')
    expect(readFileSync(marker, 'utf8')).toBe('once')
    expect(existsSync(startup)).toBe(false)
    expect(new RemoteActivityStore(root).load()[0]?.operation.phase).toBe('checking')
  } finally { spy.mockRestore(); owned.dispose() }
  const restarted = new RemoteWorkspaces(engine, isolated)
  try { expect(restarted.operation(id)).toMatchObject({ phase: 'failed', errorCode: 'ssh/setup-interrupted' }) }
  finally { restarted.dispose() }
}, 10000)

it.each([false, true])('freezes the reviewed host during installation, including a lost connection (%s), without startup or replay', async dropConnection => {
  const marker = join(dir, `installer-started-${dropConnection}`), startup = join(dir, `wrong-startup-${dropConnection}`)
  const owned = new RemoteWorkspaces(engine, { ...options, root: join(dir, `ownership-state-${dropConnection}`),
    installer: `printf started >> ${shellQuote(marker)}\nsleep 1\n${options.installer}`,
    bootstrap: `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(startup)}, 'unexpected');\n${options.bootstrap}`,
  })
  try {
    const operation = owned.connect('fixture', project)
    for (let i = 0; i < 200 && !existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 25))
    expect(existsSync(marker)).toBe(true)
    engine.store.update('fixture', { description: 'changed while installing' })
    if (dropConnection) engine.dropAlias('fixture')
    for (let i = 0; i < 200 && owned.operation(operation.id)?.phase !== 'failed'; i++) await new Promise(resolve => setTimeout(resolve, 25))
    expect(owned.operation(operation.id)).toMatchObject({ phase: 'failed', errorCode: 'ssh/host-changed' })
    expect(owned.operation(operation.id)?.message).toContain('may still be running')
    expect(readFileSync(marker, 'utf8')).toBe('started')
    expect(existsSync(startup)).toBe(false)
    expect(owned.list()).toEqual([])
  } finally { owned.dispose() }
}, 15000)
