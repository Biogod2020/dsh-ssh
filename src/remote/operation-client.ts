import type { createOperationLedger } from './operation-ledger.ts'

/** Install before Connection construction. Only the default SDK's composition
 * is decorated; globals.fetch, globals.WebSocket and the Context stay intact.
 * This first contribution observes unary calls, not full view quiescence. */
export function operationTransport(hostId: string, makeLedger: typeof createOperationLedger): void {
  type Rpc = { call(...args: unknown[]): Promise<unknown> }
  type Pending = { dispatched(): void; finish(confirmed: boolean): void }
  type Api = { hostId: string; attach(rpc: Rpc): () => void; inspection(): object }
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
  const api: Api = {
    hostId,
    inspection() {
      if (!supported || !binding || binding.rpc.call !== binding.call || target.__DSH_TRANSPORT__ !== owned) invalidate()
      return { version: 1, scope: 'unary-observation', fullCoverage: false, automaticReleaseEligible: false,
        pendingRequests: null, unconfirmedOperations: null,
        unary: { observedPendingRequests: pending, rpcDecoratorAttached: rpcAttached, scopedFetchObserved } }
    },
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
            entry.finish(acknowledged); return value
          }, error => { entry.finish(false); throw error })
        } catch (error) { entry.finish(false); throw error }
        finally { current = previous }
      }
      try { Object.defineProperty(rpc, 'call', { ...descriptor, value: call }) }
      catch { return () => {} }
      const owner = { rpc, call, restore() {
        if (rpc.call === call) try { Object.defineProperty(rpc, 'call', descriptor) } catch { /* A future immutable instance stays partial. */ }
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
    if (bound) scopedFetchObserved = true
    // A caller captured before the public RPC decorator cannot be presented
    // as completely covered by that decorator.
    if (!bound) invalidate()
    try {
      entry.dispatched()
      const response = await send(input, init)
      if (bound) return response
      // Startup calls are tracked before the Client contribution can mount.
      // JSON consumption is only an ended *unknown* observation, never proof
      // of a validated SDK acknowledgement. Unbound multipart stays protected.
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
                try { return await consume.apply(this, args) }
                finally { if (this === body) setTimeout(() => entry.finish(false), 0) }
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
  try { owned = { ...base, fetch: observedFetch }; target.__DSH_TRANSPORT__ = owned; supported = true }
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
    __dshSshOperations?: { attach(rpc: { call(...args: unknown[]): Promise<unknown> }): () => void }
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
      let disposed = false
      const owner: Owner = { root: ctx.root, dispose() {
        if (disposed) return
        disposed = true; window.removeEventListener('pagehide', hide)
        if (target.__dshSshOperationOwner === owner) delete target.__dshSshOperationOwner
        return runtime.dispose()
      } }
      target.__dshSshOperationOwner = owner
      const hide = (event: PageTransitionEvent) => { if (!event.persisted) void owner.dispose() }
      window.addEventListener('pagehide', hide)
      ctx.root.effect?.(() => () => { void owner.dispose() })
    },
  }) })
}
