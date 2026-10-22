import {afterEach,expect,it} from 'vitest'
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {RemoteHistoryCache,historyKey} from '../src/remote/history-cache.ts'
import {SegmentedHistoryCache} from '../src/remote/history-store.ts'

const roots:string[]=[], stores:SegmentedHistoryCache[]=[]
afterEach(async()=>{for(const s of stores.splice(0))await s.close();for(const r of roots.splice(0))await rm(r,{recursive:true,force:true})})
const moduleUrl=pathToFileURL(join(import.meta.dirname,'../src/remote/history-store.ts')).href
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'dsh-history-crash-'));roots.push(root)
  const key=historyKey('generated-host','project','session')
  const meta={key,hostId:'generated-host',workspaceId:'project',sessionId:'session',alias:'fixture',remotePath:'/generated',title:'Generated',savedAt:1,remoteUpdatedAt:1,cursor:2,complete:true}
  const records=Array.from({length:3},(_,seq)=>({type:'event' as const,event:{seq,type:'user/message',data:{content:'Generated '+seq}}}))
  const old=new RemoteHistoryCache(root);await old.list();await old.save(meta,records,old.token())
  return{root,key,meta,records}
}
function crash(root:string,key:string,phase:string){
  const source=`import {SegmentedHistoryCache} from ${JSON.stringify(moduleUrl)};
const cache=new SegmentedHistoryCache(${JSON.stringify(root)});await cache.list();
const atomic=cache.atomic.bind(cache);cache.atomic=async(...args)=>{
 if(args[0].endsWith('/manifest.json')&&['before','append-before'].includes(${JSON.stringify(phase)}))process.kill(process.pid,'SIGKILL');
 const result=await atomic(...args);
 if(args[0].endsWith('/manifest.json')&&${JSON.stringify(phase)}==='after')process.kill(process.pid,'SIGKILL');
 if(args[0].endsWith('/control.json')&&${JSON.stringify(phase)}==='clear')process.kill(process.pid,'SIGKILL');
 return result;
};
if(${JSON.stringify(phase)}==='clear')await cache.clear([${JSON.stringify(key)}]);
else if(${JSON.stringify(phase)}==='append-before'){
 const meta=await cache.meta(${JSON.stringify(key)});await cache.append({...meta,cursor:meta.cursor+1},[{type:'event',event:{seq:meta.cursor+1,type:'user/message',data:{content:'Abandoned increment'}}}],cache.token(${JSON.stringify(key)}));
}else await cache.prepare(${JSON.stringify(key)},cache.token(${JSON.stringify(key)}));`
  const result=spawnSync(process.execPath,['--experimental-transform-types','--input-type=module','-e',source],{encoding:'utf8',timeout:10000})
  expect(result.signal,result.stderr).toBe('SIGKILL')
}
for(const phase of ['before','after'])it('recovers actual process death '+phase+' the migration manifest commit without losing legacy records',async()=>{
  const f=await fixture();crash(f.root,f.key,phase)
  const store=new SegmentedHistoryCache(f.root);stores.push(store);await store.list()
  expect((await store.read(f.key))!.records).toEqual(f.records)
  await store.prepare(f.key,store.token(f.key))
  expect(await readdir(f.root)).not.toContain(f.key+'.json')
  expect((await store.read(f.key))!.records).toEqual(f.records)
  expect(await readFile(join(f.root,'v2',f.key,'legacy.v1.json'),'utf8')).toContain('Generated 2')
})
it('keeps a durable clear barrier after process death before physical legacy deletion, including after explicit reopen',async()=>{
  const f=await fixture();crash(f.root,f.key,'clear')
  expect(await readdir(f.root)).toContain(f.key+'.json')
  const store=new SegmentedHistoryCache(f.root);stores.push(store);await store.list()
  expect(await store.read(f.key)).toBeUndefined();expect((await store.list()).entries).toEqual([])
  await store.resume(f.key)
  expect(await readdir(f.root)).not.toContain(f.key+'.json');expect(await store.read(f.key)).toBeUndefined()
})

it('ignores an uncommitted descriptor tail after real process death and preserves the committed prefix on the next append',async()=>{
  const f=await fixture(), first=new SegmentedHistoryCache(f.root);await first.list();await first.prepare(f.key,first.token(f.key));await first.close()
  const path=join(f.root,'v2',f.key,'manifest.json'), before=JSON.parse(await readFile(path,'utf8'))
  const index=join(f.root,'v2',f.key,before.generation,'segments.jsonl'), prefix=await readFile(index)
  crash(f.root,f.key,'append-before')
  expect((await readFile(index)).length).toBeGreaterThan(before.indexBytes)
  const next=new SegmentedHistoryCache(f.root);stores.push(next);await next.list()
  expect((await next.read(f.key))!.records).toEqual(f.records)
  const record={type:'event' as const,event:{seq:3,type:'user/message',data:{content:'Confirmed increment'}}}
  await next.append({...f.meta,cursor:3},[record],next.token(f.key))
  expect((await readFile(index)).subarray(0,before.indexBytes)).toEqual(prefix)
  expect((await next.read(f.key))!.records).toEqual([...f.records,record])
})
