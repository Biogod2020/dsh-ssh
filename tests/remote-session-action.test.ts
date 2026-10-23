// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { remoteNavigation } from '../src/client/remote-navigation.ts'
import { archiveRemoteSession, mutateRemoteSession } from '../src/client/remote-session-action.ts'
import { registerRemotePresentation, selectRemoteView } from '../src/client/remote-presentation.ts'

const workspace = { id:'a'.repeat(24),hostId:'b'.repeat(24),workspaceId:'project',alias:'fixture',remotePath:'/fixture',title:'Generated' }
const catalog = (pinned=false) => ({workspaceId:'project',stale:false,sessions:[{sessionId:'same',title:'Generated',updatedAt:1,running:false,blank:false,pinned}]})
const reply=(value:object)=>({ok:true,json:async()=>value}) as Response
afterEach(()=>{remoteNavigation.clear();selectRemoteView();vi.unstubAllGlobals();vi.restoreAllMocks()})
it('refreshes uncertain results but never repeats a write after the acknowledgement is lost',async()=>{
  remoteNavigation.update([workspace])
  const fetch=vi.fn(async(_url:unknown,options?:RequestInit)=>{if(options?.method==='POST')throw Error('Generated lost reply');return reply(catalog(true))})
  vi.stubGlobal('fetch',fetch)
  await expect(mutateRemoteSession(workspace,'same','pin')).rejects.toThrow('lost reply')
  expect(fetch.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1)
  expect(remoteNavigation.getSnapshot().catalogs.get(workspace.id)?.sessions[0]?.pinned).toBe(true)
})
it('fences an older list response so it cannot roll back the pin saved by a completed write',async()=>{
  remoteNavigation.update([workspace])
  let old!:(value:Response)=>void,reads=0
  vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{
    if(options?.method==='POST')return reply({ok:true})
    if(++reads===1)return new Promise<Response>(resolve=>{old=resolve})
    return reply(catalog(true))
  }))
  const pending=remoteNavigation.refresh(workspace)
  await mutateRemoteSession(workspace,'same','pin')
  old(reply(catalog(false)));await pending
  expect(remoteNavigation.getSnapshot().catalogs.get(workspace.id)?.sessions[0]?.pinned).toBe(true)
})
it('holds one write across row remounts and rejects a malformed success acknowledgement',async()=>{
  remoteNavigation.update([workspace])
  let finish!:(value:Response)=>void
  const fetch=vi.fn(async(_url:unknown,options?:RequestInit)=>options?.method==='POST'?new Promise<Response>(resolve=>{finish=resolve}):reply(catalog()))
  vi.stubGlobal('fetch',fetch)
  const first=mutateRemoteSession(workspace,'same','pin'),failed=expect(first).rejects.toThrow()
  await expect(mutateRemoteSession(workspace,'same','archive')).rejects.toThrow()
  finish(reply({unrelated:true}));await failed
  expect(fetch.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1)
})
it.each([false,true])('requests stopActivity only after an explicit active-session refusal and confirmation=%s',async confirmed=>{
  remoteNavigation.update([workspace]);const confirm=vi.spyOn(window,'confirm').mockReturnValue(confirmed)
  let writes=0
  const fetch=vi.fn(async(_url:unknown,options?:RequestInit)=>{
    if(options?.method!=='POST')return reply(catalog())
    if(++writes===1)return {ok:false,json:async()=>({errorCode:'workspace/session-active'})} as Response
    return reply({ok:true})
  });vi.stubGlobal('fetch',fetch)
  expect(await archiveRemoteSession(workspace,'same')).toBe(confirmed)
  expect(confirm).toHaveBeenCalledOnce()
  const dispatched=fetch.mock.calls.filter(([,options])=>options?.method==='POST').map(([,options])=>JSON.parse(String(options!.body)))
  expect(dispatched[0]).not.toHaveProperty('stopActivity')
  expect(dispatched).toHaveLength(confirmed?2:1)
  if(confirmed)expect(dispatched[1]).toHaveProperty('stopActivity',true)
})
it('does not offer stop-and-archive after an unknown transport outcome',async()=>{
  remoteNavigation.update([workspace]);const confirm=vi.spyOn(window,'confirm').mockReturnValue(true)
  vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{if(options?.method==='POST')throw Error('unknown outcome');return reply(catalog())}))
  await expect(archiveRemoteSession(workspace,'same')).rejects.toThrow('unknown outcome')
  expect(confirm).not.toHaveBeenCalled()
})
it('does not archive the displayed Session if saving its unsent draft fails',async()=>{
  remoteNavigation.update([workspace]);selectRemoteView({workspaceId:workspace.id,sessionId:'same'})
  const release=registerRemotePresentation({open:async()=>{},resume:()=>false,beforeLeave:async()=>{throw Error('Generated draft not saved')}})
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch)
  try{await expect(archiveRemoteSession(workspace,'same')).rejects.toThrow('draft not saved');expect(fetch).not.toHaveBeenCalled()}
  finally{release()}
})
