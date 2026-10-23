// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { draftClient, seedDraft } from '../src/remote/draft-client.ts'
import { createDraftReplica, type DraftInput } from '../src/remote/draft-replica.ts'
import type { SavedDraft } from '../src/remote/draft-store.ts'
let root: Root | undefined
const hostId='a'.repeat(24),sessionId='one'
const doc=(text:string):SavedDraft=>({version:1,hostId,sessionId,text,revision:randomUUID(),operationId:randomUUID(),hadReferences:false,hadAttachments:false,savedAt:Date.now()})
afterEach(async()=>{
  if(root)await act(async()=>{root!.unmount()});root=undefined
  window.dispatchEvent(new Event('pagehide'))
  delete(window as any).__dshSshDraftOwner;delete(window as any).__dshSshDrafts;delete(window as any).__dshSshDraftSeeds
  localStorage.clear();vi.unstubAllGlobals();document.body.replaceChildren()
})
function fixture(initial?:SavedDraft){
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  let registration:any,Entry:React.ComponentType<{sessionId:string}>,saved=initial
  let input:DraftInput={draft:'',draftRev:0,phase:'plain',attachmentIds:[],occurrences:[]}
  const listeners=new Set<()=>void>(),cleanups:Array<()=>void>=[]
  let intercept:((body:any)=>Promise<void>)|undefined,failReads=0
  vi.stubGlobal('fetch',vi.fn(async(_url:string,init?:RequestInit)=>{
    if(init?.method==='PUT'){
      const body=JSON.parse(String(init.body));await intercept?.(body)
      if((saved?.revision??null)!==body.expectedRevision)return{ok:false,status:409,json:async()=>({})}
      saved={...doc(body.text),operationId:body.operationId,hadReferences:body.hadReferences,hadAttachments:body.hadAttachments}
    }else if(failReads){failReads--;throw new Error('Generated failed readback')}
    return{ok:true,status:200,json:async()=>({draft:saved})}
  }))
  const update=(draft:string)=>{input={...input,draft,draftRev:input.draftRev+1};for(const listener of listeners)listener()}
  const face={state:{getSnapshot:()=>input,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn)}},setDraft:update}
  const ctx:any={slots:{inject:(_name:string,apply:()=>()=>void)=>apply(),register:(_options:object,component:any)=>{Entry=component;return()=>{}}},
    sessions:{scope:(id:string)=>id},get:(name:string)=>name==='conversation'?{input:{for:()=>face}}:undefined,
    effect:(fn:()=>()=>void)=>cleanups.push(fn())}
  ctx.root={inject:(_deps:string[],apply:(value:unknown)=>void)=>{apply(ctx);return{dispose:()=>{for(const cleanup of cleanups.splice(0))cleanup()}}}}
  vi.stubGlobal('__ModuleLoader__',{load:(value:any)=>{registration=value}})
  draftClient(hostId,createDraftReplica,seedDraft);registration.factory((name:string)=>{expect(name).toBe('react');return React}).apply(ctx)
  const api=(window as any).__dshSshDrafts,container=document.createElement('div');document.body.append(container)
  return {api,container,get input(){return input},get saved(){return saved},
    intercept(fn:(body:any)=>Promise<void>){intercept=fn},failReadbacks(n:number){failReads=n},
    async mount(){root=createRoot(container);await act(async()=>{root!.render(React.createElement(Entry!,{sessionId}))})},
    async unmount(){await act(async()=>{root!.unmount()});root=undefined},
    async update(text:string){await act(async()=>{update(text)})},
    async flush(){await act(async()=>{expect(await api.flush()).toBe(true)})},
  }
}
it('retains pending and failed unmount saves until the same owned text is actually durable, not merely a newer draft',async()=>{
  const f=fixture();let release!:()=>void,began!:()=>void
  const started=new Promise<void>(resolve=>{began=resolve});let fail=true
  f.intercept(async()=>{if(fail){fail=false;began();await new Promise<void>(done=>{release=done});throw new Error('Generated failed save')}})
  await f.mount();await vi.waitFor(()=>expect(f.api.inspection().sessions[0]?.persisted).toBe(true))
  await f.update('Generated retired text');await f.unmount();await started
  expect(f.api.inspection()).toMatchObject({sessions:[],pendingUnmountSaves:1,failedUnmountSaves:0})
  release();await vi.waitFor(()=>expect(f.api.inspection()).toMatchObject({pendingUnmountSaves:0,failedUnmountSaves:1}))
  await f.update('');await f.mount();await vi.waitFor(()=>expect(f.api.inspection().sessions[0]?.persisted).toBe(true))
  expect(f.api.inspection().failedUnmountSaves).toBe(1)
  await f.update('Generated newer different text');await f.flush();expect(f.api.inspection().failedUnmountSaves).toBe(1)
  await f.update('Generated retired text');await f.flush();expect(f.api.inspection().failedUnmountSaves).toBe(0)
  expect(JSON.stringify(f.api.inspection())).not.toContain('Generated retired text')
})
it('consumes an empty boot seed once, reads newer disk data on remount and preserves a failed explicit clear',async()=>{
  const empty=doc(''),f=fixture(empty)
  ;(window as any).__dshSshDraftSeeds=new Map([[sessionId,{hostId,sessionId,draft:empty,nativeBoot:true}]])
  await f.mount();await vi.waitFor(()=>expect(f.api.inspection().sessions[0]?.persisted).toBe(true))
  expect((window as any).__dshSshDraftSeeds.has(sessionId)).toBe(false)
  await f.update('Generated newer saved text');await f.flush()
  let fail=true
  f.intercept(async body=>{if(fail&&!body.text){fail=false;throw new Error('Generated failed clear')}})
  await f.update('');localStorage.setItem('dsh.conversation.'+sessionId,JSON.stringify({draft:''}));await f.unmount()
  await vi.waitFor(()=>expect(f.api.inspection()).toMatchObject({pendingUnmountSaves:0,failedUnmountSaves:1}))
  expect(f.saved!.text).toBe('Generated newer saved text')
  await f.mount();await vi.waitFor(()=>expect(f.api.inspection().sessions[0]?.status).toBe('conflict'))
  expect(f.input.draft).toBe('');expect(f.api.inspection().failedUnmountSaves).toBe(1)
  // The user's explicit conflict choice can then commit the empty tombstone.
  await act(async()=>{f.container.querySelector('button')!.click()});await f.flush()
  expect(f.saved!.text).toBe('');expect(f.api.inspection().failedUnmountSaves).toBe(0)
})
it('reconciles a late failed unmount against current disk after the newer matching controller has also unmounted',async()=>{
  const f=fixture();let release!:()=>void,began!:()=>void,first=true
  const started=new Promise<void>(resolve=>{began=resolve})
  f.intercept(async()=>{if(first){first=false;began();await new Promise<void>(done=>{release=done});f.failReadbacks(1);throw new Error('Generated lost old reply')}})
  await f.mount();await vi.waitFor(()=>expect(f.api.inspection().sessions[0]?.persisted).toBe(true))
  await f.update('Generated same desired text');await f.unmount();await started
  await f.mount();await vi.waitFor(()=>expect(f.api.inspection().sessions[0]?.status).toBe('unsaved'));await f.flush();await f.unmount()
  expect(f.saved!.text).toBe('Generated same desired text');expect(f.api.inspection().sessions).toEqual([])
  release();await vi.waitFor(()=>expect(f.api.inspection()).toMatchObject({pendingUnmountSaves:0,failedUnmountSaves:0}))
})
