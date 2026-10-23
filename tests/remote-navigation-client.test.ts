// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { navigationClient, navigationManifest } from '../src/remote/navigation-client.ts'
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear() })

it('adds a page-local boot contribution without changing original manifest rows', () => {
  const original = { entries: [{ id: 'native', url: '/native.js', rev: 'one' }], batches: [{ phase: 'application', url: '/native.js', rev: 'one', entries: ['native'] }] }
  vi.stubGlobal('__DSH_BOOT__', original)
  navigationManifest(); navigationManifest()
  const result = (window as any).__DSH_BOOT__
  expect(original.entries).toHaveLength(1); expect(original.batches).toHaveLength(1)
  expect(result.entries).toHaveLength(3); expect(result.batches).toHaveLength(3)
  expect(result.entries.some((row: any) => row.id === '@jay-local/dsh-ssh-drafts')).toBe(true)
})

it('retains only three visited Session clients, reuses them, and releases archives, expiry and page ownership', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100000)
  let registration: any, current = 'one'
  const archivedSessionIds: string[] = [], cleanup: Array<() => void> = [], references = new Map<string, { release: ReturnType<typeof vi.fn> }>()
  vi.stubGlobal('__ModuleLoader__', { load: (value: unknown) => { registration = value } })
  navigationClient()
  const retain = vi.fn((id: string) => { const reference = { release: vi.fn() }; references.set(id, reference); return reference })
  const ctx: any = { uiWorkspace: { openSession: vi.fn((id: string) => { current = id }) },
    sessions: { retain, list: { getSnapshot: () => ({ byId: { [current]: { id: current, retainedBy: { mainView: 1 } } } }) } },
    workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'project', sessionIds: ['one', 'two', 'three', 'four', 'unvisited'] }], archivedSessionIds }) } },
    effect: (fn: () => () => void) => cleanup.push(fn()) }
  ctx.root = { inject: (_deps: string[], apply: (ctx: unknown) => void) => { apply(ctx); return { dispose: () => cleanup.forEach(fn => fn()) } } }
  registration.factory().apply(ctx)
  try {
    const bridge = (window as any).__dshSshView
    bridge.select('project', 'two'); bridge.select('project', 'one'); bridge.select('project', 'two')
    expect(retain.mock.calls.map(x => x[0])).toEqual(['one', 'two'])
    bridge.select('project', 'three'); bridge.select('project', 'four')
    expect(references.get('one')!.release).toHaveBeenCalledOnce()
    expect(references.get('two')!.release).not.toHaveBeenCalled()
    archivedSessionIds.push('two')
    await vi.advanceTimersByTimeAsync(30000)
    expect(references.get('two')!.release).toHaveBeenCalledOnce()
    expect(retain.mock.calls.some(x => x[0] === 'unvisited')).toBe(false)
    await vi.advanceTimersByTimeAsync(270000)
    expect(references.get('three')!.release).toHaveBeenCalledOnce()
    expect(references.get('four')!.release).toHaveBeenCalledOnce()
    bridge.select('project', 'three')
  } finally { cleanup.forEach(fn => fn()); delete (window as any).__dshSshNavigationOwner }
  for (const reference of references.values()) expect(reference.release).toHaveBeenCalledOnce()
})

it('selects through the remote public UI service without creating, submitting or reloading a Session', () => {
  let registration: any
  vi.stubGlobal('__ModuleLoader__', { load: (value: unknown) => { registration = value } })
  navigationClient()
  const openSession = vi.fn(), dispose: Array<() => void> = []
  const ctx: any = { uiWorkspace: { openSession }, sessions: { list: { getSnapshot: () => ({ byId: { one: { id: 'one', retainedBy: { mainView: 1 } } } }) } },
    workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'project', sessionIds: ['one'] }] }) } }, effect: (fn: () => () => void) => dispose.push(fn()) }
  ctx.root = { inject: (_deps: string[], apply: (ctx: unknown) => void) => { apply(ctx); return { dispose: () => dispose.forEach(fn => fn()) } } }
  registration.factory().apply(ctx)
  const bridge = (window as any).__dshSshView
  expect(bridge.state()).toEqual({ sessionId: 'one', workspaceId: 'project' })
  bridge.open('two'); expect(openSession).toHaveBeenCalledExactlyOnceWith('two')
  expect(() => bridge.open('bad\nidentity')).toThrow('Invalid remote Session')
  openSession.mockClear()
  expect(bridge.select('project', 'one')).toBe(true)
  expect(openSession).toHaveBeenCalledExactlyOnceWith('one')
  expect(bridge.select('different-project', 'one')).toBe(false)
  expect(bridge.select('project', 'unknown')).toBe(false)
  expect(bridge.select('project', 'bad\nidentity')).toBe(false)
  ctx.workspaces.list.getSnapshot = () => ({ items: [{ workspaceId: 'project', sessionIds: ['one'] }], archivedSessionIds: ['one'] })
  expect(bridge.select('project', 'one')).toBe(false)
  expect(openSession).toHaveBeenCalledOnce()
  dispose.forEach(fn => fn()); expect((window as any).__dshSshView).toBeUndefined()
  delete (window as any).__dshSshNavigationOwner
})

it('opens Models through the owning remote shell and fails closed when that shell lacks the contract', () => {
  let registration:any
  vi.stubGlobal('__ModuleLoader__',{load:(value:unknown)=>{registration=value}})
  navigationClient()
  const openSection=vi.fn(),openSession=vi.fn(),cleanup:Array<()=>void>=[]
  let models=true,shell=true
  const create=vi.fn(()=>({actions:{openSection}}))
  const ctx:any={uiWorkspace:{openSession},sessions:{list:{getSnapshot:()=>({})}},workspaces:{list:{getSnapshot:()=>({items:[]})}},
    slots:{entries:(name:string)=>name==='settings.section'?(models?[{options:{id:'models'}}]:[]):shell?[{store:{create}}]:[]},
    effect:(fn:()=>()=>void)=>cleanup.push(fn())}
  ctx.root={inject:(deps:string[],apply:(ctx:unknown)=>void)=>{expect(deps).toContain('slots');apply(ctx);return{dispose:()=>cleanup.forEach(fn=>fn())}}}
  try{
    registration.factory().apply(ctx)
    const bridge=(window as any).__dshSshView
    expect(bridge.settings()).toBe(true);expect(openSection).toHaveBeenCalledExactlyOnceWith('models')
    models=false;expect(bridge.settings()).toBe(false);expect(create).toHaveBeenCalledOnce()
    models=true;shell=false;expect(bridge.settings()).toBe(false)
    expect(openSession).not.toHaveBeenCalled();expect(openSection).toHaveBeenCalledOnce()
  }finally{cleanup.forEach(fn=>fn());delete(window as any).__dshSshNavigationOwner}
})
it('fences asynchronous draft preparation by the latest navigation and rechecks membership before selecting', async () => {
  let registration:any,finish!:()=>void,firstSignal:AbortSignal|undefined
  const cleanups:Array<()=>void>=[],archivedSessionIds:string[]=[],openSession=vi.fn()
  vi.stubGlobal('__ModuleLoader__',{load:(value:any)=>{registration=value}})
  const prepare=vi.fn(async(id:string,signal?:AbortSignal)=>{
    if(id==='two'&&!firstSignal){firstSignal=signal;await new Promise<void>(resolve=>{finish=resolve})}
  })
  vi.stubGlobal('__dshSshDrafts',{prepare});navigationClient()
  const ctx:any={uiWorkspace:{openSession},sessions:{list:{getSnapshot:()=>({byId:{one:{id:'one',retainedBy:{mainView:1}}}})}},
    workspaces:{list:{getSnapshot:()=>({items:[{workspaceId:'project',sessionIds:['one','two','three']}],archivedSessionIds})}},
    effect:(apply:()=>()=>void)=>cleanups.push(apply())}
  ctx.root={inject:(_deps:string[],apply:(ctx:any)=>void)=>{apply(ctx);return{dispose:()=>cleanups.forEach(fn=>fn())}}}
  registration.factory().apply(ctx)
  try{
    const bridge=(window as any).__dshSshView
    const old=bridge.select('project','two');expect(openSession).not.toHaveBeenCalled()
    expect(await bridge.select('project','three')).toBe(true)
    expect(firstSignal!.aborted).toBe(true)
    finish();expect(await old).toBe(false)
    expect(openSession).toHaveBeenCalledExactlyOnceWith('three')
    const removed=bridge.select('project','two');archivedSessionIds.push('two')
    expect(await removed).toBe(false);expect(openSession).toHaveBeenCalledTimes(1)
  }finally{cleanups.forEach(fn=>fn());delete(window as any).__dshSshNavigationOwner}
})

it('samples only bounded lifecycle metadata and renderer heap estimates, including dormant terminal tabs',()=>{
  let registration:any
  const cleanup:Array<()=>void>=[]
  vi.stubGlobal('__ModuleLoader__',{load:(value:unknown)=>{registration=value}})
  vi.stubGlobal('performance',{memory:{usedJSHeapSize:123456}})
  const privateText='Generated private text excluded from measurements'
  vi.stubGlobal('__dshSshDrafts',{inspection:()=>({pendingUnmountSaves:1,failedUnmountSaves:2,unrelated:privateText,
    sessions:[{sessionId:'one',status:'saved',revision:4,persisted:true,hasReferences:false,hasAttachments:true,inputPhase:'plain',draft:privateText}]})})
  const tabs=[{kind:'terminal',sessionId:'dormant'},{kind:'resource',address:'private-generated-address'}]
  const ctx:any={uiWorkspace:{openSession:vi.fn()},sessions:{list:{getSnapshot:()=>({byId:{one:{id:'one',retainedBy:{mainView:1}}}})}},
    workspaces:{list:{getSnapshot:()=>({items:[{workspaceId:'project',sessionIds:['one']}]})}},
    get:(name:string)=>name==='sidebarRight'?{openTabs:{getSnapshot:()=>tabs}}:undefined,
    effect:(fn:()=>()=>void)=>cleanup.push(fn())}
  ctx.root={inject:(_deps:string[],apply:(ctx:unknown)=>void)=>{apply(ctx);return{dispose:()=>cleanup.forEach(fn=>fn())}}}
  navigationClient();registration.factory().apply(ctx)
  try{
    const bridge=(window as any).__dshSshView,first=bridge.inspection()
    expect(first.memory).toEqual({kind:'renderer-js-heap-estimate',bytes:123456})
    expect(first.sidebar).toEqual({tabs:2,terminals:1});expect(first.navigation).toEqual({sessionId:'one',workspaceId:'project'})
    expect(first.drafts).toMatchObject({pendingUnmountSaves:1,failedUnmountSaves:2,sessions:[{hasAttachments:true}]})
    expect(first.lifecycle).toEqual({scope:'observation-only',pendingRequests:null,unconfirmedOperations:null})
    expect(JSON.stringify(first)).not.toContain(privateText);expect(JSON.stringify(first)).not.toContain('private-generated-address')
    ;(performance as any).memory.usedJSHeapSize=NaN;ctx.get=()=>undefined
    expect(bridge.inspection()).toMatchObject({memory:{bytes:null},sidebar:null})
    vi.stubGlobal('__dshSshDrafts',{inspection:()=>({sessions:privateText})})
    expect(bridge.inspection().drafts).toBeNull()
  }finally{cleanup.forEach(fn=>fn());delete(window as any).__dshSshNavigationOwner}
})
