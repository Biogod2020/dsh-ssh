// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { remoteNavigation } from '../src/client/remote-navigation.ts'
import { archiveRemoteSession, forkRemoteSession, mutateRemoteSession } from '../src/client/remote-session-action.ts'
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
it('keeps a confirmed activity refusal as one request and delegates confirmation to the native overlay',async()=>{
  remoteNavigation.update([workspace]);const confirm=vi.spyOn(window,'confirm').mockReturnValue(true)
  const fetch=vi.fn(async(_url:unknown,options?:RequestInit)=>options?.method==='POST'
    ?({ok:false,json:async()=>({errorCode:'workspace/session-active',activity:[{kind:'turn'}]})} as Response):reply(catalog()))
  vi.stubGlobal('fetch',fetch)
  await expect(archiveRemoteSession(workspace,'same')).rejects.toMatchObject({errorCode:'workspace/session-active',activity:[{kind:'turn'}]})
  expect(confirm).not.toHaveBeenCalled();expect(fetch.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1)
})
it('sends stopActivity only as an explicitly requested archive operation',async()=>{
  remoteNavigation.update([workspace])
  const fetch=vi.fn(async(_url:unknown,options?:RequestInit)=>reply(options?.method==='POST'?{ok:true}:catalog()))
  vi.stubGlobal('fetch',fetch);await archiveRemoteSession(workspace,'same',true)
  const writes=fetch.mock.calls.filter(([,options])=>options?.method==='POST')
  expect(writes).toHaveLength(1);expect(JSON.parse(String(writes[0]![1]!.body))).toHaveProperty('stopActivity',true)
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
it('forks once, refreshes the list, and returns the acknowledged real child id',async()=>{
  remoteNavigation.update([workspace])
  const fetch=vi.fn(async(_url:unknown,options?:RequestInit)=>reply(options?.method==='POST'?{ok:true,sessionId:'child'}:catalog()))
  vi.stubGlobal('fetch',fetch)
  expect(await forkRemoteSession(workspace,'same','Generated')).toEqual({sessionId:'child'})
  const writes=fetch.mock.calls.filter(([,options])=>options?.method==='POST')
  expect(writes).toHaveLength(1)
  expect(JSON.parse(String(writes[0]![1]!.body))).toEqual({id:workspace.id,expectedHostId:workspace.hostId,sessionId:'same',action:'fork',title:'Generated'})
})
it('does not send an empty projected title for an otherwise valid unnamed source',async()=>{
  remoteNavigation.update([workspace])
  const fetch=vi.fn(async(_url:unknown,options?:RequestInit)=>reply(options?.method==='POST'?{ok:true,sessionId:'child'}:catalog()))
  vi.stubGlobal('fetch',fetch)
  expect(await forkRemoteSession(workspace,'same','')).toEqual({sessionId:'child'})
  const post=fetch.mock.calls.find(([,options])=>options?.method==='POST')!
  expect(JSON.parse(String(post[1]!.body))).not.toHaveProperty('title')
})
it('does not retry a fork with a lost acknowledgement or fork while a draft cannot be saved',async()=>{
  remoteNavigation.update([workspace])
  const fetch=vi.fn(async(_url:unknown,options?:RequestInit)=>{if(options?.method==='POST')throw Error('Generated lost fork reply');return reply(catalog())})
  vi.stubGlobal('fetch',fetch)
  await expect(forkRemoteSession(workspace,'same')).rejects.toThrow('lost fork reply')
  expect(fetch.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1)
  const release=registerRemotePresentation({open:async()=>{},resume:()=>false,beforeLeave:async()=>{throw Error('Generated unsaved')}})
  try{await expect(forkRemoteSession(workspace,'same')).rejects.toThrow('unsaved');expect(fetch.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1)}finally{release()}
})
