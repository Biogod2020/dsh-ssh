import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostStore } from '../src/store.ts'
import { RemoteWorkspaces } from '../src/remote/manager.ts'
import type { SshEngine } from '../src/engine.ts'
import { CatalogReadError } from '../src/remote/catalog-json.ts'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.useRealTimers() })
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
    workspaceSnapshot: vi.fn(async () => ({ items: [{ workspaceId: 'first', sessionIds: ['one'] }, { workspaceId: 'second', sessionIds: ['two'] }], archivedSessionIds: [] })),
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
  cleanups.push(() => { manager.dispose(); rmSync(root, { recursive: true, force: true }) })
  return { manager, store, gateway, hostId, rows, runtime, first: 'a'.repeat(24), second: 'b'.repeat(24) }
}
it('shares one remote catalog across projects and short bursts, with original freshness and bounded expiry', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100000)
  const f = fixture()
  const [first, second] = await Promise.all([f.manager.sessions(f.first), f.manager.sessions(f.second)])
  expect(first.sessions.map(x => x.sessionId)).toEqual(['one']); expect(second.sessions.map(x => x.sessionId)).toEqual(['two'])
  expect(f.gateway.workspaceSnapshot).toHaveBeenCalledOnce(); expect(f.gateway.rpc).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(1500)
  expect((await f.manager.sessions(f.first)).checkedAt).toBe(first.checkedAt)
  expect(f.gateway.rpc).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(501)
  f.rows[0]!.running = true
  expect((await f.manager.sessions(f.first)).sessions[0]!.running).toBe(true)
  expect(f.gateway.workspaceSnapshot).toHaveBeenCalledTimes(2); expect(f.gateway.rpc).toHaveBeenCalledTimes(2)
})

it('aggregates a hundred owned projects into one Host baseline and list without mixing Session membership',async()=>{
  const f=fixture(),workspaces=(f.manager as any).workspaces as Map<string,unknown>
  workspaces.clear()
  const projects=Array.from({length:100},(_,n)=>({workspaceId:'project-'+n,sessionIds:['session-'+n]}))
  const rows=projects.map((project,n)=>({sessionId:project.sessionIds[0]!,updatedAt:n,running:false,blank:false,projections:{values:{title:'Generated 项目 '+n}}}))
  f.gateway.workspaceSnapshot.mockResolvedValue({items:projects,archivedSessionIds:[]})
  f.gateway.rpc.mockImplementation(async()=>({items:rows}))
  const ids=projects.map((project,n)=>{
    const id=n.toString(16).padStart(24,'0')
    workspaces.set(id,{id,hostId:f.hostId,alias:'fixture',remotePath:'/generated/'+n,title:'Generated '+n,workspaceId:project.workspaceId})
    return id
  })
  const catalogs=await Promise.all(ids.map(id=>f.manager.sessions(id)))
  expect(f.gateway.workspaceSnapshot).toHaveBeenCalledOnce();expect(f.gateway.rpc).toHaveBeenCalledOnce()
  for(const [n,catalog] of catalogs.entries()){
    expect(catalog.stale).toBe(false)
    expect(catalog.sessions.map(row=>row.sessionId)).toEqual(['session-'+n])
    expect(catalog.sessions[0]!.title).toBe('Generated 项目 '+n)
  }
})
it('invalidates the catalog around explicit creation without caching or replaying the mutation', async () => {
  const f = fixture(); await f.manager.sessions(f.first)
  expect(await f.manager.createSession(f.first)).toEqual({ sessionId: 'created' })
  await f.manager.sessions(f.first)
  expect(f.gateway.rpc.mock.calls.map(x => x[0])).toEqual(['session/list', 'session/create', 'session/list'])
  expect(f.gateway.healthy).not.toHaveBeenCalled()
})
it('drops failed reads and never uses cached readiness after host settings change or disable', async () => {
  const f = fixture(); await f.manager.sessions(f.first)
  vi.useFakeTimers(); vi.advanceTimersByTime(2001)
  f.gateway.workspaceSnapshot.mockRejectedValueOnce(new Error('connection lost'))
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
it('uses the actual open RPC for reachability, validates membership, and never retries a failed write', async () => {
  const f = fixture()
  await f.manager.open(f.first, 'one')
  expect(f.gateway.healthy).not.toHaveBeenCalled()
  await expect(f.manager.open(f.first, 'two')).rejects.toThrow('does not belong')
  f.gateway.rpc.mockRejectedValueOnce(new Error('lost acknowledgement'))
  await expect(f.manager.createSession(f.first)).rejects.toThrow('lost acknowledgement')
  expect(f.gateway.rpc.mock.calls.map(x => x[0])).toEqual(['workspace/create', 'workspace/create', 'session/create'])
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
  expect(f.gateway.rpc).not.toHaveBeenCalled();expect(f.gateway.workspaceSnapshot).not.toHaveBeenCalled()
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
