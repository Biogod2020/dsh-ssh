/** Verify the installed bundle's remote filter, compression and disk sync.
 * Generated keys, isolated homes and fake messages; no model API is called. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, open, readFile, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { TestSshd } from '../tests/helpers/sshd.ts'
import { DEFAULT_KNOWN_HOSTS } from '../src/engine/known-hosts.ts'
import { shellQuote } from '../src/remote/transport.ts'

const run = promisify(execFile), dsh = process.argv[2], archive = process.argv[3]
assert(dsh && isAbsolute(dsh) && archive && isAbsolute(archive), 'usage: node --experimental-transform-types scripts/history-delta-smoke.mjs <absolute-dsh> <absolute.tgz> [--outages]')
const outageDurations = process.argv.includes('--outages') ? [0, 3000, 30000, 300000] : [0]
const baseEnv = { PATH: process.env.PATH, USER: process.env.USER, LOGNAME: process.env.LOGNAME, LANG: 'en_US.UTF-8', SHELL: '/bin/sh' }
const root = await mkdtemp(join(tmpdir(), 'dsh-history-archive-'))
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
await writeFile(join(plugin, 'package.json'), JSON.stringify({name:'@fixture/history-seed',version:'1.0.0',type:'module',main:'index.js',dsh:{bundle:{patch:'./cordis.patch.yml'}}}))
await writeFile(join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: history-seed\n      name: "@fixture/history-seed"\n')
await writeFile(join(plugin, 'index.js'), `
export const inject=['webServer','connection','sessions'];
export function apply(ctx){ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/fixture/history',handler:async(req,res)=>{
 const denied=ctx.connection.requestRejection(req);if(denied){res.writeHead(denied);res.end();return}
 let raw='';for await(const bytes of req)raw+=bytes;const {id,count}=JSON.parse(raw);
 if(!Number.isInteger(count)||count<1||count>1200)throw Error('Invalid fixture size');
 const session=ctx.sessions.get(id);if(!session)throw Error('Fixture Session is not attached');
 for(let n=0;n<count;n++)session.append('user/message',{role:'user',source:{kind:'user'},content:[{type:'text',text:'Generated archive history '+n}],requestId:'fixture-'+n},{surfaceOp:'append'});
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({added:count}));
}}));}
`)
const remoteEnv = {...baseEnv, HOME:remote, DSH_HOME:join(remoteRoot,'data'), DEEPSEEK_API_KEY:'fixture-only', DEEPSEEK_BASE_URL:'http://127.0.0.1:9'}
await run(dsh, ['plugin','--profile','web','add','link:'+plugin], { env: remoteEnv, timeout:60000 })
const env = {...baseEnv, HOME:local, DSH_HOME:home, DEEPSEEK_API_KEY:'fixture-only', DEEPSEEK_BASE_URL:'http://127.0.0.1:9'}
await run(dsh, ['plugin','--profile','web','add',archive,'--ignore-scripts'], {env,timeout:60000})
const sshd = await TestSshd.start({home:remote,path:bin+':'+process.env.PATH,env:remoteEnv})
let child, logPath = join(root,'local.log')
const delay = ms => new Promise(resolve => setTimeout(resolve,ms))
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
  if(!stopping || stopping.exitCode!==null)return
  await new Promise(resolve=>{
    const deadline=setTimeout(()=>{if(stopping.exitCode===null)stopping.kill('SIGKILL')},5000)
    stopping.once('exit',()=>{clearTimeout(deadline);resolve()})
    stopping.kill('SIGTERM')
  })
}
async function until(fn) { for(let n=0;n<600;n++){ const value=await fn(); if(value)return value; await delay(50) } throw Error('history acceptance timeout; private diagnostics: '+root) }
try {
  let api = await start()
  await api('hosts',{alias:'fixture',host:'127.0.0.1',port:sshd.port,user:process.env.USER,auth:{kind:'key',keyPath:sshd.clientKey}},201)
  const preparation = (await api('remote/connect',{alias:'fixture',remotePath:project},202)).operation
  const workspace = await until(async()=>{const {operation}=await api('remote/operation?id='+preparation.id);assert.notEqual(operation.phase,'failed',operation.message);return operation.phase==='ready'&&operation.workspace})
  const {sessionId} = await api('remote/session/create',{id:workspace.id})
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
  const remotePid=JSON.parse(await readFile(join(remoteRoot,'state/server.json'),'utf8')).pid
  const rename = await fetch(open.origin+'/api/session/rename',{method:'POST',headers,body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'session/rename',payload:{args:{request:{sessionId,title:'Archive delta'}}}})})
  assert.equal(rename.status,200);assert.equal((await rename.json()).result.ok,true)
  await api('remote/history/sync',{id:workspace.id,sessionId},202)
  const changed=await until(async()=>{const {copy}=await api('remote/history/read?id='+workspace.id+'&sessionId='+sessionId);return copy?.meta.cursor>first.meta.cursor&&copy})
  assert.deepEqual(changed.records.slice(0,first.records.length),first.records)
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
    if (milliseconds!==outageDurations.at(-1)) {
      // A restarted controller has no carrier. Explicitly reattach to the
      // generated existing service; installer discovery/bootstrap must reuse
      // its PID. No message, command, cancel or transfer is retried.
      const reconnect=(await api('remote/connect',{alias:'fixture',remotePath:project,expectedHostId:workspace.hostId},202)).operation
      const reattached=await until(async()=>{const {operation}=await api('remote/operation?id='+reconnect.id);assert.notEqual(operation.phase,'failed',operation.message);return operation.phase==='ready'&&operation.workspace})
      assert.equal(reattached.id,workspace.id)
      assert.equal(JSON.parse(await readFile(join(remoteRoot,'state/server.json'),'utf8')).pid,remotePid)
    }
  }
  await api('remote/history/clear',{keys:[offline.meta.key]})
  assert.equal((await api('remote/history/read?id='+workspace.id+'&sessionId='+sessionId)).copy,undefined)
  assert.equal(JSON.parse(await readFile(join(remoteRoot,'state/server.json'),'utf8')).pid,remotePid)
  const result={passed:true,runtime:(await run(dsh,['--version'])).stdout.trim(),generatedMessages:1100,records:first.records.length,newEvents:changed.meta.cursor-first.meta.cursor,
    installedBundle:true,diskReadAfterRestartWithoutSsh:true,controllerOutages:outages,selectiveClear:true,remotePidPreserved:true,modelRequests:0}
  await writeFile(join(root,'result.json'),JSON.stringify(result,null,2),{mode:0o600})
  if(process.env.DSH_HISTORY_ARCHIVE_REPORT)await writeFile(process.env.DSH_HISTORY_ARCHIVE_REPORT,JSON.stringify(result,null,2),{mode:0o600})
  console.log(JSON.stringify(result));console.log('Private acceptance diagnostics: '+root)
} finally {
  await stop();sshd.stop()
  try {const receipt=JSON.parse(await readFile(join(remoteRoot,'state/server.json'),'utf8'));if(receipt.root===remoteRoot)process.kill(receipt.pid,'SIGTERM')}catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error}
}
