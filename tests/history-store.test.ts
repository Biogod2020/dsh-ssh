import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile, readdir, writeFile, lstat, symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SegmentedHistoryCache, historyKey } from '../src/remote/history-store.ts'
import { RemoteHistoryCache, type HistoryRecord } from '../src/remote/history-cache.ts'
import { RemoteHistoryService } from '../src/remote/history-service.ts'
import type { RemoteGateway } from '../src/remote/gateway.ts'

const roots: string[] = [], stores: SegmentedHistoryCache[] = []
afterEach(async()=>{vi.useRealTimers();for(const store of stores.splice(0))await store.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
const rows=(first:number,last:number):HistoryRecord[]=>Array.from({length:last-first+1},(_,n)=>({type:'event',event:{seq:first+n,type:'user/message',content:[{type:'text',text:'Generated '+(first+n)}]}}))
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'dsh-history-segments-')); roots.push(root)
  const store=new SegmentedHistoryCache(root);stores.push(store);await store.list()
  const item={id:'local',hostId:'host',workspaceId:'project',alias:'fixture',remotePath:'/generated/project',title:'Project'}
  const key=historyKey(item.hostId,item.workspaceId,'session')
  const meta={key,hostId:item.hostId,workspaceId:item.workspaceId,sessionId:'session',alias:item.alias,remotePath:item.remotePath,title:'Generated',savedAt:Date.now(),remoteUpdatedAt:1,cursor:1199,complete:true}
  const manifest=async()=>{
    const m=JSON.parse(await readFile(join(root,'v2',key,'manifest.json'),'utf8'))
    const raw=(await readFile(join(root,'v2',key,m.generation,'segments.jsonl'))).subarray(0,m.indexBytes).toString()
    const entries=raw.trimEnd().split('\n').filter(Boolean).map(x=>JSON.parse(x))
    return{...m,segments:[...entries.slice().reverse().flatMap(x=>x.prepend),...entries.flatMap(x=>x.append)]}
  }
  const restart=async()=>{await store.close();const next=new SegmentedHistoryCache(root);stores.push(next);await next.list();return next}
  return {root,store,key,meta,item,manifest,restart}
}
it('persists immutable segments and reads bounded, contiguous windows after restart without SSH',async()=>{
  const f=await fixture();await f.store.save(f.meta,rows(0,1199),f.store.token(f.key))
  const m=await f.manifest();expect(m.version).toBe(2);expect(m.segments.map((x:any)=>x.count)).toEqual([500,500,200])
  expect((await lstat(join(f.root,'v2',f.key,m.generation,m.segments[0].file))).mode&0o777).toBe(0o600)
  const next=await f.restart(), tail=await next.window(f.key,undefined,100)
  expect(tail!.records).toEqual(rows(1100,1199));expect(tail!.page).toEqual({beforeSeq:1100,hasMore:true})
  expect((await next.window(f.key,1100,100))!.records).toEqual(rows(1000,1099))
  expect((await next.window(f.key,100,100))!.page!.hasMore).toBe(false)
  expect((await next.read(f.key))!.records).toEqual(rows(0,1199))
})
it('appends one event without changing any old segment bytes, names, mtime or firstSavedAt',async()=>{
  const f=await fixture();await f.store.save(f.meta,rows(0,1199),f.store.token(f.key));const before=await f.manifest()
  const files=await Promise.all(before.segments.map(async(s:any)=>{const p=join(f.root,'v2',f.key,before.generation,s.file);return {p,bytes:await readFile(p),mtime:(await lstat(p)).mtimeMs}}))
  await f.store.append({...f.meta,cursor:1200},rows(1200,1200),f.store.token(f.key));const after=await f.manifest()
  expect(after.segments.slice(0,-1)).toEqual(before.segments);expect(after.meta.firstSavedAt).toBe(before.meta.firstSavedAt)
  for(const file of files){expect(await readFile(file.p)).toEqual(file.bytes);expect((await lstat(file.p)).mtimeMs).toBe(file.mtime)}
  expect((await f.store.read(f.key))!.records).toEqual(rows(0,1200))
})
it('migrates a legacy copy losslessly, keeps its timestamp, and removes it from the old scanner',async()=>{
  const f=await fixture(), old=new RemoteHistoryCache(f.root);await old.list()
  await old.save(f.meta,rows(0,1199),old.token());const original=await old.read(f.key)
  const fresh=await f.restart();await fresh.prepare(f.key,fresh.token(f.key))
  expect((await fresh.read(f.key))!.records).toEqual(original!.records)
  expect((await fresh.meta(f.key))!.firstSavedAt).toBe(original!.meta.firstSavedAt)
  expect(await readdir(f.root)).not.toContain(f.key+'.json')
  expect(JSON.parse(await readFile(join(f.root,'v2',f.key,'legacy.v1.json'),'utf8'))).toEqual(original)
  expect(await new RemoteHistoryCache(f.root).read(f.key)).toBeUndefined()
})
it('retains legacy data and can finish migration after data commit but before old-file archival',async()=>{
  const f=await fixture(), old=new RemoteHistoryCache(f.root);await old.list();await old.save(f.meta,rows(0,1199),old.token())
  const fresh=await f.restart(), original=(fresh as any).archiveLegacy.bind(fresh)
  vi.spyOn(fresh as any,'archiveLegacy').mockRejectedValueOnce(new Error('Injected interruption'))
  await expect(fresh.prepare(f.key,fresh.token(f.key))).rejects.toThrow('Injected interruption')
  expect(await readFile(join(f.root,f.key+'.json'),'utf8')).toContain('Generated 1199')
  await fresh.prepare(f.key,fresh.token(f.key));expect((await fresh.read(f.key))!.records).toEqual(rows(0,1199))
  expect(await readdir(f.root)).not.toContain(f.key+'.json');expect(original).toBeTypeOf('function')
})
it('clears only selected copies, persists barriers, and never accepts pre-clear responses after explicit reopen',async()=>{
  const f=await fixture(), other=historyKey('other','project','session')
  await f.store.save(f.meta,rows(0,1199),f.store.token(f.key))
  await f.store.save({...f.meta,key:other,hostId:'other'},rows(0,1199),f.store.token(other))
  const old=f.store.token(f.key), unaffected=f.store.token(other)
  await f.store.clear([f.key]);expect(f.store.current(unaffected)).toBe(true);expect(await f.store.read(f.key)).toBeUndefined()
  await f.store.resume(f.key);expect(f.store.current(old)).toBe(false)
  expect(await f.store.append({...f.meta,cursor:1200},rows(1200,1200),old)).toBe(false)
  expect(await f.store.read(f.key)).toBeUndefined();expect((await f.store.read(other))!.records).toHaveLength(1200)
  const next=await f.restart();expect(await next.read(f.key)).toBeUndefined()
  expect(next.current(old)).toBe(false)
})
it('keeps cleared legacy files and migration archives out of a downgrade export',async()=>{
  const f=await fixture(), old=new RemoteHistoryCache(f.root);await old.list();await old.save(f.meta,rows(0,1199),old.token())
  const fresh=await f.restart();await fresh.prepare(f.key,fresh.token(f.key));await fresh.clear([f.key])
  const target=join(f.root,'downgrade');await fresh.exportV1(target)
  expect((await new RemoteHistoryCache(target).list()).entries).toEqual([])
  expect(await readdir(target)).toEqual(['index.json'])
  await expect(readFile(join(f.root,'v2',f.key,'legacy.v1.json'))).rejects.toMatchObject({code:'ENOENT'})
})
it('exports current new events for a verified v1 downgrade instead of reviving old migration backups',async()=>{
  const f=await fixture();await f.store.save(f.meta,rows(0,1199),f.store.token(f.key));await f.store.append({...f.meta,cursor:1200},rows(1200,1200),f.store.token(f.key))
  const target=join(f.root,'downgrade');await f.store.exportV1(target)
  expect((await new RemoteHistoryCache(target).read(f.key))!.records).toEqual(rows(0,1200))
  await expect(f.store.exportV1(target)).rejects.toThrow('already exists')
})
it('does not allow another token identity, noncontiguous events or conflicting snapshots to replace saved data',async()=>{
  const f=await fixture();await f.store.save(f.meta,rows(0,1199),f.store.token(f.key))
  expect(()=>f.store.token()).toThrow('session identity')
  expect(await f.store.append({...f.meta,cursor:1200},rows(1200,1200),f.store.token(historyKey('other','p','s')))).toBe(false)
  await expect(f.store.append({...f.meta,cursor:1201},rows(1201,1201),f.store.token(f.key))).rejects.toThrow('not contiguous')
  const changed=rows(0,1199);changed[0]!.event.type='different'
  await expect(f.store.save(f.meta,changed,f.store.token(f.key))).rejects.toThrow('conflicts')
  expect((await f.store.read(f.key))!.records).toEqual(rows(0,1199))
})
it('isolates a corrupt segment and rejects a publicly readable or symlinked segment',async()=>{
  const f=await fixture();await f.store.save(f.meta,rows(0,1199),f.store.token(f.key));const m=await f.manifest()
  const p=join(f.root,'v2',f.key,m.generation,m.segments[0].file)
  await writeFile(p,'[]');await expect(f.store.read(f.key)).rejects.toThrow('damaged')
  expect((await f.store.window(f.key,undefined,100))!.records).toEqual(rows(1100,1199))
  const tail=join(f.root,'v2',f.key,m.generation,m.segments.at(-1).file)
  await chmod(tail,0o644);await expect(f.store.window(f.key)).rejects.toThrow('Unsafe')
  await chmod(tail,0o600);await rm(tail);await symlink(p,tail)
  await expect(f.store.window(f.key)).rejects.toBeDefined()
})
it('does not let an active writer or stale reader overwrite a newer storage snapshot',async()=>{
  const f=await fixture(), stale=new SegmentedHistoryCache(f.root);stores.push(stale);await stale.list()
  await f.store.save(f.meta,rows(0,1199),f.store.token(f.key))
  await expect(stale.append({...f.meta,cursor:1200},rows(1200,1200),stale.token(f.key))).rejects.toThrow('writer')
  await f.store.close()
  await expect(stale.append({...f.meta,cursor:1200},rows(1200,1200),stale.token(f.key))).rejects.toThrow('reopen')
  const next=new SegmentedHistoryCache(f.root);stores.push(next);await next.list()
  await next.append({...f.meta,cursor:1200},rows(1200,1200),next.token(f.key));expect((await next.read(f.key))!.records).toHaveLength(1201)
})
it('keeps permanent copies and cleanup reminders separate from RAM lifetimes',async()=>{
  const f=await fixture();await f.store.save(f.meta,rows(0,1199),f.store.token(f.key))
  vi.useFakeTimers();vi.setSystemTime(Date.now()+10*365*86400000)
  expect((await f.store.list()).reminder).toBe(true);await f.store.snooze();expect((await f.store.list()).reminder).toBe(false)
  expect((await f.store.read(f.key))!.records).toHaveLength(1200)
})
it('synchronizes missing ranges without loading or rewriting the complete local history',async()=>{
  const f=await fixture(), all=rows(0,1199), delta=vi.fn(async(after:number,head?:number)=>({cursor:head??all.at(-1)!.event.seq,throughSeq:Math.min(head??all.at(-1)!.event.seq,after+500),records:all.filter(r=>r.event.seq>after&&r.event.seq<=Math.min(head??all.at(-1)!.event.seq,after+500))}))
  const service=new RemoteHistoryService(f.store,async()=>({gateway:{} as RemoteGateway,check(){},title:f.meta.title,updatedAt:1,delta}))
  const full=vi.spyOn(f.store,'read');await service.sync(f.item,'session');expect(full).not.toHaveBeenCalled()
  expect((await f.store.meta(f.key))!.records).toBe(1200);const m=await f.manifest(), before=await readFile(join(f.root,'v2',f.key,'manifest.json'))
  await service.sync(f.item,'session');expect(await readFile(join(f.root,'v2',f.key,'manifest.json'))).toEqual(before)
  all.push(...rows(1200,1200));await service.sync(f.item,'session')
  expect((await f.manifest()).segments.slice(0,-1)).toEqual(m.segments);expect(full).not.toHaveBeenCalled();expect((await f.store.window(f.key))!.records.at(-1)!.event.seq).toBe(1200)
})

it('bounds large-event previews while retaining the original record and allowing explicit full retrieval',async()=>{
  const f=await fixture();await f.store.save(f.meta,rows(0,1199),f.store.token(f.key))
  const large:HistoryRecord={type:'event',event:{seq:1200,type:'tool/result',data:{content:'Generated '.repeat(350000)}}}
  await f.store.append({...f.meta,cursor:1200},[large],f.store.token(f.key))
  const window=await f.store.window(f.key)
  expect(Buffer.byteLength(JSON.stringify(window))).toBeLessThan(2*1024*1024)
  expect(window!.page!.omitted).toEqual([{seq:1200,bytes:Buffer.byteLength(JSON.stringify([large]))}])
  expect(window!.records.at(-1)!.event).toEqual({seq:1200,type:'tool/result'})
  expect(await f.store.event(f.key,1200)).toEqual(large)
  expect((await f.store.read(f.key))!.records.at(-1)).toEqual(large)
})

it('fences a manifest already in progress when clear and explicit reopen race with its commit',async()=>{
  const f=await fixture();await f.store.save(f.meta,rows(0,1199),f.store.token(f.key))
  const original=(f.store as any).atomic.bind(f.store)
  let arrived!:()=>void, release!:()=>void
  const started=new Promise<void>(r=>{arrived=r}), gate=new Promise<void>(r=>{release=r})
  vi.spyOn(f.store as any,'atomic').mockImplementation(async(...args:any[])=>{
    if(String(args[0]).endsWith('/manifest.json')){arrived();await gate}
    return original(...args)
  })
  const stale=f.store.token(f.key), pending=f.store.append({...f.meta,cursor:1200},rows(1200,1200),stale)
  await started;const cleared=f.store.clear([f.key]);await Promise.resolve();const reopened=f.store.resume(f.key)
  release();expect(await pending).toBe(false);await cleared;await reopened
  expect(await f.store.read(f.key)).toBeUndefined();expect(f.store.current(stale)).toBe(false)
  await f.store.append({...f.meta,cursor:0},rows(0,0),f.store.token(f.key))
  expect((await f.store.read(f.key))!.records).toEqual(rows(0,0))
})
it('completes a real legacy tail-first checkpoint by prepending only missing records',async()=>{
  const f=await fixture(), old=new RemoteHistoryCache(f.root);await old.list();await old.save({...f.meta,complete:false},rows(1000,1199),old.token())
  const fresh=await f.restart(), seen:number[]=[]
  const service=new RemoteHistoryService(fresh,async()=>({check(){},title:f.meta.title,updatedAt:1,
    delta:async(after:number)=>({cursor:1199,throughSeq:after,records:[]}),gateway:{rpc:async(_method:string,args:any)=>{const before=args.request.beforeSeq;seen.push(before);const from=Math.max(0,before-500);return {records:rows(from,before-1),hasMore:from>0}}} as unknown as RemoteGateway}))
  await service.sync(f.item,'session');expect(seen).toEqual([1000,500]);expect((await fresh.read(f.key))!.records).toEqual(rows(0,1199))
  expect((await service.status()).failures).toEqual({})
})

it('stops writes after root rename succeeds but directory fsync fails, preserving both snapshots until reopen',async()=>{
  const f=await fixture();await f.store.save(f.meta,rows(0,1199),f.store.token(f.key))
  const sync=(f.store as any).syncDirectory.bind(f.store)
  const fault=vi.spyOn(f.store as any,'syncDirectory').mockImplementation(async(path:unknown)=>{
    if(path===join(f.root,'v2',f.key))throw Object.assign(new Error('Injected fsync EIO'),{code:'EIO'})
    return sync(path)
  })
  await expect(f.store.append({...f.meta,cursor:1200},rows(1200,1200),f.store.token(f.key))).rejects.toThrow('Injected')
  const m=await f.manifest(),index=join(f.root,'v2',f.key,m.generation,'segments.jsonl'),committed=await readFile(index)
  expect(m.meta.cursor).toBe(1200)
  expect((await f.store.read(f.key))!.meta.cursor).toBe(1199)
  expect((await f.store.list()).warning).toContain('may have reached disk')
  fault.mockRestore()
  await expect(f.store.append({...f.meta,cursor:1200},rows(1200,1200),f.store.token(f.key))).rejects.toThrow('reopen')
  expect(await readFile(index)).toEqual(committed)
  const next=await f.restart();expect((await next.read(f.key))!.records).toEqual(rows(0,1200))
  await next.append({...f.meta,cursor:1201},rows(1201,1201),next.token(f.key))
  expect((await next.read(f.key))!.records).toEqual(rows(0,1201))
})

it('requires reopening after a clear-barrier persistence failure rather than resuming from unconfirmed memory',async()=>{
  const f=await fixture();await f.store.save(f.meta,rows(0,1199),f.store.token(f.key))
  const sync=(f.store as any).syncDirectory.bind(f.store)
  const fault=vi.spyOn(f.store as any,'syncDirectory').mockImplementation(async(path:unknown)=>{
    if(path===join(f.root,'v2'))throw new Error('Injected barrier fsync failure')
    return sync(path)
  })
  await expect(f.store.clear([f.key])).rejects.toThrow('Injected')
  fault.mockRestore()
  await expect(f.store.resume(f.key)).rejects.toThrow('reopen')
  const next=await f.restart();expect(await next.read(f.key)).toBeUndefined()
  await next.resume(f.key);expect(await next.read(f.key)).toBeUndefined()
  await next.append({...f.meta,cursor:0},rows(0,0),next.token(f.key))
  expect((await next.read(f.key))!.records).toEqual(rows(0,0))
})
