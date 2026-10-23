import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readdir, readFile, writeFile, stat, symlink, chmod, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { ViewReceiptStore, ViewReceiptConflictError } from '../src/remote/view-receipts.ts'

const cleanups:string[]=[]
afterEach(async()=>{vi.restoreAllMocks();for(const path of cleanups.splice(0))await rm(path,{recursive:true,force:true})})
const host='a'.repeat(24),other='b'.repeat(24)
const input=()=>({observationId:randomUUID(),startedAt:100,endedAt:150,transport:'http' as const,category:'session' as const,selectedSessionIdAtDispatch:'same'})
async function fixture(){const parent=await mkdtemp(join(tmpdir(),'dsh-view-receipts-'));cleanups.push(parent);const root=join(parent,'receipts');return{root,store:new ViewReceiptStore(root)}}
const key=(id:string,owner=host)=>createHash('sha256').update(JSON.stringify([owner,id])).digest('hex')
it('persists only ended metadata with private permissions and reads it after restart without remote work',async()=>{
  const f=await fixture(),value=input();expect(await f.store.save(host,value)).toEqual({status:'saved',observationId:value.observationId})
  const restored=await new ViewReceiptStore(f.root).list(host)
  expect(restored.entries).toEqual([{version:1,hostId:host,outcome:'unconfirmed',...value}])
  expect((await stat(join(f.root,host,key(value.observationId)+'.json'))).mode&0o777).toBe(0o600)
  expect((await stat(join(f.root,host))).mode&0o777).toBe(0o700)
  expect((await f.store.list(other)).entries).toEqual([])
  expect(await readdir(f.root)).toEqual([host]) // Listing an absent Host creates no directory.
})
it('supports identical multi-process-style saves but refuses identity collisions without overwriting metadata',async()=>{
  const f=await fixture(),value=input(),second=new ViewReceiptStore(f.root)
  const results=await Promise.all([f.store.save(host,value),second.save(host,value)])
  expect(results.every(result=>result.status==='saved')).toBe(true)
  await expect(second.save(host,{...value,category:'files'})).rejects.toBeInstanceOf(ViewReceiptConflictError)
  expect((await f.store.list(host)).entries[0]?.category).toBe('session')
  expect(second.writeIssue).toBeUndefined()
  await second.save(other,value);expect((await second.list(other)).entries).toHaveLength(1)
})
it('makes dismissal durable so a delayed save cannot recreate a cleared notice',async()=>{
  const f=await fixture(),value=input();await f.store.save(host,value);await f.store.dismiss(host,value.observationId)
  const next=new ViewReceiptStore(f.root);expect(await next.save(host,value)).toMatchObject({status:'dismissed'})
  expect((await next.list(host)).entries).toEqual([])
  const marker=join(f.root,host,key(value.observationId)+'.cleared')
  expect((await stat(marker)).size).toBe(0)
  expect((await readdir(join(f.root,host))).filter(name=>name.endsWith('.json'))).toEqual([])
})
it('blocks late publication across a concurrent clear without retaining the original metadata',async()=>{
  const f=await fixture(),value=input(),clearer=new ViewReceiptStore(f.root)
  const original=(f.store as any).create.bind(f.store)
  let published!:()=>void,proceed!:()=>void
  const linked=new Promise<void>(resolve=>{published=resolve}),continued=new Promise<void>(resolve=>{proceed=resolve})
  vi.spyOn(f.store as any,'create').mockImplementation(async(...args:unknown[])=>{await original(...args);published();await continued})
  const pending=f.store.save(host,value);await linked;await clearer.dismiss(host,value.observationId);proceed()
  expect(await pending).toMatchObject({status:'dismissed'});expect((await clearer.list(host)).entries).toEqual([])
})
it('rejects payloads, URLs, credentials and accessors instead of storing extension fields',async()=>{
  const f=await fixture()
  for(const extra of [{args:{command:'generated-private-command'}},{url:'https://private.invalid/'},{apiKey:'generated-private-key'}, {outcome:'pending'}]){
    await expect(f.store.save(host,{...input(),...extra} as any)).rejects.toThrow('Invalid ended observation')
  }
  const value=input();Object.defineProperty(value,'category',{get:()=>{throw Error('Getter must never run')}})
  await expect(f.store.save(host,value)).rejects.toThrow('Invalid ended observation')
  expect((await f.store.list(host)).entries).toEqual([])
})
it('captures a detached input before asynchronous filesystem work begins',async()=>{
  const f=await fixture(),value=input(),id=value.observationId
  const saved=f.store.save(host,value);value.observationId=randomUUID();value.endedAt=999
  await saved;expect((await f.store.list(host)).entries[0]).toMatchObject({observationId:id,endedAt:150})
})
it('pages deterministically without dropping entries when a page includes a corrupt or cleared file',async()=>{
  const f=await fixture(),values=Array.from({length:23},input)
  for(const value of values)await f.store.save(host,value)
  const sorted=values.map(value=>key(value.observationId)).sort()
  await writeFile(join(f.root,host,sorted[3]+'.json'),'{corrupt',{mode:0o600})
  const received:string[]=[];let after='';let issue:string|undefined
  do{const page=await f.store.list(host,after,5);received.push(...page.entries.map(value=>value.observationId));issue??=page.issue;after=page.next??''}while(after)
  expect(new Set(received).size).toBe(22);expect(issue).toContain('preserved')
  expect(await readFile(join(f.root,host,sorted[3]+'.json'),'utf8')).toBe('{corrupt')
})
it.each(['symlink','public'])('refuses unsafe %s metadata and preserves its source',async kind=>{
  const f=await fixture(),value=input();await f.store.save(host,value)
  const path=join(f.root,host,key(value.observationId)+'.json'),before=await readFile(path)
  if(kind==='symlink'){await rm(path);await writeFile(path+'.original',before,{mode:0o600});await symlink(path+'.original',path)}else await chmod(path,0o644)
  const result=await f.store.list(host);expect(result.entries).toEqual([]);expect(result.issue).toContain('preserved')
  await expect(f.store.save(host,value)).rejects.toThrow();expect((await readFile(path)).equals(before)).toBe(true)
})
it('never acknowledges a published link when directory fsync fails and stops later writes',async()=>{
  const f=await fixture(),value=input(),sync=(f.store as any).sync.bind(f.store)
  vi.spyOn(f.store as any,'sync').mockImplementation(async(path:unknown)=>{if(path===join(f.root,host))throw Error('Generated directory sync failure');await sync(path)})
  await expect(f.store.save(host,value)).rejects.toThrow('sync failure')
  expect(f.store.writeIssue).toContain('durable save')
  await expect(f.store.save(host,input())).rejects.toThrow('needs inspection')
  expect((await new ViewReceiptStore(f.root).list(host)).entries).toHaveLength(1)
})
it('validates an entire detached batch before publishing its first receipt',async()=>{
  const f=await fixture(),a=input(),b=input()
  await expect(f.store.saveMany(host,[a,{...b,args:'private'} as any])).rejects.toThrow('Invalid')
  expect((await f.store.list(host)).entries).toEqual([])
  await expect(f.store.saveMany(host,[a,{...a,category:'files'}])).rejects.toBeInstanceOf(ViewReceiptConflictError)
  expect((await f.store.list(host)).entries).toEqual([])
  const result=f.store.saveMany(host,[a,b]);a.endedAt=800;await result
  expect((await f.store.list(host)).entries.every(row=>row.endedAt===150)).toBe(true)
})
it('waits for accepted writes on close and refuses new writes after shutdown',async()=>{
  const f=await fixture(),value=input(),create=(f.store as any).create.bind(f.store)
  let entered!:()=>void,resume!:()=>void
  const started=new Promise<void>(resolve=>{entered=resolve}),proceed=new Promise<void>(resolve=>{resume=resolve})
  vi.spyOn(f.store as any,'create').mockImplementation(async(...args:unknown[])=>{entered();await proceed;return create(...args)})
  const save=f.store.save(host,value);await started
  let closed=false;const stopping=f.store.close().then(()=>{closed=true});await Promise.resolve();expect(closed).toBe(false)
  await expect(f.store.save(host,input())).rejects.toThrow('closed')
  resume();await save;await stopping;expect((await new ViewReceiptStore(f.root).list(host)).entries).toHaveLength(1)
})
it('pages Host identities after restart without connecting or creating directories for missing Hosts',async()=>{
  const f=await fixture();await f.store.save(other,input());await f.store.save(host,input())
  const first=await f.store.hosts('',1);expect(first).toEqual({items:[host],next:host})
  expect(await new ViewReceiptStore(f.root).hosts(first.next!,1)).toEqual({items:[other]})
})
it('treats EEXIST followed by concurrent removal as dismissed rather than a false identity conflict',async()=>{
  const f=await fixture(),value=input();await f.store.save(host,value)
  const second=new ViewReceiptStore(f.root),read=(second as any).bytes.bind(second)
  let cleared=false
  vi.spyOn(second as any,'bytes').mockImplementation(async(path:unknown,max:unknown)=>{
    if(!cleared&&path===join(f.root,host,key(value.observationId)+'.json')){cleared=true;await f.store.dismiss(host,value.observationId)}
    return read(path,max)
  })
  expect(await second.save(host,value)).toMatchObject({status:'dismissed'})
  expect(second.writeIssue).toBeUndefined();expect((await second.list(host)).entries).toEqual([])
})
it('drains an accepted entire batch when close starts midway through its first record',async()=>{
  const f=await fixture(),values=Array.from({length:10},input),create=(f.store as any).create.bind(f.store)
  let entered!:()=>void,resume!:()=>void,first=true
  const started=new Promise<void>(resolve=>{entered=resolve}),proceed=new Promise<void>(resolve=>{resume=resolve})
  vi.spyOn(f.store as any,'create').mockImplementation(async(...args:unknown[])=>{if(first){first=false;entered();await proceed}return create(...args)})
  const batch=f.store.saveMany(host,values);await started;const closing=f.store.close();resume();await batch;await closing
  expect((await new ViewReceiptStore(f.root).list(host)).entries).toHaveLength(10)
})
it('isolates an unsafe Host directory while retaining readable metadata for other Hosts',async()=>{
  const f=await fixture();await f.store.save(host,input())
  const bad='c'.repeat(24);await mkdir(join(f.root,bad),{mode:0o755})
  const page=await f.store.hosts();expect(page.items).toEqual([host]);expect(page.issue).toContain('preserved')
})
it('does not overwrite a newly saved notice with a late empty availability read',async()=>{
  const f=await fixture();let finish!:(value:{items:string[]})=>void
  vi.spyOn(f.store,'hosts').mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
  const pending=f.store.available();await f.store.save(host,input());finish({items:[]})
  expect(await pending).toBe(true);expect(await f.store.available()).toBe(true)
})
