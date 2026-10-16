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
import { compatibleRemoteVersion } from '../src/remote/types.ts'
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
export const inject=['webServer','connection'];
export function apply(ctx){ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/fixture/direct-fs',handler:async(req,res)=>{
 const denied=ctx.connection.requestRejection(req);if(denied){res.writeHead(denied);res.end();return}
 const path=${JSON.stringify(join(project, 'plugin.txt'))};
 if(req.method==='POST')await writeFile(path,'remote-plugin-write');
 res.writeHead(200,{'content-type':'text/plain'});res.end(await readFile(path,'utf8'));
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
  manager.setEnabled(false)
  expect(engine.listTunnels()).toHaveLength(0)
  expect(() => manager.connect('fixture', project)).toThrow('stopped')
  await expect(manager.open(first.id)).rejects.toThrow('stopped')
  expect(() => process.kill(receipt.pid, 0)).not.toThrow()
  manager.setEnabled(true)
  expect((await connected()).id).toBe(first.id)
  const recoveryProof = manager.recoveryProof(first.hostId)
  manager.dispose()
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
