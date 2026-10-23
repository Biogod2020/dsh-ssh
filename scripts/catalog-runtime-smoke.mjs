/** Exercise the compiled gateway's large-catalog branch in an installed DSH.
 * Generated Session objects use public storage/title APIs, not Agent loops. */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { TestSshd } from '../tests/helpers/sshd.ts'
import { DEFAULT_KNOWN_HOSTS } from '../src/engine/known-hosts.ts'
import { verifyViewInspection, verifyDraftInspection, verifyUnaryInspection } from './verify-view-inspection.mjs'

const [dsh, archive, output] = process.argv.slice(2), run = promisify(execFile)
assert([dsh, archive, output].every(value => value && isAbsolute(value)), 'Supply absolute DSH, package and new report paths')
const version = (await run(dsh, ['--version'])).stdout.trim(); assert(['0.2.0-rc.2','0.2.1-alpha.4','0.2.1-rc.2'].includes(version), 'Use one of the reviewed runtimes')
const root = await mkdtemp(join(tmpdir(), 'dsh-catalog-archive-')), local = join(root, 'local'), remote = join(root, 'remote')
const remoteRoot = join(remote, '.local/share/dsh-remote'), project = join(remote, 'selected-project'), nonce = randomUUID()
await writeFile(output, JSON.stringify({ passed: false, completed: false, phase: 'starting', modelRequests: 0 }) + '\n', { mode: 0o600, flag: 'wx' })
console.log('Private catalog acceptance diagnostics: ' + root)
const base = { PATH: process.env.PATH, USER: process.env.USER, LOGNAME: process.env.LOGNAME, LANG: 'en_US.UTF-8', SHELL: '/bin/sh',
  DEEPSEEK_API_KEY: 'fixture-only', DEEPSEEK_BASE_URL: 'http://127.0.0.1:9' }
const env = { ...base, HOME: local, DSH_HOME: join(local, '.dsh') }, remoteEnv = { ...base, HOME: remote, DSH_HOME: join(remoteRoot, 'data') }
for (const path of [join(local, '.ssh'), project, join(remote, 'catalog-project'), join(remoteRoot, 'node/bin'), join(remoteRoot, 'releases', version, 'node_modules/.bin')]) await mkdir(path, { recursive: true, mode: 0o700 })
await symlink(process.execPath, join(remoteRoot, 'node/bin/node')); await symlink(dsh, join(remoteRoot, 'releases', version, 'node_modules/.bin/dsh'))
const plugin = join(root, 'seed'); await mkdir(plugin, { mode: 0o700 })
await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: '@fixture/catalog-seed', version: '1.0.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
await writeFile(join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: catalog-seed\n      name: "@fixture/catalog-seed"\n')
await writeFile(join(plugin, 'index.js'), `
export const inject=['webServer','connection','sessions','workspaceController'];
export function apply(ctx){let created=0,followOpens=0;
const controller=ctx.workspaceController,originalFollow=controller.follow;
controller.follow=function(...args){followOpens++;return originalFollow.apply(this,args)};
ctx.effect(()=>()=>{controller.follow=originalFollow});
ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/fixture/catalog-stats',handler:async(req,res)=>{
 const denied=ctx.connection.requestRejection(req);if(denied){res.writeHead(denied);res.end();return}
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({followOpens}));
}}));
ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/fixture/identity',handler:async(req,res)=>{
 const denied=ctx.connection.requestRejection(req);if(denied){res.writeHead(denied);res.end();return}
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({pid:process.pid,home:process.env.DSH_HOME,nonce:${JSON.stringify(nonce)}}));
}}));
ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/fixture/catalog',handler:async(req,res)=>{
 const denied=ctx.connection.requestRejection(req);if(denied){res.writeHead(denied);res.end();return}
 let text='';for await(const chunk of req)text+=chunk;const {offset}=JSON.parse(text);
 if(offset!==created||created>=4000)throw Error('Generated catalog batch changed');
 const titles=ctx.get('sessionTitle');if(!titles)throw Error('Public title API missing');
 for(let n=0;n<400;n++){
  const id='catalog-fixture-'+created,session=ctx.sessions.create(id,{meta:{cwd:process.env.HOME+'/catalog-project'}});
  titles.rename(session,('Generated catalog '+created+' '+ 'x'.repeat(480)));created++;
 }
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({created}));
}}));}
`)
await run(dsh, ['plugin', '--profile', 'web', 'add', 'link:' + plugin], { env: remoteEnv, timeout: 60000 })
await run(dsh, ['plugin', '--profile', 'web', 'add', archive, '--ignore-scripts'], { env, timeout: 60000 })
for (const home of [env.DSH_HOME, remoteEnv.DSH_HOME]) await writeFile(join(home, 'profiles/web/cordis.patch.yml'), '- id: product-analytics\n  disabled: true\n- id: desktop-product-telemetry\n  disabled: true\n', { mode: 0o600 })
DEFAULT_KNOWN_HOSTS.splice(0, DEFAULT_KNOWN_HOSTS.length, join(local, '.ssh/known_hosts'))
const sshd = await TestSshd.start({ home: remote, path: process.env.PATH, env: remoteEnv })
const logPath = join(root, 'controller.log'), log = await open(logPath, 'wx', 0o600)
const child = spawn(dsh, ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'], { env, cwd: local, stdio: ['ignore', log.fd, log.fd] }); await log.close()
let childError; child.once('error', error => childError = error)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(read) { for (let n = 0; n < 600; n++) { const value = await read(); if (value) return value; await delay(50) } throw new Error('Generated catalog acceptance timed out') }
async function auth(url) {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) }); await response.body?.cancel(); assert.equal(response.status, 303)
  return { Cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), Origin: url.origin, 'content-type': 'application/json' }
}
let receipt, passed = false, result
try {
  const login = await until(async () => {
    if (childError) throw childError; assert.equal(child.exitCode, null); assert.equal(child.signalCode, null)
    const raw = (await readFile(logPath, 'utf8')).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]
    return raw && new URL(raw)
  }), headers = await auth(login)
  const api = async (path, body, status = 200) => {
    const response = await fetch(login.origin + '/api/dsh-ssh/' + path, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) })
    assert.equal(response.status, status); return response.json()
  }
  await api('hosts', { alias: 'fixture', host: '127.0.0.1', port: sshd.port, user: process.env.USER, auth: { kind: 'key', keyPath: sshd.clientKey } }, 201)
  const preparation = (await api('remote/connect', { alias: 'fixture', remotePath: project }, 202)).operation
  const workspace = await until(async () => { const { operation } = await api('remote/operation?id=' + preparation.id); assert.notEqual(operation.phase, 'failed'); return operation.phase === 'ready' && operation.workspace })
  receipt = JSON.parse(await readFile(join(remoteRoot, 'state/server.json'), 'utf8')); assert.equal(receipt.version, version)
  const { sessionId } = await api('remote/session/create', { id: workspace.id })
  const view = new URL((await api('remote/open', { id: workspace.id, sessionId })).url), remoteHeaders = await auth(view)
  let created = 0, bytes = 0, rows = 0
  const directUrl=new URL(receipt.url),directHeaders=await auth(directUrl)
  const rpc = async (method, args, direct=false) => {
    const rpcId = randomUUID(), response = await fetch((direct?directUrl.origin:view.origin) + '/api/' + method, { method: 'POST', headers: direct?directHeaders:remoteHeaders,
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }), signal: AbortSignal.timeout(30000) })
    assert.equal(response.status, 200); const raw = await response.text(), body = JSON.parse(raw)
    assert.equal(body.rpcId, rpcId); assert.equal(body.result.ok, true); return { raw, value: body.result.value }
  }
  while (bytes <= 1024 * 1024) {
    assert(created < 4000, 'Generated catalog did not reach the large decoder branch')
    const response = await fetch(view.origin + '/api/fixture/catalog', { method: 'POST', headers: remoteHeaders, body: JSON.stringify({ offset: created }), signal: AbortSignal.timeout(30000) })
    assert.equal(response.status, 200); const next = (await response.json()).created; assert.equal(next, created + 400); created = next
    const sample = await rpc('session/list', { _request: {} }); bytes = Buffer.byteLength(sample.raw); rows = sample.value.items.length
  }
  assert(bytes < 8 * 1024 * 1024)
  const title = 'Generated large-catalog acceptance confirmed'
  await rpc('session/rename', { request: { sessionId, title } })
  const selected = await api('remote/sessions?id=' + workspace.id)
  assert.equal(selected.stale, false); assert.equal(selected.sessions.find(row => row.sessionId === sessionId)?.title, title)
  assert(!selected.warning); assert.equal(new Set(selected.sessions.map(row => row.sessionId)).size, selected.sessions.length)
  const embedded=new URL((await api('remote/open',{id:workspace.id,sessionId})).url)
  embedded.searchParams.set('dsh-remote-view','desktop')
  const embeddedHeaders=await auth(embedded)
  const inspectionScript=await fetch(embedded.origin+'/__dsh_remote/navigation-client.js',{headers:embeddedHeaders,signal:AbortSignal.timeout(10000)})
  assert.equal(inspectionScript.status,200)
  const inspectionVerification=verifyViewInspection(await inspectionScript.text(),workspace.workspaceId,sessionId)
  const draftInspectionScript=await fetch(embedded.origin+'/__dsh_remote/draft-client.js',{headers:embeddedHeaders,signal:AbortSignal.timeout(10000)})
  assert.equal(draftInspectionScript.status,200)
  const draftInspectionVerification=await verifyDraftInspection(await draftInspectionScript.text(),workspace.hostId,sessionId)
  const operationScript=await fetch(embedded.origin+'/__dsh_remote/operation-client.js',{headers:embeddedHeaders,signal:AbortSignal.timeout(10000)})
  assert.equal(operationScript.status,200)
  const embeddedPage=await fetch(embedded.origin,{headers:embeddedHeaders,signal:AbortSignal.timeout(10000)})
  assert.equal(embeddedPage.status,200)
  const unaryInspectionVerification=await verifyUnaryInspection(await embeddedPage.text(),await operationScript.text())
  const stats=async()=>{
    const response=await fetch(directUrl.origin+'/api/fixture/catalog-stats',{headers:directHeaders,signal:AbortSignal.timeout(5000)})
    assert.equal(response.status,200);return response.json()
  }
  assert.equal((await stats()).followOpens,1)
  for(let n=0;n<100;n++)assert.equal((await api('remote/sessions?id='+workspace.id)).stale,false)
  const feedWaitStarted=performance.now(),feedWaitWallStarted=Date.now()
  await delay(43000) // Expire aggregation and cross a real 30s ping + 10s pong budget.
  const feedWaitElapsed=performance.now()-feedWaitStarted,feedWaitWallElapsed=Date.now()-feedWaitWallStarted
  assert.equal((await api('remote/sessions?id='+workspace.id)).stale,false)
  // Bypass the local gateway mutation callback: only the official pushed
  // archive/unarchive increments can invalidate this fresh local catalog.
  await rpc('workspace/archiveSession',{request:{sessionId}},true)
  await until(async()=>{const value=await api('remote/sessions?id='+workspace.id);return !value.stale&&!value.sessions.some(row=>row.sessionId===sessionId)})
  await rpc('workspace/unarchiveSession',{request:{sessionId}},true)
  await until(async()=>{const value=await api('remote/sessions?id='+workspace.id);return !value.stale&&value.sessions.some(row=>row.sessionId===sessionId)})
  assert.equal((await stats()).followOpens,1)
  assert.equal(JSON.parse(await readFile(join(remoteRoot, 'state/server.json'), 'utf8')).pid, receipt.pid)
  let remoteSessionActionsVerified = false, localObservationFixtureVerified = false
  if (version === '0.2.1-rc.2') {
    const action = (name, extra={}) => api('remote/session/action', { id:workspace.id, expectedHostId:workspace.hostId, sessionId, action:name, ...extra })
    await action('pin')
    await until(async()=>{const value=await api('remote/sessions?id='+workspace.id);return !value.stale&&value.sessions.find(row=>row.sessionId===sessionId)?.pinned===true})
    await action('unpin')
    await action('rename',{title:'Native row action rename confirmed'})
    await until(async()=>{const value=await api('remote/sessions?id='+workspace.id);const row=value.sessions.find(row=>row.sessionId===sessionId);return !value.stale&&row?.pinned!==true&&row?.title==='Native row action rename confirmed'})
    await action('archive')
    await until(async()=>{const value=await api('remote/sessions?id='+workspace.id);return !value.stale&&!value.sessions.some(row=>row.sessionId===sessionId)&&value.archivedSessions?.some(row=>row.sessionId===sessionId)})
    await action('unarchive')
    await until(async()=>{const value=await api('remote/sessions?id='+workspace.id);return !value.stale&&value.sessions.some(row=>row.sessionId===sessionId)})
    remoteSessionActionsVerified = true
    // Generated ended metadata only: no command failure or automatic view
    // eviction is simulated or counted as verified by this fixture.
    const notice={observationId:randomUUID(),startedAt:Date.now(),endedAt:Date.now(),transport:'http',category:'session',selectedSessionIdAtDispatch:sessionId}
    const saveNotice=async()=>{
      const response=await fetch(embedded.origin+'/__dsh_remote/observations',{method:'PUT',headers:embeddedHeaders,body:JSON.stringify({records:[notice]}),signal:AbortSignal.timeout(10000)})
      assert.equal(response.status,200);return response.json()
    }
    assert.equal((await saveNotice()).receipts[0]?.status,'saved')
    assert((await api('remote/view-observations/hosts')).hosts.some(row=>row.hostId===workspace.hostId))
    const saved=await api('remote/view-observations?hostId='+workspace.hostId)
    assert.equal(saved.entries[0]?.observationId,notice.observationId);assert.equal(saved.entries[0]?.outcome,'unconfirmed')
    await api('remote/view-observations/dismiss',{hostId:workspace.hostId,observationId:notice.observationId})
    assert.equal((await saveNotice()).receipts[0]?.status,'dismissed')
    assert.equal((await api('remote/view-observations?hostId='+workspace.hostId)).entries.length,0)
    localObservationFixtureVerified = true
  }
  result = { passed: true, completed: true, runtime: version, archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'),
    generatedMetadataSessions: created, rawSdkSessionRows: rows, rawSdkResponseBytes: bytes, largeDecodeThresholdBytes: 1024 * 1024,
    ...inspectionVerification, ...draftInspectionVerification, ...unaryInspectionVerification, compiledGatewayCatalogRead: true, freshSelectedCatalog: true, workspaceFeedOpens: 1, repeatedCatalogReads: 101,
    pushedArchiveAndUnarchive: true, remoteSessionActionsVerified, localObservationFixtureVerified,
    automaticViewEvictionVerified:false, clientOperationObserverVerified:false, liveFeedWaitRequestedMilliseconds: 43000,
    liveFeedWaitElapsedMilliseconds: feedWaitElapsed, liveFeedWaitWallMilliseconds: feedWaitWallElapsed,
    harnessSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'), remotePidPreserved: true, modelRequests: 0, nativeDesktopVerified: false }
  passed = true
} finally {
  let cleanupError
  try {
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve, reject) => {
      const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 5000)
      const deadline = setTimeout(() => { clearTimeout(kill); child.unref(); reject(new Error('Generated controller termination unconfirmed')) }, 10000)
      child.once('exit', () => { clearTimeout(kill); clearTimeout(deadline); resolve() }); child.kill('SIGTERM')
    })
    if (!receipt) try { receipt = JSON.parse(await readFile(join(remoteRoot, 'state/server.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (receipt) {
      assert.equal(receipt.root, remoteRoot); const url = new URL(receipt.url)
      assert.equal(url.hostname, '127.0.0.1'); assert.equal(Number(url.port), receipt.port)
      const headers = await auth(url), response = await fetch(url.origin + '/api/fixture/identity', { headers, signal: AbortSignal.timeout(5000) })
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { pid: receipt.pid, home: remoteEnv.DSH_HOME, nonce })
      process.kill(receipt.pid, 'SIGTERM')
      await until(() => { try { process.kill(receipt.pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error } })
    }
  } catch (error) { cleanupError = error; passed = false }
  sshd.stop()
  if (passed) { await writeFile(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(result)) }
  else await writeFile(output, JSON.stringify({ passed: false, completed: false, phase: cleanupError ? 'cleanup-unconfirmed' : 'failed', modelRequests: 0 }) + '\n', { mode: 0o600 })
  if (cleanupError) throw cleanupError
}
