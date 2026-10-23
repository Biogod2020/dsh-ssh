import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostStore } from '../src/store.ts'
import { RemoteWorkspaces } from '../src/remote/manager.ts'
import type { SshEngine } from '../src/engine.ts'
import { CatalogReadError } from '../src/remote/catalog-json.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ssh-catalog-performance-'))
  const store = new HostStore(join(root, 'hosts.json'))
  const host = store.create({ alias: 'fixture', host: '127.0.0.1', port: 22, user: 'fixture', auth: { kind: 'password', password: 'fixture-only' } })
  const manager = new RemoteWorkspaces({ find: (alias: string) => store.find(alias), stopWorkspaceTunnel: vi.fn() } as unknown as SshEngine,
    { root: join(root, 'manager'), installer: '', bootstrap: '', returnUrl: () => 'http://127.0.0.1:1/' })
  clearInterval((manager as any).recovery)
  const hostId = (manager as any).hostId('fixture')
  const rows = [{ sessionId: 'one', updatedAt: 1, running: false, blank: false }, { sessionId: 'two', updatedAt: 2, running: true, blank: false }]
  const gateway = {
    workspaceCatalogSnapshot: vi.fn(async () => ({ items: [{ workspaceId: 'first', sessionIds: ['one'] }, { workspaceId: 'second', sessionIds: ['two'] }], archivedSessionIds: [] })),
    rpc: vi.fn(async (method: string) => method === 'session/list' ? { items: [...rows] } : method === 'workspace/create'
      ? { workspace: { sessionIds: ['one'] } } : { sessionId: 'created' }),
    healthy: vi.fn(async () => true), dispose: vi.fn(), launch: vi.fn(() => 'http://127.0.0.1:1/'),
  }
  const runtime = { gateway, hostId, alias: 'fixture', updatedAt: host.updatedAt, tunnelId: 'fixture', retryAt: 0, failures: 0 }
  ;(manager as any).runtimes.set(hostId, runtime)
  for (const [n, workspaceId] of ['first', 'second'].entries()) {
    const id = (n ? 'b' : 'a').repeat(24)
    ;(manager as any).workspaces.set(id, { id, hostId, alias: 'fixture', remotePath: '/'+workspaceId, title: workspaceId, workspaceId })
  }
  cleanups.push(async () => { await manager.dispose(); rmSync(root, { recursive: true, force: true }) })
  return { manager, store, gateway, hostId, rows, runtime, first: 'a'.repeat(24), second: 'b'.repeat(24) }
}
it('shares one remote catalog across projects and short bursts, with original freshness and bounded expiry', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100000)
  const f = fixture()
  const [first, second] = await Promise.all([f.manager.sessions(f.first), f.manager.sessions(f.second)])
  expect(first.sessions.map(x => x.sessionId)).toEqual(['one']); expect(second.sessions.map(x => x.sessionId)).toEqual(['two'])
  expect(f.gateway.workspaceCatalogSnapshot).toHaveBeenCalledOnce(); expect(f.gateway.rpc).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(1500)
  expect((await f.manager.sessions(f.first)).checkedAt).toBe(first.checkedAt)
  expect(f.gateway.rpc).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(501)
  f.rows[0]!.running = true
  expect((await f.manager.sessions(f.first)).sessions[0]!.running).toBe(true)
  expect(f.gateway.workspaceCatalogSnapshot).toHaveBeenCalledTimes(2); expect(f.gateway.rpc).toHaveBeenCalledTimes(2)
})

it('aggregates a hundred owned projects into one Host baseline and list without mixing Session membership',async()=>{
  const f=fixture(),workspaces=(f.manager as any).workspaces as Map<string,unknown>
  workspaces.clear()
  const projects=Array.from({length:100},(_,n)=>({workspaceId:'project-'+n,sessionIds:['session-'+n]}))
  const rows=projects.map((project,n)=>({sessionId:project.sessionIds[0]!,updatedAt:n,running:false,blank:false,projections:{values:{title:'Generated 项目 '+n}}}))
  f.gateway.workspaceCatalogSnapshot.mockResolvedValue({items:projects,archivedSessionIds:[]})
  f.gateway.rpc.mockImplementation(async()=>({items:rows}))
  const ids=projects.map((project,n)=>{
    const id=n.toString(16).padStart(24,'0')
    workspaces.set(id,{id,hostId:f.hostId,alias:'fixture',remotePath:'/generated/'+n,title:'Generated '+n,workspaceId:project.workspaceId})
    return id
  })
  const catalogs=await Promise.all(ids.map(id=>f.manager.sessions(id)))
  expect(f.gateway.workspaceCatalogSnapshot).toHaveBeenCalledOnce();expect(f.gateway.rpc).toHaveBeenCalledOnce()
  for(const [n,catalog] of catalogs.entries()){
    expect(catalog.stale).toBe(false)
    expect(catalog.sessions.map(row=>row.sessionId)).toEqual(['session-'+n])
    expect(catalog.sessions[0]!.title).toBe('Generated 项目 '+n)
  }
})
it('keeps a quiet Host snapshot for fifteen seconds but invalidates immediately after an explicit change',async()=>{
  vi.useFakeTimers();vi.setSystemTime(100000)
  const f=fixture();for(const row of f.rows)row.running=false
  await f.manager.sessions(f.first)
  for(let n=0;n<6;n++){vi.advanceTimersByTime(2000);await f.manager.sessions(f.first)}
  expect(f.gateway.rpc).toHaveBeenCalledOnce()
  await f.manager.createSession(f.first);await f.manager.sessions(f.first)
  expect(f.gateway.rpc.mock.calls.map(row=>row[0])).toEqual(['session/list','session/create','session/list'])
  vi.advanceTimersByTime(15001);await f.manager.sessions(f.first)
  expect(f.gateway.rpc.mock.calls.filter(row=>row[0]==='session/list')).toHaveLength(3)
})
it('invalidates the catalog around explicit creation without caching or replaying the mutation', async () => {
  const f = fixture(); await f.manager.sessions(f.first)
  expect(await f.manager.createSession(f.first)).toEqual({ sessionId: 'created' })
  await f.manager.sessions(f.first)
  expect(f.gateway.rpc.mock.calls.map(x => x[0])).toEqual(['session/list', 'session/create', 'session/list'])
  expect(f.gateway.healthy).not.toHaveBeenCalled()
})
it('checks Host and workspace ownership before a remote Session metadata write',async()=>{
  const f=fixture()
  await expect(f.manager.sessionAction(f.first,'one','pin',undefined,false,'wrong-host')).rejects.toThrow('identity changed')
  await expect(f.manager.sessionAction(f.first,'two','archive')).rejects.toThrow('does not belong')
  await expect(f.manager.sessionAction(f.first,'one','__proto__')).rejects.toThrow('Invalid')
  expect(f.gateway.rpc.mock.calls.map(row=>row[0])).toEqual(['session/list'])
  await f.manager.sessionAction(f.first,'one','pin',undefined,false,f.hostId)
  expect(f.gateway.rpc).toHaveBeenLastCalledWith('workspace/pinSession',{request:{sessionId:'one'}})
})
it('never repeats a metadata write after a lost reply or implicitly stops active work',async()=>{
  const f=fixture();await f.manager.sessions(f.first)
  f.gateway.rpc.mockRejectedValueOnce(new Error('Generated lost acknowledgement'))
  await expect(f.manager.sessionAction(f.first,'one','archive')).rejects.toThrow('acknowledgement')
  expect(f.gateway.rpc.mock.calls.filter(row=>row[0]==='workspace/archiveSession')).toEqual([['workspace/archiveSession',{request:{sessionId:'one'}}]])
  await f.manager.sessionAction(f.first,'one','archive',undefined,true)
  expect(f.gateway.rpc).toHaveBeenLastCalledWith('workspace/archiveSession',{request:{sessionId:'one',stopActivity:true}})
})
it('keeps archived metadata for native recovery and tracks the owning Host pin feed',async()=>{
  const f=fixture()
  f.gateway.workspaceCatalogSnapshot.mockResolvedValue({items:[{workspaceId:'first',sessionIds:['one','two']}],archivedSessionIds:['two'],pinnedSessionIds:['one']} as any)
  const catalog=await f.manager.sessions(f.first)
  expect(catalog.sessions.map(row=>[row.sessionId,row.pinned])).toEqual([['one',true]])
  expect(catalog.archivedSessions?.map(row=>row.sessionId)).toEqual(['two'])
})
it('drops failed reads and never uses cached readiness after host settings change or disable', async () => {
  const f = fixture(); await f.manager.sessions(f.first)
  vi.useFakeTimers(); vi.advanceTimersByTime(2001)
  f.gateway.workspaceCatalogSnapshot.mockRejectedValueOnce(new Error('connection lost'))
  expect((await f.manager.sessions(f.first)).stale).toBe(true)
  expect((await f.manager.sessions(f.first)).stale).toBe(false)
  f.store.update('fixture', { user: 'different-owner' })
  const reads = f.gateway.rpc.mock.calls.length
  expect((await f.manager.sessions(f.first)).stale).toBe(true)
  await expect(f.manager.open(f.first, 'one')).rejects.toThrow('settings changed')
  f.manager.setEnabled(false)
  expect((await f.manager.sessions(f.first)).stale).toBe(true)
  expect(f.gateway.rpc).toHaveBeenCalledTimes(reads)
})

it('keeps the saved list when a bounded catalog read fails and shows only approved local diagnostics',async()=>{
  const f=fixture(),first=await f.manager.sessions(f.first)
  ;(f.runtime as any).catalog=undefined
  f.gateway.rpc.mockRejectedValueOnce(new CatalogReadError('size'))
  const failed=await f.manager.sessions(f.first)
  expect(failed.stale).toBe(true);expect(failed.sessions).toEqual(first.sessions)
  expect(failed.warning).toContain('8 MiB byte budget')
})

it('does not expose arbitrary remote failure text with the saved catalog',async()=>{
  const f=fixture();await f.manager.sessions(f.first);(f.runtime as any).catalog=undefined
  f.gateway.rpc.mockRejectedValueOnce(new Error('generated-private-remote-detail'))
  const failed=await f.manager.sessions(f.first)
  expect(failed.warning).toContain('Showing the last saved list')
  expect(failed.warning).not.toContain('generated-private-remote-detail')
})
it('opens through the shared read-only catalog without repeated workspace writes and never retries a failed write', async () => {
  const f = fixture()
  await f.manager.open(f.first, 'one')
  await f.manager.open(f.first, 'one')
  expect(f.gateway.healthy).not.toHaveBeenCalled()
  await expect(f.manager.open(f.first, 'two')).rejects.toThrow('does not belong')
  f.gateway.rpc.mockRejectedValueOnce(new Error('lost acknowledgement'))
  await expect(f.manager.createSession(f.first)).rejects.toThrow('lost acknowledgement')
  expect(f.gateway.rpc.mock.calls.map(x => x[0])).toEqual(['session/list', 'session/create'])
})

it('schedules only saved histories on existing carriers without relying on a mounted sidebar',async()=>{
  const f=fixture(),cache=(f.manager as any).historyCache
  vi.spyOn(cache.cache,'list').mockResolvedValue({entries:[
    {hostId:f.hostId,workspaceId:'first',sessionId:'one'},
    {hostId:'offline-host',workspaceId:'offline',sessionId:'old'},
  ]})
  const sync=vi.spyOn(cache,'sync').mockResolvedValue(undefined)
  await (f.manager as any).refreshSavedHistories()
  expect(sync).toHaveBeenCalledOnce();expect(sync.mock.calls[0]!.slice(1,3)).toEqual(['one',false])
  expect(f.gateway.rpc).not.toHaveBeenCalled();expect(f.gateway.workspaceCatalogSnapshot).not.toHaveBeenCalled()
  ;(f.manager as any).runtimes.clear();await (f.manager as any).refreshSavedHistories()
  expect(sync).toHaveBeenCalledOnce()
  f.manager.setEnabled(false);await (f.manager as any).refreshSavedHistories();expect(sync).toHaveBeenCalledOnce()
})

it('returns local Host observations immediately while one shared health probe is unresolved',async()=>{
  const f=fixture();let finish!:(healthy:boolean)=>void
  f.gateway.healthy.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
  const first=await f.manager.status(),second=await f.manager.status()
  expect(first).toEqual([{hostId:f.hostId,phase:'connecting',checking:true}]);expect(second).toEqual(first)
  expect(f.gateway.healthy).toHaveBeenCalledOnce();finish(true)
  for(let n=0;n<8;n++)await Promise.resolve()
  expect(await f.manager.status()).toMatchObject([{hostId:f.hostId,phase:'ready',checking:false,checkedAt:expect.any(Number)}])
  f.store.update('fixture',{user:'different-owner'})
  expect(await f.manager.status()).toEqual([{hostId:f.hostId,phase:'disconnected'}])
  expect(f.gateway.healthy).toHaveBeenCalledOnce()
})

it('never lets a delayed old catalog overwrite a newer saved title or membership',async()=>{
  const f=fixture()
  let finishOld!:(value:any)=>void
  f.gateway.rpc.mockImplementationOnce(()=>new Promise(resolve=>{finishOld=resolve}))
  const old=f.manager.sessions(f.first)
  await Promise.resolve()
  ;(f.manager as any).invalidateCatalog(f.runtime)
  f.gateway.workspaceCatalogSnapshot.mockResolvedValue({items:[{workspaceId:'first',sessionIds:['two']}],archivedSessionIds:[]})
  const currentRow={...f.rows[1]!,projections:{values:{title:'Current title'}}}
  f.gateway.rpc.mockResolvedValue({items:[currentRow]})
  const current=await f.manager.sessions(f.first)
  expect(current.sessions.map(row=>[row.sessionId,row.title])).toEqual([['two','Current title']])
  finishOld({items:[{...f.rows[0]!,projections:{values:{title:'Obsolete title'}}}]})
  const delayed=await old
  expect(delayed.stale).toBe(false)
  expect(delayed.warning).toBeUndefined()
  expect(delayed.sessions).toEqual(current.sessions)
  const saved=(f.manager as any).sessionCache.get(f.first,'first')
  expect(saved.sessions).toEqual(current.sessions)
  expect((await f.manager.sessions(f.first)).sessions).toEqual(current.sessions)
  expect(f.gateway.rpc).toHaveBeenCalledTimes(2)
})

it('fences a read during a dispatched mutation even when its acknowledgement is lost, without replay',async()=>{
  const f=fixture();await f.manager.sessions(f.first)
  ;(f.manager as any).invalidateCatalog(f.runtime)
  let finishOld!:(value:any)=>void, failMutation!:(error:Error)=>void
  f.gateway.rpc.mockImplementationOnce(()=>new Promise(resolve=>{finishOld=resolve}))
  const old=f.manager.sessions(f.first)
  await Promise.resolve()
  f.gateway.rpc.mockImplementationOnce(()=>new Promise((_,reject)=>{failMutation=reject}))
  const mutation=f.manager.createSession(f.first)
  const rejected=expect(mutation).rejects.toThrow('lost acknowledgement')
  for(let n=0;n<4;n++)await Promise.resolve()
  finishOld({items:[]})
  expect((await old).sessions.map(row=>row.sessionId)).toEqual(['one'])
  failMutation(new Error('lost acknowledgement'));await rejected
  expect((await f.manager.sessions(f.first)).sessions.map(row=>row.sessionId)).toEqual(['one'])
  expect(f.gateway.rpc.mock.calls.filter(call=>call[0]==='session/create')).toHaveLength(1)
})

it('rechecks read-only metadata once when a directory increment supersedes the first history-source read',async()=>{
  const f=fixture()
  f.gateway.rpc.mockImplementationOnce(async()=>{
    ;(f.manager as any).invalidateCatalog(f.runtime)
    return {items:[...f.rows]}
  })
  const item=(f.manager as any).workspaces.get(f.first)
  const source=await (f.manager as any).historyCache.source(item,'one')
  expect(source.gateway).toBe(f.gateway);expect(source.updatedAt).toBe(1)
  expect(f.gateway.rpc.mock.calls.map(call=>call[0])).toEqual(['session/list','session/list'])
})

it('returns a current Session catalog after one superseded read rather than a transient sync failure',async()=>{
  const f=fixture()
  f.gateway.rpc.mockImplementationOnce(async()=>{
    ;(f.manager as any).invalidateCatalog(f.runtime)
    return {items:[]}
  })
  const catalog=await f.manager.sessions(f.first)
  expect(catalog.stale).toBe(false);expect(catalog.warning).toBeUndefined()
  expect(catalog.sessions.map(row=>row.sessionId)).toEqual(['one'])
  expect(f.gateway.rpc.mock.calls.map(call=>call[0])).toEqual(['session/list','session/list'])
})


it('bounds superseded reads and never re-queries after disable or Host ownership change',async()=>{
  const f=fixture();await f.manager.sessions(f.first)
  ;(f.manager as any).invalidateCatalog(f.runtime)
  f.gateway.rpc.mockImplementation(async()=>{
    ;(f.manager as any).invalidateCatalog(f.runtime)
    return {items:[]}
  })
  const start=f.gateway.rpc.mock.calls.length
  const failed=await f.manager.sessions(f.first)
  expect(failed.stale).toBe(true);expect(failed.sessions.map(row=>row.sessionId)).toEqual(['one'])
  expect(f.gateway.rpc.mock.calls.length-start).toBe(2)
  f.gateway.rpc.mockImplementationOnce(async()=>{
    ;(f.manager as any).invalidateCatalog(f.runtime)
    f.store.update('fixture',{user:'new-owner'})
    return {items:[]}
  })
  const before=f.gateway.rpc.mock.calls.length
  expect((await f.manager.sessions(f.first)).stale).toBe(true)
  expect(f.gateway.rpc.mock.calls.length-before).toBe(1)
})

it('does not issue the superseded read replacement after the manager is disabled',async()=>{
  const f=fixture();await f.manager.sessions(f.first)
  ;(f.manager as any).invalidateCatalog(f.runtime)
  f.gateway.rpc.mockImplementationOnce(async()=>{
    ;(f.manager as any).invalidateCatalog(f.runtime)
    f.manager.setEnabled(false)
    return {items:[]}
  })
  const before=f.gateway.rpc.mock.calls.length
  const result=await f.manager.sessions(f.first)
  expect(result.stale).toBe(true);expect(result.sessions.map(row=>row.sessionId)).toEqual(['one'])
  expect(f.gateway.rpc.mock.calls.length-before).toBe(1)
})
