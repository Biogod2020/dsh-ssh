/** Serialized with the page. These are Client-owned iterator/answer lifetimes,
 * not physical sockets. Correlation ids remain in this closure only. */
export function createRemoteOperationObserver(
  reserve: (endpoint: unknown) => { dispatched(): void; finish(confirmed: boolean): void },
  invalidate: () => void,
) {
  type Method = (this: unknown, ...args: any[]) => any
  type Question = { acknowledged: boolean }
  const questions = new Map<string, Set<Question>>()
  let streams = 0, subscriptions = 0, answers = 0
  let owner: { restore(): void; valid(): boolean; answer: boolean } | undefined
  const key = (clientId: unknown, eventId: unknown) => typeof clientId === 'string' && clientId.length > 0 && clientId.length <= 256
    && typeof eventId === 'string' && eventId.length > 0 && eventId.length <= 256 ? JSON.stringify([clientId, eventId]) : undefined
  const decorate = (object: any, name: string, wrap: (original: Method) => Method) => {
    let own: PropertyDescriptor | undefined, original: Method
    try {
      if (!object || typeof object[name] !== 'function') return
      own = Object.getOwnPropertyDescriptor(object, name); original = object[name]
    } catch { invalidate(); return }
    if (own && (!('value' in own) || !own.configurable)) return
    const method = wrap(original)
    try { Object.defineProperty(object, name, { configurable: true, writable: true, ...(own ?? {}), value: method }) }
    catch { return }
    // Cordis may trace a service method on property read. Descriptor identity
    // keeps cleanup tied to the installed method, rather than a fresh trace.
    const owns = () => { try { return Object.getOwnPropertyDescriptor(object, name)?.value === method } catch { invalidate(); return false } }
    return { valid: owns, restore() {
      if (!owns()) return
      try { if (own) Object.defineProperty(object, name, own); else delete object[name] }
      catch { invalidate() }
    } }
  }
  return {
    inspection() {
      const attached = !!owner && owner.valid()
      if (owner && !attached) invalidate()
      return { scope: 'logical-client-observation', observedStreams: streams, observedEventSubscriptions: subscriptions,
        observedWaitingAnswers: answers, streamDecoratorAttached: attached, answerDecoratorAttached: attached && !!owner?.answer }
    },
    /** Called only after the official RPC has validated the entire response.
     * The handler itself must also settle, including its owned Context cleanup. */
    acknowledge(endpoint: unknown, payload: any, result: any) {
      try {
        if (endpoint !== '$events/result' || result?.ok !== true) return
        const id = key(payload?.args?.clientId, payload?.args?.eventId), entries = id && questions.get(id)
        if (entries && entries.size === 1) for (const entry of entries) entry.acknowledged = true
      } catch { invalidate() }
    },
    attach(remote: any) {
      const previous = owner; owner = undefined; previous?.restore()
      const stream = decorate(remote, 'openRemoteStream', original => function (this: unknown, ...args) {
        // Preserve construction timing and the SDK's original receiver. Do not
        // pull a stream, replay it, or eagerly run a caller's uplink iterator.
        const source = original.apply(this, args)
        if (!source || typeof source.next !== 'function' || typeof source[Symbol.asyncIterator] !== 'function') {
          invalidate(); return source
        }
        const eventBus = args[0] === '$events'
        let entry: ReturnType<typeof reserve> | undefined
        let ended = false, begun = false
        const finish = (confirmed: boolean) => {
          if (ended) return
          ended = true; if (begun) { if (eventBus) subscriptions--; else streams-- }
          entry?.finish(confirmed)
        }
        const invoke = (name: 'next' | 'return' | 'throw', values: unknown[]) => {
          try {
            // The pinned SDK only constructs an async generator here; its
            // first pull starts dispatch. An unused iterator owns no operation.
            if (!ended && name === 'next' && !begun) {
              entry = eventBus ? undefined : reserve(args[0])
              begun = true; if (eventBus) subscriptions++; else streams++
              entry?.dispatched()
            }
            const result = typeof source[name] === 'function' ? source[name].apply(source, values)
              : name === 'throw' ? Promise.reject(values[0]) : { done: true, value: values[0] }
            return Promise.resolve(result).then(value => {
              if (value?.done === true) finish(name === 'next')
              return value
            }, error => { finish(false); throw error })
          } catch (error) { finish(false); return Promise.reject(error) }
        }
        return { next: (...values: unknown[]) => invoke('next', values), return: (...values: unknown[]) => invoke('return', values),
          throw: (...values: unknown[]) => invoke('throw', values), [Symbol.asyncIterator]() { return this } }
      })
      if (!stream) { invalidate(); return () => {} }
      // `events.answer` is an implementation seam of the pinned rc.2 SDK,
      // not a proposed upstream API. Missing/changed shapes remain partial.
      let events: unknown
      try { events = remote.events } catch { invalidate() }
      const answer = decorate(events, 'answer', original => function (this: unknown, ...args) {
        // Bound ephemeral correlation as well as the durable metadata ledger.
        // Overflow keeps the live count/protection but cannot claim coverage.
        const id = answers < 4096 ? key(args[1], args[0]?.eventId) : undefined, entry = reserve('other'), question = { acknowledged: false }
        answers++; entry.dispatched()
        if (id) {
          const group = questions.get(id) ?? new Set<Question>(); group.add(question); questions.set(id, group)
          if (group.size > 1) invalidate()
        } else invalidate()
        const finish = () => {
          answers--; entry.finish(question.acknowledged)
          if (id) { const group = questions.get(id); group?.delete(question); if (!group?.size) questions.delete(id) }
        }
        try { return Promise.resolve(original.apply(this, args)).then(value => { finish(); return value }, error => { finish(); throw error }) }
        catch (error) { finish(); throw error }
      })
      if (!answer) invalidate()
      const current = { answer: !!answer, valid: () => stream.valid() && (!answer || answer.valid()), restore() { answer?.restore(); stream.restore() } }
      owner = current
      return () => { if (owner !== current) return; owner = undefined; current.restore(); invalidate() }
    },
  }
}
