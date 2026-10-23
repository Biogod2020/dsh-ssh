// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { draftClient, seedDraft } from '../src/remote/draft-client.ts'
import { createDraftReplica, type DraftInput } from '../src/remote/draft-replica.ts'
import type { SavedDraft } from '../src/remote/draft-store.ts'
let root: Root | undefined
const hostId='a'.repeat(24),sessionId='one'
const doc=(text:string):SavedDraft=>({version:1,hostId,sessionId,text,revision:randomUUID(),operationId:randomUUID(),hadReferences:false,hadAttachments:false,savedAt:Date.now()})
beforeEach(()=>{
  document.documentElement.lang='en'
  Object.assign(HTMLDialogElement.prototype,{
    showModal(this:HTMLDialogElement){this.setAttribute('open','')},
    close(this:HTMLDialogElement){this.removeAttribute('open');this.dispatchEvent(new Event('close'))},
  })
})
afterEach(async()=>{
  if(root)await act(async()=>{root!.unmount()});root=undefined
  window.dispatchEvent(new Event('pagehide'))
  delete(window as any).__dshSshDraftOwner;delete(window as any).__dshSshDrafts;delete(window as any).__dshSshDraftSeeds
  localStorage.clear();vi.unstubAllGlobals();vi.restoreAllMocks();document.body.replaceChildren()
})
function fixture(initial?:SavedDraft){
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  let registration:any,Entry:React.ComponentType<{sessionId:string}>,saved=initial
  let input:DraftInput={draft:'',draftRev:0,phase:'plain',attachmentIds:[],occurrences:[]}
  const listeners=new Set<()=>void>(),cleanups:Array<()=>void>=[]
  let intercept:((body:any)=>Promise<void>)|undefined,failReads=0
  vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
    if(init?.method==='PUT'){
      const body=JSON.parse(String(init.body));await intercept?.(body)
      if((saved?.revision??null)!==body.expectedRevision)return{ok:false,status:409,json:async()=>({})}
      saved={...doc(body.text),operationId:body.operationId,hadReferences:body.hadReferences,hadAttachments:body.hadAttachments}
    }else if(failReads){failReads--;throw new Error('Generated failed readback')}
    return{ok:true,status:200,json:async()=>({draft:url.endsWith('sessionId='+sessionId)?saved:undefined})}
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
    async mount(strict=false){root=createRoot(container);await act(async()=>{const entry=React.createElement(Entry!,{sessionId});root!.render(strict?React.createElement(React.StrictMode,null,entry):entry)})},
    async unmount(){await act(async()=>{root!.unmount()});root=undefined},
    async update(text:string){await act(async()=>{update(text)})},
    async flush(expected=true){await act(async()=>{expect(await api.flush()).toBe(expected)})},
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
  await f.update('Generated newer different text');await f.flush(false);expect(f.api.inspection().failedUnmountSaves).toBe(1)
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
  await act(async()=>{expect(f.api.openRecovery()).toBe(true)})
  expect(document.querySelector('dialog')!.textContent).toContain('clearing the saved text was not confirmed')
  expect(document.querySelector('dialog textarea')!.getAttribute('readonly')).not.toBeNull()
  expect([...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(node=>node.textContent==='Copy text')!.disabled).toBe(true)
  await act(async()=>{document.querySelector<HTMLDialogElement>('dialog')!.close()})
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
  await f.mount();await vi.waitFor(()=>expect(f.api.inspection().sessions[0]?.status).toBe('unsaved'))
  // A newer input can autosave while the old request is pending. The full
  // view-close check now correctly waits for that old retirement as well.
  await act(async()=>{await vi.waitFor(()=>expect(f.saved?.text).toBe('Generated same desired text'))});await f.unmount()
  expect(f.saved!.text).toBe('Generated same desired text');expect(f.api.inspection().sessions).toEqual([])
  release();await vi.waitFor(()=>expect(f.api.inspection()).toMatchObject({pendingUnmountSaves:0,failedUnmountSaves:0}))
})

async function retainedFixture(text='Generated retained 中文 🙂 <img src=x onerror=alert(1)>'){
  const f=fixture();let first=true
  f.intercept(async()=>{if(first){first=false;throw Error('Generated unconfirmed save')}})
  await f.mount();await vi.waitFor(()=>expect(f.api.inspection().sessions[0]?.persisted).toBe(true))
  await f.update(text);await f.unmount()
  await vi.waitFor(()=>expect(f.api.inspection()).toMatchObject({pendingUnmountSaves:0,failedUnmountSaves:1}))
  await f.update('');await f.mount();await vi.waitFor(()=>expect(f.api.inspection().sessions[0]?.persisted).toBe(true))
  return f
}
const recoveryButton=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(node=>node.textContent===label)!
it('blocks view disposal while a retired save is pending and after its result remains unknown',async()=>{
  const f=fixture();let release!:()=>void,began!:()=>void
  const started=new Promise<void>(resolve=>{began=resolve})
  f.intercept(async()=>{began();await new Promise<void>(resolve=>{release=resolve});throw Error('Generated unconfirmed save')})
  await f.mount();await vi.waitFor(()=>expect(f.api.inspection().sessions[0]?.persisted).toBe(true))
  await f.update('Generated pending retired text');await f.unmount();await started
  let settled=false;const leaving=f.api.flush().then((ok:boolean)=>{settled=true;return ok})
  await Promise.resolve();await Promise.resolve();expect(settled).toBe(false)
  release();expect(await leaving).toBe(false);expect(f.api.inspection().failedUnmountSaves).toBe(1)
  expect(vi.mocked(fetch).mock.calls.filter(([,init])=>init?.method==='PUT')).toHaveLength(1)
})
it('opens retained text locally, copies it without clearing protection and keeps same-view navigation available',async()=>{
  const text='Generated retained 中文 🙂 <img src=x onerror=alert(1)>',f=await retainedFixture(text)
  const copy=vi.fn(async()=>{});Object.defineProperty(navigator,'clipboard',{value:{writeText:copy},configurable:true})
  const requests=vi.mocked(fetch).mock.calls.length
  await act(async()=>{f.container.querySelector<HTMLButtonElement>('button')!.click()})
  expect(document.querySelector<HTMLTextAreaElement>('dialog textarea')!.value).toBe(text)
  expect(document.querySelector('dialog img')).toBeNull();expect(vi.mocked(fetch).mock.calls).toHaveLength(requests)
  await act(async()=>{recoveryButton('Copy text').click()})
  expect(copy).toHaveBeenCalledWith(text);expect(document.querySelector('dialog')!.textContent).toContain('does not confirm it is saved on disk')
  expect(f.api.inspection().failedUnmountSaves).toBe(1);await f.flush(false)
  await act(async()=>{await f.api.prepare('other')})
  expect(f.api.inspection().failedUnmountSaves).toBe(1)
  expect(JSON.stringify(f.api.inspection())).not.toContain(text)
})
it('requires explicit discard confirmation and never changes a newer editor or its saved draft',async()=>{
  const f=await retainedFixture('Generated older unconfirmed text')
  await f.update('Generated newer input');await f.flush(false)
  const saved={...f.saved!},confirm=vi.spyOn(window,'confirm').mockReturnValue(false)
  await act(async()=>{f.api.openRecovery()})
  const requests=vi.mocked(fetch).mock.calls.length
  await act(async()=>{recoveryButton('Discard this retained input').click()})
  expect(f.api.inspection().failedUnmountSaves).toBe(1)
  expect(document.querySelector('dialog')!.textContent).toContain('current input and the draft on disk will stay unchanged')
  expect(document.activeElement).toBe(recoveryButton('Cancel'))
  await act(async()=>{recoveryButton('Cancel').click()})
  expect(f.api.inspection().failedUnmountSaves).toBe(1)
  expect(document.activeElement).toBe(recoveryButton('Discard this retained input'))
  await act(async()=>{recoveryButton('Discard this retained input').click()})
  await act(async()=>{recoveryButton('Confirm discard').click()})
  expect(confirm).not.toHaveBeenCalled();expect(f.api.inspection().failedUnmountSaves).toBe(0)
  expect(f.input.draft).toBe('Generated newer input');expect(f.saved).toEqual(saved)
  expect(vi.mocked(fetch).mock.calls).toHaveLength(requests)
  await f.flush();expect(document.querySelector('dialog')!.textContent).toContain('No retained unsaved inputs remain')
})
it('leaves text selectable after a clipboard failure and fences a late copy result from a reopened dialog',async()=>{
  const f=await retainedFixture('Generated selectable recovery text')
  let resolve! :()=>void
  const copy=vi.fn().mockRejectedValueOnce(Error('Generated denied copy')).mockImplementationOnce(()=>new Promise<void>(done=>{resolve=done}))
  Object.defineProperty(navigator,'clipboard',{value:{writeText:copy},configurable:true})
  await act(async()=>{f.api.openRecovery();recoveryButton('Copy text').click()})
  const text=document.querySelector<HTMLTextAreaElement>('dialog textarea')!
  expect(document.activeElement).toBe(text);expect(text.selectionEnd).toBe(text.value.length)
  expect(document.querySelector('dialog')!.textContent).toContain('copy it manually')
  await act(async()=>{recoveryButton('Copy text').click()})
  await act(async()=>{document.querySelector<HTMLDialogElement>('dialog')!.close();f.api.openRecovery()})
  await act(async()=>{resolve()})
  expect(document.querySelector('dialog')!.textContent).not.toContain('Text copied')
  expect(f.api.inspection().failedUnmountSaves).toBe(1)
})
it('removes a recovered failure after actual autosave settles without requiring an inspection or another manual flush',async()=>{
  const value='Generated matching recovery',f=await retainedFixture(value)
  expect(f.container.textContent).toContain('Review unsaved drafts')
  await f.update(value)
  await act(async()=>{await vi.waitFor(()=>expect(f.saved?.text).toBe(value))})
  expect(f.container.textContent).not.toContain('Review unsaved drafts')
  expect(f.api.inspection().failedUnmountSaves).toBe(0)
})
it('keeps the same memoized Replica live across StrictMode effect release and reacquisition',async()=>{
  const f=fixture();await f.mount(true)
  await vi.waitFor(()=>expect(f.api.inspection()).toMatchObject({pendingUnmountSaves:0,failedUnmountSaves:0,sessions:[{persisted:true}]}))
  await f.update('Generated StrictMode edit')
  await act(async()=>{await vi.waitFor(()=>expect(f.saved?.text).toBe('Generated StrictMode edit'))})
  expect(f.api.inspection()).toMatchObject({pendingUnmountSaves:0,failedUnmountSaves:0,sessions:[{persisted:true}]})
  await f.flush()
})
it('pages separate retained inputs and discards only the explicitly selected one',async()=>{
  const f=await retainedFixture('Generated first retained input')
  f.intercept(async()=>{throw Error('Generated second failure')})
  await f.update('Generated second retained input');await f.unmount()
  await vi.waitFor(()=>expect(f.api.inspection().failedUnmountSaves).toBe(2))
  await f.update('');await f.mount();await vi.waitFor(()=>expect(f.api.inspection().sessions[0]?.persisted).toBe(true))
  await act(async()=>{f.api.openRecovery()})
  expect(document.querySelector<HTMLTextAreaElement>('dialog textarea')!.value).toBe('Generated first retained input')
  await act(async()=>{recoveryButton('Next draft').click()})
  expect(document.querySelector<HTMLTextAreaElement>('dialog textarea')!.value).toBe('Generated second retained input')
  await act(async()=>{recoveryButton('Discard this retained input').click()})
  await act(async()=>{recoveryButton('Confirm discard').click()})
  expect(f.api.inspection().failedUnmountSaves).toBe(1)
  expect(document.querySelector<HTMLTextAreaElement>('dialog textarea')!.value).toBe('Generated first retained input')
  expect(f.input.draft).toBe('');expect(f.saved).toBeUndefined()
})
