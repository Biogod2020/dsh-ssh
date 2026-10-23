/** Execute a served Client contribution in a MOCK public context. This checks
 * serialization and field boundaries; it is not renderer memory or native UI. */
import assert from 'node:assert/strict'
import { Script, createContext } from 'node:vm'
import { webcrypto } from 'node:crypto'

/** Execute the exact served bootstrap and contribution with a MOCK public
 * RPC/Context. The separate actual-SDK probe checks binary/envelope behavior. */
export async function verifyUnaryInspection(html, contribution) {
  const bootstrap=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1])
    .find(source=>source.includes('__dshSshOperations')&&source.includes('automaticReleaseEligible'))
  assert(bootstrap,'Embedded page must compose observation before Client boot')
  const modules=[],cleanups=[]
  const window={__ModuleLoader__:{load:module=>modules.push(module)},addEventListener(){},removeEventListener(){}}
  let finish,started
  const ready=new Promise(resolve=>{started=resolve})
  const fetch=async()=>({ok:true,json(){started();return new Promise(resolve=>{finish=resolve})}})
  const sandbox=createContext({window,crypto:webcrypto,fetch,Date,setTimeout,clearTimeout})
  new Script(bootstrap).runInContext(sandbox,{timeout:1000})
  new Script(contribution).runInContext(sandbox,{timeout:1000})
  assert.equal(modules.length,1);assert.equal(modules[0].id,'@jay-local/dsh-ssh-operations')
  const rpc={async call(){const response=await window.__DSH_TRANSPORT__.fetch('api/session/cancel',{method:'POST',body:'{}'});return response.json()}}
  let finishAnswer
  const answerPending=new Promise(resolve=>{finishAnswer=resolve})
  const remote={openRemoteStream:()=> (async function*(){yield 1})(),events:{answer:async()=>answerPending}}
  const original=rpc.call,originalStream=remote.openRemoteStream,originalAnswer=remote.events.answer
  const ctx={get:name=>name==='connection'?{rpc}:name==='remote'?remote:undefined,effect:fn=>cleanups.push(fn())}
  ctx.root={inject:(_deps,apply)=>{apply(ctx);return{dispose(){for(const cleanup of cleanups.splice(0))cleanup()}}}}
  modules[0].factory().apply(ctx)
  try{
    const pending=rpc.call('/api','session/cancel',{args:{}});await ready
    const before=JSON.parse(JSON.stringify(window.__dshSshOperations.inspection()))
    assert.equal(before.unary.observedPendingRequests,1);assert.equal(before.pendingRequests,null)
    assert.equal(before.fullCoverage,false);assert.equal(before.automaticReleaseEligible,false)
    assert.equal(window.__dshSshOperations.freeze,undefined)
    finish({ok:true,value:{}});assert.equal((await pending).ok,true)
    assert.equal(window.__dshSshOperations.inspection().unary.observedPendingRequests,0)
    assert.equal(window.__dshSshOperations.inspection().unary.scopedFetchObserved,true)
    assert.equal(sandbox.fetch,fetch,'The global transport must remain unchanged')
    const stream=remote.openRemoteStream('$events'),question=remote.events.answer({eventId:'generated-event'},'generated-client')
    assert.equal(window.__dshSshOperations.inspection().logical.observedEventSubscriptions,0)
    assert.equal(window.__dshSshOperations.inspection().logical.observedWaitingAnswers,1)
    await stream.next();assert.equal(window.__dshSshOperations.inspection().logical.observedEventSubscriptions,1)
    await stream.return();finishAnswer();await question
    assert.equal(window.__dshSshOperations.inspection().logical.observedEventSubscriptions,0)
    assert.equal(window.__dshSshOperations.inspection().logical.observedWaitingAnswers,0)
    return{serializedUnaryObservationInMockClient:true,serializedLogicalObservationInMockClient:true,unaryObserverFullViewCoverage:false,logicalObserverFullViewCoverage:false}
  }finally{await window.__dshSshOperationOwner.dispose();assert.equal(rpc.call,original);assert.equal(remote.openRemoteStream,originalStream);assert.equal(remote.events.answer,originalAnswer)}
}

export function verifyViewInspection(source, workspaceId, sessionId) {
  const modules=[],cleanups=[]
  const privateText='Generated private draft excluded from inspection'
  const window={__ModuleLoader__:{load:value=>modules.push(value)},addEventListener(){},removeEventListener(){},
    __dshSshDrafts:{inspection:()=>({pendingUnmountSaves:1,failedUnmountSaves:1,privateText,sessions:[{
      sessionId,status:'saved',revision:3,persisted:true,hasReferences:false,hasAttachments:true,inputPhase:'plain',draft:privateText,
    }]})}}
  const sandbox=createContext({window,performance:{memory:{usedJSHeapSize:123456}},Date,
    document:{documentElement:{setAttribute(){},removeAttribute(){}}},localStorage:{getItem:()=>null},setInterval:()=>1,clearInterval(){}})
  new Script(source).runInContext(sandbox,{timeout:1000})
  assert.equal(modules.length,1);assert.equal(modules[0].id,'@jay-local/dsh-ssh-navigation')
  const ctx={uiWorkspace:{openSession(){throw Error('Inspection must not navigate')}},
    sessions:{list:{getSnapshot:()=>({byId:{[sessionId]:{id:sessionId,retainedBy:{mainView:1}}}})}},
    workspaces:{list:{getSnapshot:()=>({items:[{workspaceId,sessionIds:[sessionId]}]})}},
    get:name=>name==='sidebarRight'?{openTabs:{getSnapshot:()=>[{kind:'terminal',sessionId:'inactive-generated-session'}]}}:undefined,
    effect:fn=>cleanups.push(fn())}
  ctx.root={inject:(_deps,apply)=>{apply(ctx);return{dispose(){for(const cleanup of cleanups.splice(0))cleanup()}}}}
  modules[0].factory().apply(ctx)
  try {
    const result=JSON.parse(JSON.stringify(window.__dshSshView.inspection()))
    assert.deepEqual(result.memory,{kind:'renderer-js-heap-estimate',bytes:123456})
    assert.deepEqual(result.navigation,{sessionId,workspaceId})
    assert.deepEqual(result.sidebar,{tabs:1,terminals:1})
    assert.equal(result.drafts.pendingUnmountSaves,1);assert.equal(result.drafts.failedUnmountSaves,1)
    assert.equal(result.drafts.sessions[0].hasAttachments,true)
    assert.deepEqual(result.lifecycle,{scope:'observation-only',pendingRequests:null,unconfirmedOperations:null})
    assert(!JSON.stringify(result).includes(privateText))
    return {serializedInspectionInMockClient:true,mockHeapValueNotActualMeasurement:true,nativeUiVerified:false}
  } finally { window.__dshSshNavigationOwner.dispose() }
}

/** Exercise the serialized Replica too, without claiming real React/browser
 * rendering. Separate React lifecycle tests cover mount/update/unmount. */
export async function verifyDraftInspection(source, hostId, sessionId) {
  const modules=[],cleanups=[],reactCleanups=[]
  let Entry
  const input={draft:'',draftRev:0,phase:'plain',attachmentIds:[],occurrences:[]}
  const face={state:{getSnapshot:()=>input,subscribe:()=>()=>{}},setDraft(){throw Error('Inspection must not restore or edit input')}}
  const window={__ModuleLoader__:{load:value=>modules.push(value)},addEventListener(){},removeEventListener(){},
    __dshSshDraftSeeds:new Map([[sessionId,{hostId,sessionId,draft:{version:1,hostId,sessionId,text:'',revision:'00000000-0000-4000-8000-000000000001',operationId:'00000000-0000-4000-8000-000000000002',hadReferences:false,hadAttachments:false,savedAt:1}}]])}
  const react={createElement:(component,props,...children)=>typeof component==='function'?component(props):{component,props,children},
    useMemo:fn=>fn(),useSyncExternalStore:(_subscribe,snapshot)=>snapshot(),
    useLayoutEffect:fn=>{const cleanup=fn();if(cleanup)reactCleanups.push(cleanup)},
    useEffect:fn=>{const cleanup=fn();if(cleanup)reactCleanups.push(cleanup)}}
  const sandbox=createContext({window,Date,localStorage:{getItem:()=>null},document:{documentElement:{lang:'en'}},
    fetch(){throw Error('An owned empty seed must require no request')},setTimeout,clearTimeout})
  new Script(source).runInContext(sandbox,{timeout:1000})
  assert.equal(modules.length,1);assert.equal(modules[0].id,'@jay-local/dsh-ssh-drafts')
  const ctx={slots:{inject:(_name,apply)=>apply(),register:(_options,entry)=>{Entry=entry;return()=>{}}},
    sessions:{scope:id=>id},get:name=>name==='conversation'?{input:{for:()=>face}}:undefined,effect:fn=>cleanups.push(fn())}
  ctx.root={inject:(_deps,apply)=>{apply(ctx);return{dispose(){for(const cleanup of cleanups.splice(0))cleanup()}}}}
  modules[0].factory(name=>{assert.equal(name,'react');return react}).apply(ctx)
  try {
    react.createElement(Entry,{sessionId})
    for(let n=0;n<20;n++)await Promise.resolve()
    const result=JSON.parse(JSON.stringify(window.__dshSshDrafts.inspection()))
    assert.equal(result.sessions.length,1);assert.equal(result.sessions[0].sessionId,sessionId)
    assert.equal(result.sessions[0].persisted,true);assert.equal(result.sessions[0].status,'saved')
    assert.equal(result.pendingUnmountSaves,0);assert.equal(result.failedUnmountSaves,0)
    assert.equal(window.__dshSshDraftSeeds.size,0)
    assert(!('text' in result.sessions[0]));assert(!('draft' in result.sessions[0]))
    return {serializedDraftInspectionInMockClient:true}
  } finally {
    for(const cleanup of reactCleanups.reverse())cleanup()
    for(let n=0;n<20;n++)await Promise.resolve()
    window.__dshSshDraftOwner.dispose()
  }
}
