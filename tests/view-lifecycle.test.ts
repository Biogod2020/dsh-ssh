// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { viewLifecycle } from '../src/remote/view-lifecycle.ts'

afterEach(()=>{vi.unstubAllGlobals();document.body.replaceChildren();delete (window as any).__dshSshView;delete (window as any).__dshSshDrafts;delete (window as any).__dshSshOperations;delete (window as any).__dshSshRelease})
function fixture(){
  const state={sidebar:{terminals:0,tabs:0},drafts:{pendingUnmountSaves:0,failedUnmountSaves:0,sessions:[{status:'saved',persisted:true,inputPhase:'plain',hasReferences:false,hasAttachments:false}]}}
  const operations={freeze:vi.fn(async()=> 'operation-owner'),thaw:vi.fn(),commit:vi.fn(()=>true)}
  const drafts={flush:vi.fn(async()=>true)}
  Object.assign(window,{__dshSshView:{inspection:()=>state,cancelNavigation:vi.fn()},__dshSshDrafts:drafts,__dshSshOperations:operations})
  const calls:string[]=[]
  vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{const body=JSON.parse(options.body);calls.push(body.action);return Response.json({ok:true,token:'gateway-owner'})}))
  viewLifecycle('http://localhost:8765')
  return {state,operations,drafts,calls,api:(window as any).__dshSshRelease}
}
it('flushes drafts and freezes both owners before allowing release',async()=>{
  const f=fixture(),prepared=await f.api.prepare()
  expect(prepared.token).toBeTruthy();expect(f.calls).toEqual(['freeze']);expect(f.operations.freeze).toHaveBeenCalledOnce()
  expect(await f.api.commit('different-owner')).toBe(false)
  expect(await f.api.commit(prepared.token)).toBe(true);expect(f.calls).toEqual(['freeze','check'])
})
it('keeps terminals, attachments and unconfirmed saves without freezing the gateway',async()=>{
  const f=fixture();f.state.sidebar.terminals=1
  expect(await f.api.prepare()).toBeNull()
  f.state.sidebar.terminals=0;f.state.drafts.sessions[0]!.hasAttachments=true
  expect(await f.api.prepare()).toBeNull()
  f.state.drafts.sessions[0]!.hasAttachments=false;f.drafts.flush.mockResolvedValue(false)
  expect(await f.api.prepare()).toBeNull();expect(f.calls).toEqual([])
})
it('rechecks draft ownership at commit and thaws a cancelled release',async()=>{
  const f=fixture(),prepared=await f.api.prepare()
  f.state.drafts.failedUnmountSaves=1
  expect(await f.api.commit(prepared.token)).toBe(false);expect(f.operations.commit).not.toHaveBeenCalled()
  await f.api.cancel();expect(f.operations.thaw).toHaveBeenCalledWith('operation-owner');expect(f.calls).toEqual(['freeze','thaw'])
})
it('releases the gateway freeze when a pending operation prevents client quiescence',async()=>{
  const f=fixture();f.operations.freeze.mockResolvedValue(null as any)
  expect(await f.api.prepare()).toBeNull();expect(f.calls).toEqual(['freeze','thaw'])
})
it('honors cancellation while preparation is awaiting the client barrier',async()=>{
  const f=fixture();let finish!:(value:string)=>void,reached!:()=>void
  const entered=new Promise<void>(resolve=>{reached=resolve})
  f.operations.freeze.mockImplementation(()=>{reached();return new Promise(resolve=>{finish=resolve})})
  const preparing=f.api.prepare();await entered;await f.api.cancel();finish('late-operation-owner')
  expect(await preparing).toBeNull();expect(f.operations.thaw).toHaveBeenCalledWith('late-operation-owner')
  expect(f.calls).toEqual(['freeze','thaw'])
})
it('never thaws an already committed operation',async()=>{
  const f=fixture(),prepared=await f.api.prepare();expect(await f.api.commit(prepared.token)).toBe(true)
  await f.api.cancel();expect(f.operations.thaw).not.toHaveBeenCalled();expect(f.calls).toEqual(['freeze','check'])
})

it('reports a failed core script during boot but keeps an already usable conversation ready', async () => {
  const f = fixture(), script = document.createElement('script'); script.src = '/assets/vendor-abcdefgh.js'; document.head.append(script)
  script.dispatchEvent(new Event('error'))
  await expect(f.api.command('ready')).rejects.toMatchObject({ code: 'boot/assets-failed' })
  document.body.innerHTML = '<div id="root"><main class="fixture_centerCol"></main></div>'
  expect(await f.api.command('ready')).toBe(true)
  script.remove()
})
