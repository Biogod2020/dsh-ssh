// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createOperationLedger } from '../src/remote/operation-ledger.ts'
import { operationTransport, operationClient } from '../src/remote/operation-client.ts'
import { Context } from '@deepseek-ai/cordis'
import { createRemoteOperationObserver } from '../src/remote/operation-streams.ts'

const target=window as any
afterEach(()=>{window.dispatchEvent(new Event('pagehide'));vi.restoreAllMocks();vi.unstubAllGlobals();
  for(const name of ['__DSH_TRANSPORT__','__dshSshOperations','__dshSshView','__ModuleLoader__','__dshSshOperationOwner'])delete target[name]})
function fixture(){
  const send=vi.fn(), originalSocket=WebSocket;vi.stubGlobal('fetch',send)
  target.__dshSshView={state:()=>({sessionId:'generated-session'})}
  new Function(`(${operationTransport.toString()})('aaaaaaaaaaaaaaaaaaaaaaaa',(${createOperationLedger.toString()}),(${createRemoteOperationObserver.toString()}));`)()
  const api=target.__dshSshOperations, transport=target.__DSH_TRANSPORT__
  const rpc={async call(_channel:unknown,endpoint:unknown,payload:unknown){
    if(endpoint==='local-rejection')throw Error('Generated preflight rejection')
    const response=await transport.fetch('/api/'+endpoint,{method:'POST',body:JSON.stringify(payload)})
    if(!response.ok)throw Error('Generated transport failure')
    return response.json()
  }}
  return{send,api,transport,rpc,originalSocket}
}
it('observes a full unary Promise without patching global transports or claiming full page coverage',async()=>{
  const f=fixture(),original=f.rpc.call,stop=f.api.attach(f.rpc)
  let finish!:(value:object)=>void,reading!:()=>void
  const reached=new Promise<void>(resolve=>{reading=resolve})
  f.send.mockImplementation(async()=>({ok:true,json:()=>{reading();return new Promise(resolve=>{finish=resolve})}}))
  const payload={args:{text:'Generated private request content'}}
  const pending=f.rpc.call('/api','session/prompt',payload);await reached
  expect(f.api.inspection()).toMatchObject({fullCoverage:false,automaticReleaseEligible:false,pendingRequests:null,
    unary:{observedPendingRequests:1,rpcDecoratorAttached:true,scopedFetchObserved:true}})
  expect(JSON.stringify(f.api.inspection())).not.toContain(payload.args.text)
  expect(fetch).toBe(f.send);expect(WebSocket).toBe(f.originalSocket)
  finish({ok:true,value:'generated-result'});expect(await pending).toEqual({ok:true,value:'generated-result'})
  expect(f.api.inspection().unary.observedPendingRequests).toBe(0)
  expect(f.send.mock.calls[0][1].body).toBe(JSON.stringify(payload))
  expect(f.api.freeze).toBeUndefined();stop();expect(f.rpc.call).toBe(original)
})
it('preserves preflight and transport rejection without issuing a retry',async()=>{
  const f=fixture();f.api.attach(f.rpc)
  await expect(f.rpc.call('/api','local-rejection',{})).rejects.toThrow('preflight')
  expect(f.send).not.toHaveBeenCalled();expect(f.api.inspection().unary.observedPendingRequests).toBe(0)
  const lost=Error('Generated lost acknowledgement');f.send.mockRejectedValue(lost)
  await expect(f.rpc.call('/api','session/cancel',{})).rejects.toBe(lost)
  expect(f.send).toHaveBeenCalledOnce();expect(f.api.inspection().unary.observedPendingRequests).toBe(0)
  expect(f.api.inspection().unconfirmedOperations).toBeNull()
})
it('keeps a deferred custom caller working and reports the missing synchronous correlation as partial',async()=>{
  const f=fixture();f.rpc.call=async(_channel,endpoint,payload)=>{
    await Promise.resolve();const response=await f.transport.fetch('/api/'+endpoint,{method:'POST',body:JSON.stringify(payload)});return response.json()
  }
  f.api.attach(f.rpc);f.send.mockImplementation(async()=>new Response('{"ok":true}',{headers:{'content-type':'application/json'}}))
  const values=await Promise.all([f.rpc.call('/api','session/list',{}),f.rpc.call('/api','terminal/list',{})])
  expect(values).toEqual([{ok:true},{ok:true}]);expect(f.send).toHaveBeenCalledTimes(2)
  await new Promise(resolve=>setTimeout(resolve,0))
  expect(f.api.inspection()).toMatchObject({fullCoverage:false,pendingRequests:null,unary:{observedPendingRequests:0,rpcDecoratorAttached:false}})
})
it('tracks a startup JSON body without calling its consumption a confirmed SDK result',async()=>{
  const f=fixture();let finish!:(value:object)=>void
  const response={ok:true,headers:new Headers({'content-type':'application/json'}),json:()=>new Promise(resolve=>{finish=resolve})}
  f.send.mockResolvedValue(response)
  const received=await f.transport.fetch('/api/session/list',{method:'POST',body:'{}'})
  expect(f.api.inspection().unary.observedPendingRequests).toBe(1)
  const consuming=received.json();finish({generated:true});expect(await consuming).toEqual({generated:true})
  await new Promise(resolve=>setTimeout(resolve,0))
  expect(f.api.inspection()).toMatchObject({fullCoverage:false,pendingRequests:null,unconfirmedOperations:null,unary:{observedPendingRequests:0}})
})
it('does not mistake unbound multipart metadata for finished SDK binary decoding',async()=>{
  const f=fixture(),response={ok:true,headers:new Headers({'content-type':'multipart/form-data; boundary=fixture'}),formData:async()=>new FormData()}
  f.send.mockResolvedValue(response);await f.transport.fetch('/api/files/read',{method:'POST',body:'{}'});await response.formData()
  expect(f.api.inspection().unary.observedPendingRequests).toBe(1)
  expect(f.api.inspection().automaticReleaseEligible).toBe(false)
})
it('ends startup JSON observations after text/clone consumption while preserving Response receiver semantics',async()=>{
  const f=fixture(),response=new Response('{"generated":true}',{headers:{'content-type':'application/json'}})
  f.send.mockResolvedValue(response);const received=await f.transport.fetch('/api/session/list')
  const other=new Response('other'),borrowed=received.text
  expect(await borrowed.call(other)).toBe('other');await new Promise(resolve=>setTimeout(resolve,0))
  expect(f.api.inspection().unary.observedPendingRequests).toBe(1)
  expect(await received.clone().text()).toBe('{"generated":true}')
  await new Promise(resolve=>setTimeout(resolve,0));expect(f.api.inspection().unary.observedPendingRequests).toBe(0)
  expect(await received.json()).toEqual({generated:true});await new Promise(resolve=>setTimeout(resolve,0))
  expect(f.api.inspection().unary.observedPendingRequests).toBe(0)
})
it('fences stale cleanup and preserves a later public RPC or transport replacement',()=>{
  const f=fixture(),first=f.rpc.call,stop=f.api.attach(f.rpc),second={call:async()=>({ok:true})}
  const stopSecond=f.api.attach(second),observed=second.call
  expect(f.rpc.call).toBe(first);stop();expect(second.call).toBe(observed)
  const replacement=async()=>({ok:false});second.call=replacement;stopSecond();expect(second.call).toBe(replacement)
  f.api.attach(f.rpc);const other={fetch:async()=>new Response()};target.__DSH_TRANSPORT__=other
  expect(f.api.inspection().unary.rpcDecoratorAttached).toBe(false)
  expect(target.__DSH_TRANSPORT__).toBe(other)
})
it('leaves custom RPC/fetch/worker stream composition and accessors untouched',()=>{
  const f=fixture();delete target.__dshSshOperations;delete target.__DSH_TRANSPORT__
  const read=vi.fn(()=>{throw Error('Getter must not run')}),base={}
  Object.defineProperty(base,'fetch',{get:read,enumerable:true});target.__DSH_TRANSPORT__=base
  operationTransport('a'.repeat(24),createOperationLedger)
  expect(read).not.toHaveBeenCalled();expect(target.__DSH_TRANSPORT__).toBe(base)
  const original=f.rpc.call;target.__dshSshOperations.attach(f.rpc);expect(f.rpc.call).toBe(original)
  expect(target.__dshSshOperations.inspection().unary.rpcDecoratorAttached).toBe(false)
})
it('owns its binding through a page fiber instead of replacing a Context service',()=>{
  const f=fixture(),modules:any[]=[],cleanup:(()=>void)[]=[],original=f.rpc.call
  target.__ModuleLoader__={load:(module:unknown)=>modules.push(module)}
  new Function(`(${operationClient.toString()})();`)()
  const scoped={get:(name:string)=>name==='connection'?{rpc:f.rpc}:undefined,effect:(fn:()=>()=>void)=>cleanup.push(fn())}
  const owner={dispose:()=>cleanup.splice(0).forEach(fn=>fn())}
  const ctx={...scoped,root:{inject:(deps:string[],apply:(ctx:unknown)=>void)=>{expect([['connection'],['remote']]).toContainEqual(deps);apply(scoped);return owner}}}
  modules[0].factory().apply(ctx);expect(f.rpc.call).not.toBe(original)
  window.dispatchEvent(new Event('pagehide'));expect(f.rpc.call).toBe(original)
  expect(fetch).toBe(f.send)
  expect(target.__dshSshOperationOwner).toBeUndefined()
})
it('rebinds a replacement root and does not let stale root cleanup erase the new owner',()=>{
  const f=fixture(),modules:any[]=[],roots:(()=>void)[]=[]
  target.__ModuleLoader__={load:(module:unknown)=>modules.push(module)};operationClient()
  const make=(rpc:object)=>{
    const cleanup:(()=>void)[]=[],scoped={get:()=>({rpc}),effect:(fn:()=>()=>void)=>cleanup.push(fn())}
    return{...scoped,root:{inject:(_deps:string[],apply:(ctx:unknown)=>void)=>{apply(scoped);return{dispose:()=>cleanup.splice(0).forEach(fn=>fn())}},effect:(fn:()=>()=>void)=>roots.push(fn())}}
  }
  const first=make(f.rpc),original=f.rpc.call;modules[0].factory().apply(first)
  const secondRpc={call:async()=>({ok:true})},second=make(secondRpc),secondOriginal=secondRpc.call
  modules[0].factory().apply(second);expect(f.rpc.call).toBe(original);expect(secondRpc.call).not.toBe(secondOriginal)
  roots[0]();expect(target.__dshSshOperationOwner.root).toBe(second.root);expect(secondRpc.call).not.toBe(secondOriginal)
  roots[1]();expect(target.__dshSshOperationOwner).toBeUndefined();expect(secondRpc.call).toBe(secondOriginal)
})
it('survives entry disposal in real Cordis and releases its RPC binding with the root Context',async()=>{
  const f=fixture(),modules:any[]=[],ctx=new Context(),original=f.rpc.call
  target.__ModuleLoader__={load:(module:unknown)=>modules.push(module)};operationClient()
  ;(ctx as any).provide('connection',{rpc:f.rpc})
  try{
    const entry=await ctx.plugin(modules[0].factory())
    await vi.waitFor(()=>expect(f.rpc.call).not.toBe(original))
    await entry.dispose()
    expect(f.rpc.call).not.toBe(original)
    expect(target.__dshSshOperationOwner.root).toBe(ctx.root)
  }finally{await ctx.fiber.dispose()}
  expect(f.rpc.call).toBe(original);expect(target.__dshSshOperationOwner).toBeUndefined()
})
it('preserves a custom worker transport Remote as well as its RPC composition',()=>{
  fixture();delete target.__dshSshOperations
  const base={openStream:async function*(){yield 'generated-worker-item'}},remote={openRemoteStream:()=>base.openStream(),events:{answer:async()=>{}}}
  const stream=remote.openRemoteStream,answer=remote.events.answer
  target.__DSH_TRANSPORT__=base;operationTransport('a'.repeat(24),createOperationLedger,createRemoteOperationObserver)
  const stop=target.__dshSshOperations.attachRemote(remote)
  expect(target.__DSH_TRANSPORT__).toBe(base);expect(remote.openRemoteStream).toBe(stream);expect(remote.events.answer).toBe(answer)
  expect(target.__dshSshOperations.inspection().logical.streamDecoratorAttached).toBe(false);stop()
})
