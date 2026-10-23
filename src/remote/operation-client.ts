import type { createOperationLedger } from './operation-ledger.ts'
import type { createRemoteOperationObserver } from './operation-streams.ts'

/** Install before Connection construction. Only the default SDK's composition
 * is decorated; globals.fetch, globals.WebSocket and the Context stay intact.
 * This first contribution observes unary calls, not full view quiescence. */
export function operationTransport(hostId: string, makeLedger: typeof createOperationLedger, makeRemote?: typeof createRemoteOperationObserver, channel?:string): void {
  type Rpc = { call(...args: unknown[]): Promise<unknown> }
  type Pending = { dispatched(): void; finish(confirmed: boolean): void }
  type Api = { hostId: string; releaseBlock?:string; attach(rpc: Rpc): () => void; attachRemote(remote: unknown): () => void; inspection(): object; freeze(): Promise<string | null>; thaw(token:string):boolean; commit(token:string):boolean }
  const target = window as unknown as {
    __DSH_TRANSPORT__?: Record<string, unknown>
    __dshSshOperations?: Api
    __dshSshView?: { state(): { sessionId?: string } }
  }
  if (target.__dshSshOperations) return
  const ledger = makeLedger(), base = target.__DSH_TRANSPORT__
  let pending = 0, current: Pending | undefined
  let binding: { rpc: Rpc; call: Rpc['call']; restore(): void } | undefined
  let owned: Record<string, unknown> | undefined, supported = false, rpcAttached = false, scopedFetchObserved = false
  const sockets=new Set<{streams:Map<string,string>;opaque:boolean}>()
  const readOnly=(endpoint:string)=>['$events','session/follow','workspace/follow','session/control','account/watch','account/watchExpiry','remoteAccess/follow','job/list','job/follow'].includes(endpoint)
  const ownsBinding=()=>!!binding&&Object.getOwnPropertyDescriptor(binding.rpc,'call')?.value===binding.call
  const category = (endpoint: unknown) => {
    const prefix = typeof endpoint === 'string' ? endpoint.split('/')[0] : ''
    if (prefix === 'session' || prefix === 'workspace' || prefix === 'terminal' || prefix === 'files' || prefix === 'settings') return prefix
    return prefix === 'fs' ? 'files' : 'other'
  }
  const invalidate = () => { if (rpcAttached) { rpcAttached = false; ledger.coverage(false) } }
  const selected = () => {
    try {
      const id = target.__dshSshView?.state().sessionId
      return typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(id) ? id : undefined
    } catch { return undefined }
  }
  const reserve = (endpoint: unknown): Pending => {
    const entry = ledger.reserve(category(endpoint), 'http', selected()); pending++
    let finished = false
    return {
      dispatched: () => entry.dispatched(),
      finish(confirmed) { if (finished) return; finished = true; pending--; entry.finish(confirmed) },
    }
  }
  const remote = makeRemote?.(endpoint => ledger.reserve(category(endpoint), 'stream', selected()), invalidate)
  const api: Api = {
    hostId,
    async freeze() {
      const state = remote?.inspection()
      api.releaseBlock=!supported||!ownsBinding()||target.__DSH_TRANSPORT__!==owned||!rpcAttached?'client-composition'
        :!state?.streamDecoratorAttached||!state.answerDecoratorAttached?'stream-composition'
        :state.observedWaitingAnswers!==0?'waiting-answer':state.observedStreams!==state.observedReadSubscriptions?'active-stream':pending!==0?'pending-rpc'
        :[...sockets].some(socket=>socket.opaque||[...socket.streams.values()].some(endpoint=>!readOnly(endpoint)))?'pending-socket':undefined
      if(api.releaseBlock)return null
      // The gateway freezes all document HTTP and socket uplinks as the other
      // half of this barrier. This does not promote ordinary sampling to proof.
      ledger.coverage(true)
      const token = ledger.freeze()
      const saved = await ledger.seal(token, async records => {
        const response = await fetch('/__dsh_remote/observations', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ records }), signal:AbortSignal.timeout(3000) })
        if (!response.ok) throw new Error('Observation save failed')
        return (await response.json()).receipts
      })
      if (!saved) { api.releaseBlock='unconfirmed-operation';ledger.thaw(token); return null }
      return token
    },
    thaw: token => ledger.thaw(token),
    commit: token => ledger.commitRelease(token),
    inspection() {
      if (!supported || !ownsBinding() || target.__DSH_TRANSPORT__ !== owned) invalidate()
      return { version: 1, scope: 'partial-client-observation', fullCoverage: false, automaticReleaseEligible: false,
        pendingRequests: null, unconfirmedOperations: null,
        unary: { observedPendingRequests: pending, rpcDecoratorAttached: rpcAttached, scopedFetchObserved },
        ...(remote ? { logical: remote.inspection() } : {}) }
    },
    attachRemote: value => supported && target.__DSH_TRANSPORT__ === owned ? remote?.attach(value) ?? (() => {}) : (() => {}),
    attach(rpc) {
      if (!supported || target.__DSH_TRANSPORT__ !== owned || !rpc || typeof rpc.call !== 'function') return () => {}
      const previousBinding = binding; binding = undefined; previousBinding?.restore(); invalidate()
      const descriptor = Object.getOwnPropertyDescriptor(rpc, 'call')
      if (!descriptor || !('value' in descriptor) || !descriptor.configurable) return () => {}
      const original = rpc.call
      const call: Rpc['call'] = function (this: unknown, ...args) {
        if (target.__DSH_TRANSPORT__ !== owned) invalidate()
        const entry = reserve(args[1]), previous = current
        current = entry
        try {
          const result = original.apply(this, args)
          return Promise.resolve(result).then(value => {
            // The reviewed default SDK validates envelopes, correlation and
            // binary decoding before resolving its public RPC Promise.
            const acknowledged = !!value && typeof value === 'object' && typeof (value as { ok?: unknown }).ok === 'boolean'
            if (!acknowledged) invalidate()
            if (acknowledged) remote?.acknowledge(args[1], args[2], value)
            entry.finish(acknowledged); return value
          }, error => { entry.finish(false); throw error })
        } catch (error) { entry.finish(false); throw error }
        finally { current = previous }
      }
      try { Object.defineProperty(rpc, 'call', { ...descriptor, value: call }) }
      catch { return () => {} }
      const owner = { rpc, call, restore() {
        if (Object.getOwnPropertyDescriptor(rpc,'call')?.value === call) try { Object.defineProperty(rpc, 'call', descriptor) } catch { /* A future immutable instance stays partial. */ }
      } }
      // Binding one RPC instance is partial observation, never proof that all
      // logical streams, incoming questions and resource owners are idle.
      binding = owner; rpcAttached = true
      return () => {
        if (binding !== owner) return
        owner.restore(); binding = undefined; invalidate()
      }
    },
  }
  target.__dshSshOperations = api
  // A custom fetch, RPC or worker-local stream carrier needs its own verified
  // composition. Preserve it and report unknown instead of assuming coverage.
  if (base) {
    if (typeof base !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(base))) return
    const descriptors = Object.getOwnPropertyDescriptors(base)
    if (Object.values(descriptors).some(row => !('value' in row))
      || ['rpc', 'fetch', 'openStream', 'createWebSocket'].some(key => descriptors[key]?.value !== undefined)) return
  }
  if (typeof fetch !== 'function') return
  const send = fetch.bind(window)
  const observedFetch: typeof fetch = async (input, init) => {
    if (target.__DSH_TRANSPORT__ !== owned) invalidate()
    const bound = current, entry = bound ?? reserve('other')
    const requestUrl=new URL(typeof input==='string'||input instanceof URL?String(input):input.url,location.href)
    const method=init?.method??(typeof input==='object'&&'method' in input?input.method:'GET')
    const moduleEvents=method.toUpperCase()==='GET'&&requestUrl.origin===location.origin&&requestUrl.pathname==='/plugins/events'
    let requestId:string|undefined
    if(!bound&&requestUrl.origin===location.origin&&method.toUpperCase()==='POST'&&typeof init?.body==='string')try{
      const message=JSON.parse(init.body)
      if(message.type==='client-request'&&typeof message.rpcId==='string'&&message.rpcId.length<=256&&typeof message.method==='string'
        &&requestUrl.pathname==='/api/'+message.method)requestId=message.rpcId
    }catch{/* Preserve unknown request shapes. */}
    const acknowledged=(value:any)=>!!requestId&&!init?.signal?.aborted&&value?.type==='server-response'&&value.rpcId===requestId
      &&value.result&&typeof value.result==='object'&&!Array.isArray(value.result)&&(value.result.ok===true
        ||value.result.ok===false&&typeof value.result.error?.code==='string'&&typeof value.result.error.message==='string'
          &&value.result.error.details&&typeof value.result.error.details==='object'&&!Array.isArray(value.result.error.details))
    if (bound) scopedFetchObserved = true
    // A caller captured before the public RPC decorator cannot be presented
    // as completely covered by that decorator.
    if (!bound&&!moduleEvents) invalidate()
    try {
      entry.dispatched()
      const response = await send(input, init)
      if (bound) return response
      if(moduleEvents
        &&response.status===200&&response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')){
        // A known module-graph observer has no operation acknowledgement to
        // await. Its open SSE body must not pin the entire remote renderer.
        entry.finish(true);return response
      }
      // Startup calls are tracked before the Client contribution can mount.
      // Correlate a complete JSON envelope using the pinned SDK's exact
      // acknowledgement rules. Other JSON bodies stay unknown; multipart
      // still waits for the SDK's complete binary decoding.
      if (!response.ok) { setTimeout(() => entry.finish(false), 0); return response }
      if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json') {
        const watched = new WeakSet<Response>()
        const watch = (body: Response) => {
          if (watched.has(body)) return
          watched.add(body)
          for (const name of ['json', 'text', 'blob', 'arrayBuffer', 'bytes'] as const) {
            const consume = (body as any)[name]
            if (typeof consume !== 'function') continue
            try {
              Object.defineProperty(body, name, { configurable: true, writable: true, value: async function (this: Response, ...args: unknown[]) {
                let confirmed=false
                try {
                  const value=await consume.apply(this,args)
                  if(this===body)try{confirmed=!!acknowledged(name==='json'?value:name==='text'?JSON.parse(value):undefined)}catch{/* Keep unknown. */}
                  return value
                } finally { if (this === body) setTimeout(() => entry.finish(confirmed), 0) }
              } })
            } catch { invalidate() }
          }
          const clone = body.clone
          if (typeof clone === 'function') try {
            Object.defineProperty(body, 'clone', { configurable: true, writable: true, value: function (this: Response) {
              const copied = clone.call(this); if (this === body) watch(copied); return copied
            } })
          } catch { invalidate() }
        }
        watch(response)
      }
      return response
    } catch (error) { if (!bound) entry.finish(false); throw error }
  }
  const createWebSocket=(value:string|URL)=>{
    const url=new URL(value);if(channel)url.searchParams.set('dsh-view-channel',channel)
    const socket=new WebSocket(url),state={streams:new Map<string,string>(),opaque:false},sendFrame=socket.send
    sockets.add(state)
    socket.send=function(this:WebSocket,data:string|ArrayBufferLike|Blob|ArrayBufferView){
      if(this!==socket)return sendFrame.call(this,data)
      const frozen=ledger.inspection();if(frozen.frozen||frozen.closed)throw new Error('View dispatch is frozen')
      try{
        if(typeof data!=='string')state.opaque=true
        else{
          const frame=JSON.parse(data)
          if(frame.type==='open'){
            if(typeof frame.streamId!=='string'||typeof frame.endpoint!=='string'||state.streams.size>=4096)state.opaque=true
            else state.streams.set(frame.streamId,frame.endpoint)
          }else if(frame.type!=='cancel'&&frame.type!=='ping'){
            // Unknown uplinks and writes on an alleged observation cannot prove
            // quiescence, even when the stream never completed registration.
            if(!state.streams.has(frame.streamId)||readOnly(state.streams.get(frame.streamId)!))state.opaque=true
          }
        }
      }catch{state.opaque=true}
      return sendFrame.call(this,data)
    }
    socket.addEventListener('message',event=>{if(typeof event.data==='string')try{const frame=JSON.parse(event.data);if(frame.type==='end'||frame.type==='error')state.streams.delete(frame.streamId)}catch{/* Retain unknown frames. */}})
    socket.addEventListener('close',()=>sockets.delete(state),{once:true})
    return socket
  }
  try { owned = { ...base, fetch: observedFetch,...(channel?{createWebSocket}:{}) }; target.__DSH_TRANSPORT__ = owned; supported = true }
  catch { invalidate() }
}

/** Observe the existing public RPC instance. A page-owned fiber survives Host
 * manifest reconciliation; no Connection service or module factory is replaced. */
export function operationClient(): void {
  type Root = { inject(deps: string[], apply: (ctx: Ctx) => void): { dispose(): unknown }; effect?(fn: () => () => void): unknown }
  type Ctx = { get(name: string): unknown; effect(fn: () => () => void): void; root: Root }
  type Owner = { root: Root; dispose(): unknown }
  const target = window as unknown as {
    __ModuleLoader__?: { load(value: unknown): void }
    __dshSshOperations?: { attach(rpc: { call(...args: unknown[]): Promise<unknown> }): () => void; attachRemote?(remote: unknown): () => void }
    __dshSshOperationOwner?: Owner
  }
  target.__ModuleLoader__?.load({ id: '@jay-local/dsh-ssh-operations', factory: () => ({
    inject: ['connection'],
    apply(ctx: Ctx) {
      if (!target.__dshSshOperations || target.__dshSshOperationOwner?.root === ctx.root) return
      target.__dshSshOperationOwner?.dispose()
      const runtime = ctx.root.inject(['connection'], scoped => {
        const connection = scoped.get('connection') as { rpc?: { call(...args: unknown[]): Promise<unknown> } } | undefined
        if (connection?.rpc) scoped.effect(() => target.__dshSshOperations!.attach(connection.rpc!))
      })
      const remoteRuntime = ctx.root.inject(['remote'], scoped => {
        const remote = scoped.get('remote')
        if (remote && target.__dshSshOperations?.attachRemote) scoped.effect(() => target.__dshSshOperations!.attachRemote!(remote))
      })
      let disposed = false
      const owner: Owner = { root: ctx.root, dispose() {
        if (disposed) return
        disposed = true; window.removeEventListener('pagehide', hide)
        if (target.__dshSshOperationOwner === owner) delete target.__dshSshOperationOwner
        return Promise.allSettled([runtime.dispose(), remoteRuntime.dispose()])
      } }
      target.__dshSshOperationOwner = owner
      const hide = (event: PageTransitionEvent) => { if (!event.persisted) void owner.dispose() }
      window.addEventListener('pagehide', hide)
      ctx.root.effect?.(() => () => { void owner.dispose() })
    },
  }) })
}
