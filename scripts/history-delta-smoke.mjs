/** Verify the installed bundle's remote filter, compression and disk sync.
 * Generated keys, isolated homes and fake messages; no model API is called. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, open, readFile, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Script, createContext } from 'node:vm'
import { TestSshd } from '../tests/helpers/sshd.ts'
import { DEFAULT_KNOWN_HOSTS } from '../src/engine/known-hosts.ts'
import { shellQuote } from '../src/remote/transport.ts'
import { runHistorySoak, soakDuration } from './history-runtime-soak.mjs'

const run = promisify(execFile), dsh = process.argv[2], archive = process.argv[3]
assert(dsh && isAbsolute(dsh) && archive && isAbsolute(archive), 'usage: node --experimental-transform-types scripts/history-delta-smoke.mjs <absolute-dsh> <absolute.tgz> [--outages] [--soak-seconds=86400]')
const soakSeconds = soakDuration(process.argv.slice(4)), observation = new AbortController()
const interruptSoak = () => observation.abort()
if (soakSeconds) { process.once('SIGTERM', interruptSoak); process.once('SIGINT', interruptSoak) }
const outageDurations = process.argv.includes('--outages') ? [0, 3000, 30000, 300000] : [0]
const baseEnv = { PATH: process.env.PATH, USER: process.env.USER, LOGNAME: process.env.LOGNAME, LANG: 'en_US.UTF-8', SHELL: '/bin/sh' }
const root = await mkdtemp(join(tmpdir(), 'dsh-history-archive-'))
console.log('Private acceptance diagnostics: '+root)
let smokePassed = false, soakStarted = false, soakCompleted = false, finalResult
const initialReport = {passed:false,completed:false,phase:'initializing',soak:{requestedSeconds:soakSeconds,executed:false,completed:false,minimum24HoursVerified:false},nativeEditorVerified:false}
await writeFile(join(root,'result.json'),JSON.stringify(initialReport,null,2),{mode:0o600,flag:'wx'})
if(process.env.DSH_HISTORY_ARCHIVE_REPORT)await writeFile(process.env.DSH_HISTORY_ARCHIVE_REPORT,JSON.stringify(initialReport,null,2),{mode:0o600,flag:'wx'})
const local = join(root, 'local'), remote = join(root, 'remote'), bin = join(root, 'bin'), project = join(remote, 'project')
const remoteRoot = join(remote, '.local/share/dsh-remote'), home = join(local, '.dsh')
await Promise.all([mkdir(join(local, '.ssh'), { recursive: true, mode: 0o700 }), mkdir(project, { recursive: true, mode: 0o700 }), mkdir(bin, { mode: 0o700 })])
DEFAULT_KNOWN_HOSTS.splice(0, DEFAULT_KNOWN_HOSTS.length, join(local, '.ssh/known_hosts'))
await symlink(process.execPath, join(bin, 'node'))
// Login shells may reset PATH. Reuse the managed installer discovery paths,
// so archive acceptance never downloads another DSH/Node release.
const version = (await run(dsh, ['--version'])).stdout.trim()
const installedBin = join(remoteRoot, 'releases', version, 'node_modules/.bin')
await mkdir(installedBin, {recursive:true,mode:0o700})
await mkdir(join(remoteRoot,'node/bin'), {recursive:true,mode:0o700})
await symlink(dsh, join(installedBin,'dsh'))
await symlink(process.execPath, join(remoteRoot,'node/bin/node'))
await writeFile(join(bin, 'dsh'), `#!/bin/sh\nexec ${shellQuote(dsh)} "$@"\n`, { mode: 0o700 })
const plugin = join(root, 'seed'); await mkdir(plugin, { mode: 0o700 })
const fixtureNonce = randomUUID()
await writeFile(join(plugin, 'package.json'), JSON.stringify({name:'@fixture/history-seed',version:'1.0.0',type:'module',main:'index.js',dsh:{bundle:{patch:'./cordis.patch.yml'}}}))
await writeFile(join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: history-seed\n      name: "@fixture/history-seed"\n')
await writeFile(join(plugin, 'index.js'), `
export const inject=['webServer','connection','sessions'];
export function apply(ctx){ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/fixture/history',handler:async(req,res)=>{
 const denied=ctx.connection.requestRejection(req);if(denied){res.writeHead(denied);res.end();return}
 let raw='';for await(const bytes of req)raw+=bytes;const {id,count,batch='initial'}=JSON.parse(raw);
 if(!Number.isInteger(count)||count<1||count>1200)throw Error('Invalid fixture size');
 const session=ctx.sessions.get(id);if(!session)throw Error('Fixture Session is not attached');
 for(let n=0;n<count;n++)session.append('user/message',{role:'user',source:{kind:'user'},content:[{type:'text',text:'Generated archive history '+batch+' '+n}],requestId:'fixture-'+batch+'-'+n},{surfaceOp:'append'});
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({added:count}));
}}));ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/fixture/identity',handler:async(req,res)=>{
 const denied=ctx.connection.requestRejection(req);if(denied){res.writeHead(denied);res.end();return}
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({pid:process.pid,home:process.env.DSH_HOME,nonce:${JSON.stringify(fixtureNonce)}}));
}}));}
`)
const remoteEnv = {...baseEnv, HOME:remote, DSH_HOME:join(remoteRoot,'data'), DEEPSEEK_API_KEY:'fixture-only', DEEPSEEK_BASE_URL:'http://127.0.0.1:9'}
await run(dsh, ['plugin','--profile','web','add','link:'+plugin], { env: remoteEnv, timeout:60000 })
const env = {...baseEnv, HOME:local, DSH_HOME:home, DEEPSEEK_API_KEY:'fixture-only', DEEPSEEK_BASE_URL:'http://127.0.0.1:9'}
await run(dsh, ['plugin','--profile','web','add',archive,'--ignore-scripts'], {env,timeout:60000})
for (const dshHome of [home, remoteEnv.DSH_HOME]) await writeFile(join(dshHome, 'profiles/web/cordis.patch.yml'),
  '- id: product-analytics\n  disabled: true\n- id: desktop-product-telemetry\n  disabled: true\n', { mode: 0o600 })
const sshd = await TestSshd.start({home:remote,path:bin+':'+process.env.PATH,env:remoteEnv})
let child, logPath = join(root,'local.log')
const delay = ms => new Promise(resolve => setTimeout(resolve,ms))
async function confirmGeneratedRemote(receipt) {
  assert.equal(receipt.root,remoteRoot);assert(Number.isSafeInteger(receipt.pid)&&receipt.pid>0)
  const login=new URL(receipt.url)
  assert.equal(login.protocol,'http:');assert.equal(login.hostname,'127.0.0.1');assert.equal(Number(login.port),receipt.port)
  const auth=await fetch(login,{redirect:'manual',signal:AbortSignal.timeout(5000)});await auth.body?.cancel();assert.equal(auth.status,303)
  const headers={Cookie:auth.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '),Origin:login.origin}
  const response=await fetch(login.origin+'/api/fixture/identity',{headers,signal:AbortSignal.timeout(5000)});assert.equal(response.status,200)
  const identity=await response.json()
  assert.deepEqual(identity,{pid:receipt.pid,home:remoteEnv.DSH_HOME,nonce:fixtureNonce},'Generated service identity could not be verified')
}
async function start() {
  const log = await open(logPath, 'w', 0o600)
  child = spawn(dsh, ['web','--host','127.0.0.1','--port','0','--no-open'], {env,stdio:['ignore',log.fd,log.fd]}); await log.close()
  for(let n=0;n<450;n++) {
    assert.equal(child.exitCode,null, 'isolated local DSH exited')
    const raw = (await readFile(logPath,'utf8')).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]
    if(raw) {
      const url = new URL(raw), login = await fetch(url,{redirect:'manual'})
      const headers = {Cookie:login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '),Origin:url.origin,'content-type':'application/json'}
      return async function api(path,body,status=200) {
        const response = await fetch(url.origin+'/api/dsh-ssh/'+path,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)})
        assert.equal(response.status,status,path); return response.json()
      }
    }
    await delay(200)
  }
  throw Error('isolated DSH startup timeout')
}
async function stop() {
  const stopping=child
  if(!stopping || stopping.exitCode!==null || stopping.signalCode!==null)return
  await new Promise((resolve,reject)=>{
    const deadline=setTimeout(()=>{if(stopping.exitCode===null&&stopping.signalCode===null)stopping.kill('SIGKILL')},5000)
    const unconfirmed=setTimeout(()=>{clearTimeout(deadline);stopping.unref();reject(new Error('Generated controller termination could not be confirmed'))},10000)
    stopping.once('exit',()=>{clearTimeout(deadline);clearTimeout(unconfirmed);resolve()})
    stopping.kill('SIGTERM')
  })
}
async function until(fn) { for(let n=0;n<600;n++){ const value=await fn(); if(value)return value; await delay(50) } throw Error('history acceptance timeout; private diagnostics: '+root) }
async function draftView(api,workspace,sessionId){
  const url=new URL((await api('remote/open',{id:workspace.id,sessionId})).url)
  url.searchParams.set('dsh-remote-view','desktop')
  const auth=await fetch(url,{redirect:'manual'})
  assert.equal(auth.status,303)
  const headers={Cookie:auth.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '),Origin:url.origin,'content-type':'application/json'}
  const request=async(body,status=200)=>{
    const response=await fetch(url.origin+'/__dsh_remote/draft?sessionId='+encodeURIComponent(sessionId),{
      headers,...(body?{method:'PUT',body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)})
    assert.equal(response.status,status,'installed local draft route');return response.json()
  }
  const script=await fetch(url.origin+'/__dsh_remote/draft-client.js',{headers,signal:AbortSignal.timeout(5000)})
  assert.equal(script.status,200)
  const modules=[]
  // Execute the exact bundle-served module registration, including the
  // serialized state machine arguments. This catches bundler-only closures;
  // real React/input integration remains a separate native desktop gate.
  new Script(await script.text()).runInContext(createContext({window:{__ModuleLoader__:{load(value){modules.push(value)}}}}),{timeout:1000})
  assert.equal(modules.length,1);assert.equal(modules[0].id,'@jay-local/dsh-ssh-drafts')
  return{origin:url.origin,request,async seedContains(text){
    const response=await fetch(url.origin,{headers,signal:AbortSignal.timeout(10000)})
    assert.equal(response.status,200)
    const html=await response.text();assert(html.includes(text));assert(html.indexOf(text)<html.indexOf('</head>'),'saved draft must precede native editor boot')
  }}
}
try {
  let api = await start()
  await api('hosts',{alias:'fixture',host:'127.0.0.1',port:sshd.port,user:process.env.USER,auth:{kind:'key',keyPath:sshd.clientKey}},201)
  const preparation = (await api('remote/connect',{alias:'fixture',remotePath:project},202)).operation
  const workspace = await until(async()=>{const {operation}=await api('remote/operation?id='+preparation.id);assert.notEqual(operation.phase,'failed',operation.message);return operation.phase==='ready'&&operation.workspace})
  const {sessionId} = await api('remote/session/create',{id:workspace.id})
  let draft=await draftView(api,workspace,sessionId)
  const draftText='Generated archive draft retained across controller origins'
  const draftSnapshot=(await draft.request({text:draftText,expectedRevision:null,operationId:randomUUID(),hadReferences:false,hadAttachments:false})).draft
  await draft.seedContains(draftText)
  const draftOrigins=new Set([draft.origin])
  const open = new URL((await api('remote/open',{id:workspace.id,sessionId})).url)
  const auth = await fetch(open,{redirect:'manual'}), headers={Cookie:auth.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '),Origin:open.origin,'content-type':'application/json'}
  const seeded = await fetch(open.origin+'/api/fixture/history',{method:'POST',headers,body:JSON.stringify({id:sessionId,count:1100})})
  assert.equal(seeded.status,200)
  await until(async()=>!(await api('remote/history')).syncing.length)
  await api('remote/history/sync',{id:workspace.id,sessionId},202)
  const first = await until(async()=>{
    const status=await api('remote/history');assert.deepEqual(status.failures,{})
    const {copy}=await api('remote/history/read?id='+workspace.id+'&sessionId='+sessionId)
    return copy?.meta.complete&&copy.records.filter(x=>x.event.type==='user/message').length===1100&&copy
  })
  const initialReceipt=JSON.parse(await readFile(join(remoteRoot,'state/server.json'),'utf8'))
  assert.equal(initialReceipt.version,version)
  await confirmGeneratedRemote(initialReceipt)
  const remotePid=initialReceipt.pid
  const remoteIdentity=(await run('ps',['-o','lstart=,command=','-p',String(remotePid)],{timeout:5000})).stdout.trim()
  assert(remoteIdentity,'Generated process birth identity is unavailable')
  const rename = await fetch(open.origin+'/api/session/rename',{method:'POST',headers,body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'session/rename',payload:{args:{request:{sessionId,title:'Archive delta'}}}})})
  assert.equal(rename.status,200);assert.equal((await rename.json()).result.ok,true)
  await api('remote/history/sync',{id:workspace.id,sessionId},202)
  let changed=await until(async()=>{const {copy}=await api('remote/history/read?id='+workspace.id+'&sessionId='+sessionId);return copy?.meta.cursor>first.meta.cursor&&copy})
  assert.deepEqual(changed.records.slice(0,first.records.length),first.records)
  if (soakSeconds) {
    const output = process.env.DSH_HISTORY_SOAK_REPORT ?? join(root, 'soak-result.json')
    await writeFile(output+'.state.json', JSON.stringify({root,controllerPid:child.pid,remotePid,generatedFixture:true}), {mode:0o600,flag:'wx'})
    console.log(JSON.stringify({phase:'isolated-soak-started',seconds:soakSeconds,modelRequests:0}))
    soakStarted = true
    changed = await runHistorySoak({ seconds:soakSeconds, archiveSha256:createHash('sha256').update(await readFile(archive)).digest('hex'),
      harnessSha256:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),runtime:version,
      output, initialCopy:changed, signal:observation.signal,
      async append(ordinal) {
        const response=await fetch(open.origin+'/api/fixture/history',{method:'POST',headers,body:JSON.stringify({id:sessionId,count:1,batch:'soak-'+ordinal}),signal:AbortSignal.timeout(15000)})
        assert.equal(response.status,200);await response.body?.cancel()
      },
      async read(minimumCursor) {
        await api('remote/history/sync',{id:workspace.id,sessionId},202)
        return until(async()=>{const {copy}=await api('remote/history/read?id='+workspace.id+'&sessionId='+sessionId);return copy?.meta.cursor>=minimumCursor&&copy})
      },
      async status() {
        assert.equal(child.exitCode,null);assert.equal(child.signalCode,null)
        process.kill(remotePid,0)
        await confirmGeneratedRemote(JSON.parse(await readFile(join(remoteRoot,'state/server.json'),'utf8')))
        assert.equal((await run('ps',['-o','lstart=,command=','-p',String(remotePid)],{timeout:5000})).stdout.trim(),remoteIdentity)
        assert.deepEqual((await draft.request()).draft,draftSnapshot)
        const resources={}
        if(process.platform==='darwin'||process.platform==='linux') {
          for(const [name,pid] of [['controllerRssBytes',child.pid],['remoteRssBytes',remotePid]]) {
            const rss=Number((await run('ps',['-o','rss=','-p',String(pid)],{timeout:5000})).stdout.trim())
            assert(Number.isFinite(rss)&&rss>0);resources[name]=rss*1024
          }
        }
        return {...resources,remotePidPreserved:JSON.parse(await readFile(join(remoteRoot,'state/server.json'),'utf8')).pid===remotePid,localDraftUnchanged:true}
      },
    })
    soakCompleted = true
    console.log(JSON.stringify({phase:'isolated-soak-complete',seconds:soakSeconds,modelRequests:0}))
  }
  const outages=[]
  let offline
  for (const milliseconds of outageDurations) {
    await stop()
    const began=performance.now()
    console.log(JSON.stringify({phase:'controller-offline',requestedMilliseconds:milliseconds}))
    await delay(milliseconds)
    const actualMilliseconds=performance.now()-began
    assert(actualMilliseconds>=milliseconds-10,'Offline timer must not finish early')
    process.kill(remotePid,0)
    assert.equal(JSON.parse(await readFile(join(remoteRoot,'state/server.json'),'utf8')).pid,remotePid)
    api=await start()
    offline=(await api('remote/history/read?id='+workspace.id+'&sessionId='+sessionId)).copy
    assert.deepEqual(offline.records,changed.records)
    assert.deepEqual((await api('connections')).connections,[{alias:'fixture',state:'disconnected'}], 'disk reads after restart must not open SSH')
    outages.push({requestedMilliseconds:milliseconds,actualMilliseconds,offlineDiskRead:true,remotePidPreserved:true})
    {
      // A restarted controller has no carrier. Explicitly reattach to the
      // generated existing service; installer discovery/bootstrap must reuse
      // its PID. No message, command, cancel or transfer is retried.
      const reconnect=(await api('remote/connect',{alias:'fixture',remotePath:project,expectedHostId:workspace.hostId},202)).operation
      const reattached=await until(async()=>{const {operation}=await api('remote/operation?id='+reconnect.id);assert.notEqual(operation.phase,'failed',operation.message);return operation.phase==='ready'&&operation.workspace})
      assert.equal(reattached.id,workspace.id)
      assert.equal(JSON.parse(await readFile(join(remoteRoot,'state/server.json'),'utf8')).pid,remotePid)
      draft=await draftView(api,workspace,sessionId);draftOrigins.add(draft.origin)
      assert.deepEqual((await draft.request()).draft,draftSnapshot)
      await draft.seedContains(draftText)
    }
  }
  const clearedDraft=(await draft.request({text:'',expectedRevision:draftSnapshot.revision,operationId:randomUUID(),hadReferences:false,hadAttachments:false})).draft
  await draft.request({text:draftText,expectedRevision:draftSnapshot.revision,operationId:randomUUID(),hadReferences:false,hadAttachments:false},409)
  assert.deepEqual((await draft.request()).draft,clearedDraft)
  await api('remote/history/clear',{keys:[offline.meta.key]})
  assert.equal((await api('remote/history/read?id='+workspace.id+'&sessionId='+sessionId)).copy,undefined)
  const clearAudit=(await api('remote/history/audit')).storage
  assert(clearAudit&&!clearAudit.byKey[offline.meta.key]&&!clearAudit.incomplete)
  // Model leftover disk data after an already confirmed clear. Real SIGKILL
  // at that commit boundary is covered separately by history-store-crash;
  // this checks the packaged routes and generations, not another kill claim.
  await stop()
  await writeFile(join(home,'remote-workspaces','history',offline.meta.key+'.json'),JSON.stringify(offline),{mode:0o600})
  api=await start()
  assert.equal((await api('remote/history/read?id='+workspace.id+'&sessionId='+sessionId)).copy,undefined)
  assert.deepEqual((await api('connections')).connections,[{alias:'fixture',state:'disconnected'}])
  const leftover=(await api('remote/history/audit')).storage,clearedGeneration=leftover.byKey[offline.meta.key]?.clearedGeneration
  assert(Number.isSafeInteger(clearedGeneration)&&leftover.unreferencedBytes>0&&!leftover.incomplete)
  await api('remote/history/finish-clear',{selection:[{key:offline.meta.key,generation:clearedGeneration}]})
  assert.equal((await api('remote/history/audit')).storage.byKey[offline.meta.key],undefined)
  assert.deepEqual((await api('connections')).connections,[{alias:'fixture',state:'disconnected'}], 'local file maintenance must not connect SSH')
  assert.equal(JSON.parse(await readFile(join(remoteRoot,'state/server.json'),'utf8')).pid,remotePid)
  const result={passed:true,completed:true,soak:{requestedSeconds:soakSeconds,executed:soakStarted,completed:soakCompleted,minimum24HoursVerified:soakCompleted&&soakSeconds>=86400},runtime:(await run(dsh,['--version'])).stdout.trim(),generatedMessages:1100,records:first.records.length,newEvents:changed.meta.cursor-first.meta.cursor,
    installedBundle:true,diskReadAfterRestartWithoutSsh:true,controllerOutages:outages,selectiveClear:true,remotePidPreserved:true,modelRequests:0,
    localDraftAcrossControllerRestart:true,draftGatewayOriginChanged:draftOrigins.size>1,draftClearedWithoutRevival:true,serializedDraftClient:true,nativeEditorVerified:false,
    localFileInventory:true,maintenanceWithoutSsh:true,interruptedClearRecoveryFixture:'previously confirmed clear plus restored generated v1 file'}
  smokePassed = true; finalResult = result
} finally {
  process.removeListener('SIGTERM',interruptSoak);process.removeListener('SIGINT',interruptSoak)
  let cleanupFailure
  try {
    await stop();sshd.stop()
    try {
      const receipt=JSON.parse(await readFile(join(remoteRoot,'state/server.json'),'utf8'))
      process.kill(receipt.pid,0)
      await confirmGeneratedRemote(receipt)
      process.kill(receipt.pid,'SIGTERM')
      let exited=false
      for(let n=0;n<50;n++) {
        try {process.kill(receipt.pid,0)}catch(error){if(error.code==='ESRCH'){exited=true;break}throw error}
        await delay(100)
      }
      assert(exited,'Generated remote termination could not be confirmed')
    }catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error}
  }catch(error){cleanupFailure=error;smokePassed=false}
  if (!smokePassed) {
    const failure={...initialReport,phase:cleanupFailure?'cleanup-unconfirmed':'failed-or-interrupted',interrupted:observation.signal.aborted,
      soak:{requestedSeconds:soakSeconds,executed:soakStarted,completed:soakCompleted,minimum24HoursVerified:soakCompleted&&soakSeconds>=86400}}
    try {await writeFile(join(root,'result.json'),JSON.stringify(failure,null,2),{mode:0o600})}catch{}
    if(process.env.DSH_HISTORY_ARCHIVE_REPORT)try{await writeFile(process.env.DSH_HISTORY_ARCHIVE_REPORT,JSON.stringify(failure,null,2),{mode:0o600})}catch{}
  } else {
    await writeFile(join(root,'result.json'),JSON.stringify(finalResult,null,2),{mode:0o600})
    if(process.env.DSH_HISTORY_ARCHIVE_REPORT)await writeFile(process.env.DSH_HISTORY_ARCHIVE_REPORT,JSON.stringify(finalResult,null,2),{mode:0o600})
    console.log(JSON.stringify(finalResult))
  }
  if(cleanupFailure)throw cleanupFailure
}
