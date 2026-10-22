/** Hosted disposable Linux runner only. Match exactly the benchmark's SSH
 * loopback port; all other DSH HTTP, sshd and runner traffic stays unshaped.
 * Never use this helper on a user's machine or a self-hosted runner. */
import assert from 'node:assert/strict'
import { fork, execFileSync } from 'node:child_process'
import { readFile, writeFile, lstat } from 'node:fs/promises'
import { resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(process.platform,'linux','Kernel fixture requires Linux')
assert.equal(process.env.GITHUB_ACTIONS,'true','Only a disposable GitHub-hosted runner is allowed')
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted','Self-hosted runners are not allowed')
const [dsh,modulePath,output,samples='100',recoveries='30']=process.argv.slice(2)
assert(dsh&&isAbsolute(dsh)&&modulePath&&output,'usage: kernel-loss-history-benchmark.mjs ABSOLUTE_DSH CACHE_MODULE OUTPUT_JSON [SAMPLES=100] [RECOVERIES=30]')
try{await lstat(resolve(output));throw new Error('Refusing to replace an existing measurement report')}
catch(error){if(error.code!=='ENOENT')throw error}
const command=(program,args)=>execFileSync(program,args,{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']})
const tc=(...args)=>command('sudo',['-n','tc',...args])
const rules=(...args)=>command('sudo',['-n','iptables','-w','5',...args])
const features=()=>command('ethtool',['--show-features','lo'])
const qdiscs=()=>JSON.parse(tc('-j','-s','qdisc','show','dev','lo'))
const before=qdiscs()
assert(before.length===1&&before[0].kind==='noqueue','Refusing to replace an existing loopback queue')
const offloadBefore=features(),offloadKeys={tso:'tcp-segmentation-offload',gso:'generic-segmentation-offload',gro:'generic-receive-offload'}
const offload=Object.fromEntries(Object.entries(offloadKeys).map(([short,key])=>{
  const value=offloadBefore.match(new RegExp('^'+key+': (on|off)(.*)$','m'))
  assert(value,'Missing loopback offload capability: '+key)
  assert(!value[2].includes('[fixed]')||value[1]==='off','Cannot disable fixed loopback offload')
  return[short,{was:value[1],fixed:value[2].includes('[fixed]')}]
}))
let ownedRoot=false,offloadChanged=false,port,child,stats,setupFailure,exitCode
const addedRules=[]
const clean=()=>{
  const errors=[]
  if(ownedRoot)try{tc('qdisc','del','dev','lo','root','handle','7a10:');ownedRoot=false}catch(error){errors.push(error)}
  for(const rule of addedRules.splice(0).reverse())try{rules('-t','mangle','-D','OUTPUT',...rule)}catch(error){errors.push(error)}
  if(offloadChanged){
    for(const short of ['gso','tso','gro']){const value=offload[short];if(!value.fixed)try{command('sudo',['-n','ethtool','--offload','lo',short,value.was])}catch(error){errors.push(error)}}
    offloadChanged=false
  }
  return errors
}
const stop=signal=>{child?.kill(signal);const errors=clean();if(errors.length)console.error('Kernel fixture cleanup failed');process.exitCode=1}
process.once('SIGINT',()=>stop('SIGINT'));process.once('SIGTERM',()=>stop('SIGTERM'))
try{
  child=fork(fileURLToPath(new URL('./network-history-benchmark.mjs',import.meta.url)),[dsh,modulePath,'0','1000',resolve(output),samples,recoveries],{
    execArgv:['--experimental-transform-types'],stdio:['ignore','inherit','inherit','ipc'],env:{...process.env},
  })
  let installed=false
  child.on('message',message=>{
    if(message?.type!=='ssh-link-port'||installed)return
    installed=true
    try{
      port=message.port;assert(Number.isInteger(port)&&port>1024&&port<=65535)
      offloadChanged=true
      for(const [short,value]of Object.entries(offload))if(!value.fixed)command('sudo',['-n','ethtool','--offload','lo',short,'off'])
      const after=features()
      for(const key of Object.values(offloadKeys))assert(new RegExp('^'+key+': off','m').test(after),'Offload remained enabled: '+key)
      // Loopback normally advertises a 64 KiB MSS. Clamp only matching SYNs so
      // independent 1% skb loss also represents ordinary <=1500-byte TCP frames.
      for(const direction of ['--dport','--sport']){
        const rule=['-o','lo','-p','tcp',direction,String(port),'--tcp-flags','SYN,RST','SYN','-j','TCPMSS','--set-mss','1460']
        rules('-t','mangle','-A','OUTPUT',...rule);addedRules.push(rule)
      }
      tc('qdisc','add','dev','lo','root','handle','7a10:','prio','bands','3','priomap',...Array(16).fill('0'));ownedRoot=true
      for(const [classId,handle]of [['7a10:2','7a20:'],['7a10:3','7a30:']])
        tc('qdisc','add','dev','lo','parent',classId,'handle',handle,'netem','limit','10000','delay','100ms','loss','random','1%','rate','2mbit')
      for(const [direction,classId,priority]of [['dport','7a10:2','1'],['sport','7a10:3','2']])
        tc('filter','add','dev','lo','parent','7a10:','protocol','ip','prio',priority,'u32','match','ip','protocol','6','0xff','match','ip',direction,String(port),'0xffff','flowid',classId)
      child.send({type:'ssh-link-ready',ok:true})
    }catch(error){setupFailure=error;child.send({type:'ssh-link-ready',ok:false})}
  })
  exitCode=await new Promise((accept,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>signal?reject(new Error('Benchmark child terminated: '+signal)):accept(code))})
  if(ownedRoot)stats=qdiscs()
}finally{
  const errors=clean()
  if(errors.length)throw new AggregateError(errors,'Kernel fixture cleanup did not finish')
}
let report
try{report=JSON.parse(await readFile(resolve(output),'utf8'))}
catch(error){
  if(!setupFailure&&exitCode===0)throw error
  report={schema:1,complete:false,failures:[{phase:setupFailure?'kernel-setup':'child-benchmark',errorClass:(setupFailure??error).name}],childExitCode:exitCode}
}
const impaired=(stats??[]).filter(row=>['7a20:','7a30:'].includes(row.handle))
report.scope='SSH controller and local store under Linux loopback kernel netem; no native renderer or model request'
report.conditions={injectedRttMs:200,mbitPerSecondPerDirection:2,packetLossPercent:1,lossModel:'independent random per direction',
  injector:'Linux kernel netem on matched loopback SSH flow',tcpMssBytes:1460,segmentationAndReceiveOffloads:false,
  tcpPayloadBytesIncludeSshEncryption:true,excludeIpTcpHeaders:true,excludeRetransmittedBytes:true,
  limitation:'Same-kernel loopback TCP; sender TCP Small Queues and kernel scheduling can differ from a physical WAN. Random loss is configured at 1%, not an exact observed percentage.'}
report.kernel={qdiscs:stats,offloadBefore,offloadAfterRestoration:features(),originalQdiscRestored:qdiscs().every(row=>row.kind==='noqueue'),fixturePort:port,
  offloadScope:'Entire loopback interface on this exclusive disposable runner; other fixture flows have no injected latency/loss but share the disabled offload condition.'}
await writeFile(resolve(output),JSON.stringify(report,null,2)+'\n',{mode:0o600})
if(setupFailure)throw setupFailure
assert.equal(exitCode,0,'Kernel-loss benchmark failed; inspect its incomplete report')
assert.equal(impaired.length,2)
assert(impaired.every(row=>row.packets>0),'Both directions must carry real packets')
assert(impaired.reduce((n,row)=>n+(row.drops??0),0)>0,'No actual kernel drops were observed')
assert(report.kernel.originalQdiscRestored,'Loopback qdisc was not restored')
for(const [short,value]of Object.entries(offload))assert(new RegExp('^'+offloadKeys[short]+': '+value.was,'m').test(report.kernel.offloadAfterRestoration),'Loopback offload was not restored')
console.log(JSON.stringify({passed:true,kernelLossPercent:1,rttMs:200,configuredMbit:2,actualKernelDrops:impaired.reduce((n,row)=>n+(row.drops??0),0),recoveryP95Ms:report.recovery.milliseconds.p95}))
