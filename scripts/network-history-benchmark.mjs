/** Real SSH and DSH, generated history, private disposable homes. Measures
 * controller/store operations, not a native renderer or model performance. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir, platform, arch } from 'node:os'
import { join, resolve, isAbsolute, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createHash, randomBytes } from 'node:crypto'
import { TestSshd } from '../tests/helpers/sshd.ts'
import { ShapedTcpLink } from '../tests/helpers/shaped-tcp.ts'
import { DEFAULT_KNOWN_HOSTS } from '../src/engine/known-hosts.ts'
import { SshEngine } from '../src/engine.ts'
import { HostStore } from '../src/store.ts'
import { RemoteWorkspaces } from '../src/remote/manager.ts'
import { shellQuote } from '../src/remote/transport.ts'

const [dsh,modulePath,rttArg,mbitArg,output,samplesArg='100',recoveriesArg='30']=process.argv.slice(2)
assert(dsh&&isAbsolute(dsh)&&modulePath&&output,'usage: network-history-benchmark.mjs ABSOLUTE_DSH CACHE_MODULE RTT_MS MBIT OUTPUT_JSON [SAMPLES=100] [RECOVERIES=30]')
const rtt=Number(rttArg),mbit=Number(mbitArg),samples=Number(samplesArg),recoveries=Number(recoveriesArg)
assert(Number.isFinite(rtt)&&rtt>=0&&Number.isFinite(mbit)&&mbit>0)
assert(Number.isInteger(samples)&&samples>=1&&samples<=200&&Number.isInteger(recoveries)&&recoveries>=1&&recoveries<=100)
let io={read:0,written:0,writes:0,metadata:0},events=0,historyBodyBytes=0
for(const name of ['lstat','stat','readdir','opendir']){
  const original=fs[name];fs[name]=async function(...args){io.metadata++;return original.apply(this,args)}
}
const originalOpen=fs.open,originalRead=fs.readFile
fs.open=async function(...args){
  const f=await originalOpen.apply(this,args),write=f.writeFile.bind(f),read=f.readFile.bind(f),range=f.read.bind(f),stat=f.stat.bind(f)
  f.stat=async(...args)=>{io.metadata++;return stat(...args)}
  let full=false
  f.writeFile=async(data,...options)=>{io.written+=Buffer.byteLength(data);io.writes++;return write(data,...options)}
  f.readFile=async(...options)=>{full=true;try{const data=await read(...options);io.read+=Buffer.byteLength(data);return data}finally{full=false}}
  f.read=async(...options)=>{const result=await range(...options);if(!full)io.read+=result.bytesRead;return result}
  return f
}
fs.readFile=async function(...args){const data=await originalRead.apply(this,args);io.read+=Buffer.byteLength(data);return data}
syncBuiltinESMExports()
const module=await import(pathToFileURL(resolve(modulePath)).href),Cache=module.SegmentedHistoryCache??module.RemoteHistoryCache
assert(Cache,'Supply a supported baseline or candidate cache module')
const run=promisify(execFile),root=await fs.mkdtemp(join(tmpdir(),'dsh-network-history-'))
const local=join(root,'local'),remote=join(root,'remote'),remoteRoot=join(remote,'runtime'),project=join(remote,'project')
await fs.mkdir(join(local,'.ssh'),{recursive:true,mode:0o700});await fs.mkdir(project,{recursive:true,mode:0o700})
DEFAULT_KNOWN_HOSTS.splice(0,DEFAULT_KNOWN_HOSTS.length,join(local,'.ssh/known_hosts'))
const environment={PATH:process.env.PATH,USER:process.env.USER,LOGNAME:process.env.USER,LANG:'en_US.UTF-8',SHELL:'/bin/sh',
  HOME:remote,DSH_HOME:join(remoteRoot,'data'),DEEPSEEK_API_KEY:'fixture-only',DEEPSEEK_BASE_URL:'http://127.0.0.1:9'}
const version=(await run(dsh,['--version'],{env:environment})).stdout.trim()
const plugin=join(root,'seed');await fs.mkdir(plugin,{mode:0o700})
await fs.writeFile(join(plugin,'package.json'),JSON.stringify({name:'@fixture/network-history',version:'1.0.0',type:'module',main:'index.js',dsh:{bundle:{patch:'./cordis.patch.yml'}}}),{mode:0o600})
await fs.writeFile(join(plugin,'cordis.patch.yml'),'- insert:\n    - id: network-history-fixture\n      name: "@fixture/network-history"\n',{mode:0o600})
await fs.writeFile(join(plugin,'index.js'),`
import {randomBytes} from 'node:crypto';
export const inject=['webServer','connection','sessions'];
export function apply(ctx){ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/fixture/network-history',handler:async(req,res)=>{
 const denied=ctx.connection.requestRejection(req);if(denied){res.writeHead(denied);res.end();return}
 let raw='';for await(const chunk of req)raw+=chunk;const {id,count,large}=JSON.parse(raw);
 if(!Number.isInteger(count)||count<1||count>1200||typeof large!=='boolean')throw Error('Invalid generated seed');
 const session=ctx.sessions.get(id);if(!session)throw Error('Generated Session is not attached');
 for(let n=0;n<count;n++)session.append('user/message',{role:'user',source:{kind:'user'},content:[{type:'text',text:large&&n===0?randomBytes(2300000).toString('base64'):'Generated 中英文 network fixture '+n+' '.repeat(256)}],requestId:'fixture-'+Date.now()+'-'+n},{surfaceOp:'append'});
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({added:count}));
}}));}
`,{mode:0o600})
await run(dsh,['plugin','--profile','web','add','link:'+plugin],{env:environment,timeout:60000})
let sshd,link,engine,manager,cache,remotePid
const delay=ms=>new Promise(r=>setTimeout(r,ms))
const summarize=values=>{const ordered=values.toSorted((a,b)=>a-b);return{samples:values.length,p50:ordered[Math.ceil(ordered.length*.5)-1]??null,p95:ordered[Math.ceil(ordered.length*.95)-1]??null,max:ordered.at(-1)??null,total:values.reduce((a,b)=>a+b,0)}}
const failures=[]
const completedPhases={}
async function measure(name,count,fn){
  const fields={milliseconds:[],sshSentBytes:[],sshReceivedBytes:[],historyRecords:[],historyBodyBytes:[],applicationBytesRead:[],applicationBytesWritten:[],writeCalls:[],fileMetadataCalls:[]}
  for(let n=0;n<count;n++){
    io={read:0,written:0,writes:0,metadata:0};events=0;historyBodyBytes=0
    const before=link.snapshot(),start=performance.now()
    try{await fn(n)}catch(error){failures.push({phase:name,sample:n,errorClass:error?.name??'Error'});throw error}
    const after=link.snapshot()
    for(const [key,value]of Object.entries({milliseconds:performance.now()-start,sshSentBytes:after.sent-before.sent,sshReceivedBytes:after.received-before.received,
      historyRecords:events,historyBodyBytes,applicationBytesRead:io.read,applicationBytesWritten:io.written,writeCalls:io.writes,fileMetadataCalls:io.metadata}))fields[key].push(value)
  }
  const result=Object.fromEntries(Object.entries(fields).map(([key,values])=>[key,summarize(values)]))
  completedPhases[name]=result;return result
}
async function dataFiles(directory){
  const result=new Map()
  for(const name of await fs.readdir(directory,{recursive:true}))if(/^(?:[a-f0-9]{64}|[a-f0-9-]{36})\.json$/.test(basename(name))){
    const path=join(directory,name),stat=await fs.stat(path,{bigint:true})
    result.set(path,{hash:createHash('sha256').update(await fs.readFile(path)).digest('hex'),mtime:String(stat.mtimeNs),inode:String(stat.ino)})
  }
  return result
}
function rewrites(before,after){return[...before].filter(([path,value])=>JSON.stringify(value)!==JSON.stringify(after.get(path))).length}
try{
  sshd=await TestSshd.start({home:remote,path:process.env.PATH,env:environment})
  link=await ShapedTcpLink.start(sshd.port,rtt,mbit)
  // A dedicated hosted-runner parent may install kernel loss on this one TCP
  // flow before the first SSH handshake. This is never enabled by a bare env
  // flag; IPC is required and the parent records/cleans its owned qdisc.
  if(process.send){
    assert.equal(rtt,0);assert.equal(mbit,1000)
    await new Promise((accept,reject)=>{
      const timeout=setTimeout(()=>{process.off('message',ready);reject(new Error('Kernel network setup did not complete'))},30000)
      const ready=message=>{if(message?.type!=='ssh-link-ready')return;clearTimeout(timeout);process.off('message',ready);message.ok?accept():reject(new Error('Kernel network setup failed'))}
      process.on('message',ready);process.send({type:'ssh-link-port',port:link.port})
    })
    process.disconnect()
  }
  const pins=await fs.readFile(DEFAULT_KNOWN_HOSTS[0],'utf8'),pin=pins.split('\n').find(row=>row.startsWith('[127.0.0.1]:'+sshd.port+' '))
  assert(pin);await fs.appendFile(DEFAULT_KNOWN_HOSTS[0],pin.replace('[127.0.0.1]:'+sshd.port,'[127.0.0.1]:'+link.port)+'\n',{mode:0o600})
  const hosts=new HostStore(join(local,'hosts.json'))
  hosts.create({alias:'fixture',host:'127.0.0.1',port:link.port,user:process.env.USER,auth:{kind:'key',keyPath:sshd.clientKey}})
  engine=new SshEngine(hosts)
  const installed={node:process.execPath,dsh,root:remoteRoot,version}
  manager=new RemoteWorkspaces(engine,{root:join(local,'manager'),remoteRoot,returnUrl:()=>'http://127.0.0.1:9/',
    bootstrap:await fs.readFile(new URL('../assets/remote-bootstrap.mjs',import.meta.url),'utf8'),installer:`printf 'DSH_INSTALL:%s\\n' ${shellQuote(JSON.stringify(installed))}\n`})
  clearInterval(manager.recovery)
  // The measured service alone owns history sync in this disposable fixture.
  manager.syncHistory=()=>{}
  const operation=manager.connect('fixture',project)
  let workspace
  for(let n=0;n<800;n++){
    const state=manager.operation(operation.id);assert.notEqual(state.phase,'failed','Generated remote setup failed; inspect private fixture diagnostics')
    if(state.phase==='ready'){workspace=state.workspace;break}await delay(50)
  }
  assert(workspace,'Generated remote setup did not settle')
  const {sessionId}=await manager.createSession(workspace.id),opened=await manager.open(workspace.id,sessionId)
  const launch=new URL(opened.url),auth=await fetch(launch,{redirect:'manual'})
  assert.equal(auth.status,303)
  const headers={Cookie:auth.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '),Origin:launch.origin,'content-type':'application/json'}
  const seed=async(count,large=false)=>{const response=await fetch(launch.origin+'/api/fixture/network-history',{method:'POST',headers,body:JSON.stringify({id:sessionId,count,large}),signal:AbortSignal.timeout(30000)});await response.body?.cancel();assert.equal(response.status,200)}
  await seed(1100,true)
  remotePid=JSON.parse(await fs.readFile(join(remoteRoot,'state/server.json'),'utf8')).pid
  const runtime=manager.runtimes.get(workspace.hostId),historyRoot=join(local,'measured-history')
  assert(runtime)
  cache=new Cache(historyRoot);await cache.list()
  const key=module.historyKey(workspace.hostId,workspace.workspaceId,sessionId)
  // Borrow the real controller's source, catalog checks and scheduler. Only
  // swap the disposable cache and observe decoded record counts. This also
  // counts controller catalog traffic instead of a simplified delta-only fake.
  const service=manager.historyCache
  await service.cache.close?.();service.cache=cache
  const source=service.source.bind(service)
  service.source=async(...args)=>{
    const value=await source(...args),read=value.delta.bind(value)
    return{...value,delta:async(...range)=>{const delta=await read(...range);events+=delta.records.length;if(delta.records.length)historyBodyBytes+=Buffer.byteLength(JSON.stringify(delta.records));return delta}}
  }
  const sync=async()=>{await service.sync(workspace,sessionId);assert.deepEqual((await service.status()).failures,{})}
  const firstCopy=await measure('initialCopy',1,sync),initial=await cache.meta(key),originalFiles=await dataFiles(historyRoot)
  assert(initial?.complete&&initial.records>=1100)
  const localWindow=await measure('localWindow',samples,async()=>{const copy=cache.window?await cache.window(key,undefined,100):await cache.read(key);assert(copy?.records.length)})
  const unchanged=await measure('unchanged',samples,sync)
  const unchangedRewrites=rewrites(originalFiles,await dataFiles(historyRoot));assert.equal(unchangedRewrites,0)
  assert.equal(unchanged.historyRecords.total,0);assert.equal(unchanged.historyBodyBytes.total,0);assert.equal(unchanged.applicationBytesWritten.total,0)
  // Seed outside each measurement. These are new fixture writes, never retries.
  const incrementRows=[]
  for(let n=0;n<30;n++){await seed(1);incrementRows.push(await measure('increment',1,sync))}
  const increment=Object.fromEntries(Object.keys(incrementRows[0]).map(field=>[field,summarize(incrementRows.map(row=>row[field].total))]))
  const appendRewrites=rewrites(originalFiles,await dataFiles(historyRoot))
  if(cache.append)assert.equal(appendRewrites,0)
  const recovery=await measure('recovery',recoveries,async()=>{
    link.disconnect()
    for(let n=0;n<100;n++){if(!engine.pool.get('fixture')||engine.pool.get('fixture').broken)break;await delay(5)}
    await manager.repairConnections();assert(await runtime.gateway.healthy())
    const catalog=await runtime.gateway.workspaceSnapshot();assert(catalog.items.some(row=>row.workspaceId===workspace.workspaceId))
  })
  const receipt=JSON.parse(await fs.readFile(join(remoteRoot,'state/server.json'),'utf8'));assert.equal(receipt.pid,remotePid)
  const final=await cache.read(key);assert(final.meta.complete);assert.equal(final.records.filter(row=>row.event.type==='user/message').length,1130)
  const report={schema:1,scope:'SSH controller and local store; no native renderer, model request or packet loss emulation',store:Cache.name,runtime:version,node:process.version,platform:platform(),arch:arch(),
    conditions:{injectedRttMs:rtt,mbitPerSecondPerDirection:mbit,tcpPayloadBytesIncludeSshEncryption:true,excludeIpTcpHeaders:true,packetLossPercent:0},
    samplesSufficient:samples>=100&&recoveries>=30,initialRecords:initial.records,firstCopy,localWindow,unchanged,increment,recovery,
    unchangedOldDataFilesRewritten:unchangedRewrites,appendOldDataFilesRewritten:appendRewrites,sshTotals:link.snapshot(),remotePidPreserved:true,failures}
  await fs.writeFile(resolve(output),JSON.stringify(report,null,2)+'\n',{mode:0o600})
  console.log(JSON.stringify({passed:true,store:Cache.name,rttMs:rtt,mbit,samples,recoveries,historyRecordsUnchanged:unchanged.historyRecords.total,appendOldDataFilesRewritten:appendRewrites,recoveryP95Ms:recovery.milliseconds.p95,remotePidPreserved:true}))
}catch(error){
  await fs.writeFile(resolve(output),JSON.stringify({schema:1,complete:false,store:Cache.name,conditions:{injectedRttMs:rtt,mbitPerSecondPerDirection:mbit,packetLossPercent:0},
    completedPhases,failures,errorClass:error?.name??'Error',sshTotals:link?.snapshot()},null,2)+'\n',{mode:0o600})
  throw error
}finally{
  await cache?.close?.();await manager?.dispose();engine?.dispose();await link?.close();sshd?.stop()
  if(remotePid)try{const receipt=JSON.parse(await fs.readFile(join(remoteRoot,'state/server.json'),'utf8'));if(receipt.root===remoteRoot&&receipt.pid===remotePid)process.kill(remotePid,'SIGTERM')}catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error}
  console.error('Private generated fixture diagnostics: '+root)
}
