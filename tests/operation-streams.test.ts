import { expect, it, vi } from 'vitest'
import { createRemoteOperationObserver } from '../src/remote/operation-streams.ts'
import { createOperationLedger } from '../src/remote/operation-ledger.ts'
import { Context, Service } from '@deepseek-ai/cordis'

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function fixture() {
  const ledger = createOperationLedger(); ledger.coverage(true)
  const invalidate = vi.fn(() => ledger.coverage(false))
  const make = new Function(`return (${createRemoteOperationObserver.toString()});`)()
  const observer: ReturnType<typeof createRemoteOperationObserver> = make(() => ledger.reserve('other', 'stream', 'generated-session'), invalidate)
  return { ledger, invalidate, observer }
}
it('keeps a persistent event subscription separate from an active operation without pulling it', async () => {
  const f = fixture(), pull = vi.fn()
  const remote = { openRemoteStream: (_endpoint: string) => (async function* () { pull(); yield { generated: true } })(), events: { answer: async () => {} } }
  f.observer.attach(remote)
  const stream = remote.openRemoteStream('$events' as never)
  expect(pull).not.toHaveBeenCalled(); expect(f.observer.inspection()).toMatchObject({ observedStreams: 0, observedEventSubscriptions: 0, observedWaitingAnswers: 0 })
  expect(f.ledger.inspection().pendingRequests).toBe(0)
  await stream.next(); expect(pull).toHaveBeenCalledOnce(); expect(f.observer.inspection().observedEventSubscriptions).toBe(1); await stream.return(undefined)
  expect(f.observer.inspection().observedEventSubscriptions).toBe(0)
})
it('preserves method receiver, yielded values and final value until actual iterator completion', async () => {
  const f = fixture(), remote = { marker: 7, openRemoteStream(_endpoint: string) { const receiver = this; return (async function* () { yield receiver.marker; return 9 })() }, events: { answer: async () => {} } }
  f.observer.attach(remote); const stream = remote.openRemoteStream('generated/read')
  expect(stream[Symbol.asyncIterator]()).toBe(stream)
  expect(await stream.next()).toEqual({ done: false, value: 7 }); expect(f.ledger.inspection().pendingRequests).toBe(1)
  expect(await stream.next()).toEqual({ done: true, value: 9 }); expect(f.ledger.inspection()).toMatchObject({ pendingRequests: 0, unconfirmedOperations: 0 })
})
it('does not call a queued return completed while the SDK iterator is still handling an item', async () => {
  const f = fixture(), wait = deferred<number>()
  const remote = { openRemoteStream(_endpoint: string) { return (async function* () { yield await wait.promise })() }, events: { answer: async () => {} } }
  f.observer.attach(remote); const stream = remote.openRemoteStream('terminal/attach'), next = stream.next(), closing = stream.return(undefined)
  expect(f.observer.inspection().observedStreams).toBe(1); expect(f.ledger.inspection().pendingRequests).toBe(1)
  wait.resolve(42); expect(await next).toEqual({ done: false, value: 42 }); await closing
  expect(f.observer.inspection().observedStreams).toBe(0)
  expect(f.ledger.inspection()).toMatchObject({ pendingRequests: 0, unconfirmedOperations: 1 })
})
it('records no uncertain dispatch when a constructed iterator is returned before first pull', async () => {
  const f = fixture(), run = vi.fn(), remote = { openRemoteStream(_endpoint: string) { return (async function* () { run(); yield 1 })() }, events: { answer: async () => {} } }
  f.observer.attach(remote); await remote.openRemoteStream('generated/write').return(undefined)
  expect(run).not.toHaveBeenCalled(); expect(f.ledger.inspection()).toMatchObject({ pendingRequests: 0, unconfirmedOperations: 0 })
})
it('preserves the SDK error with one attempt and retires the stream as unknown', async () => {
  const f = fixture(), error = Error('Generated lost carrier'), run = vi.fn()
  const remote = { openRemoteStream(_endpoint: string) { return (async function* () { run(); throw error; yield 1 })() }, events: { answer: async () => {} } }
  f.observer.attach(remote); await expect(remote.openRemoteStream('generated/write').next()).rejects.toBe(error)
  expect(run).toHaveBeenCalledOnce(); expect(f.ledger.inspection()).toMatchObject({ pendingRequests: 0, unconfirmedOperations: 1 })
})
it('waits for both validated event-result acknowledgement and actual handler cleanup', async () => {
  const f = fixture(), cleanup = deferred<void>(), remote = { openRemoteStream: () => (async function* () {})(), events: { answer: async (_frame: unknown, _clientId: string) => { await cleanup.promise; return 4 } } }
  f.observer.attach(remote); const answer = remote.events.answer({ eventId: 'generated-event' }, 'generated-client')
  f.observer.acknowledge('$events/result', { args: { clientId: 'generated-client', eventId: 'generated-event' } }, { ok: true })
  expect(f.observer.inspection().observedWaitingAnswers).toBe(1); expect(f.ledger.inspection().pendingRequests).toBe(1)
  cleanup.resolve(); expect(await answer).toBe(4)
  expect(f.observer.inspection().observedWaitingAnswers).toBe(0); expect(f.ledger.inspection().unconfirmedOperations).toBe(0)
})
it('does not release an ignored cancellation signal until the handler actually settles', async () => {
  const f = fixture(), finish = deferred<void>(), signal = new AbortController()
  const remote = { openRemoteStream: () => (async function* () {})(), events: { answer: async (_frame: unknown, _client: string, _signal: AbortSignal) => finish.promise } }
  f.observer.attach(remote); const answer = remote.events.answer({ eventId: 'event' }, 'client', signal.signal)
  signal.abort(); expect(f.observer.inspection().observedWaitingAnswers).toBe(1)
  finish.resolve(); await answer; expect(f.ledger.inspection().unconfirmedOperations).toBe(1)
})
it('does not mistake a different generation or a refused reply for this question acknowledgement', async () => {
  const f = fixture(), finish = deferred<void>(), remote = { openRemoteStream: () => (async function* () {})(), events: { answer: async (_frame: unknown, _client: string) => finish.promise } }
  f.observer.attach(remote); const answer = remote.events.answer({ eventId: 'same-event' }, 'new-client')
  f.observer.acknowledge('$events/result', { args: { clientId: 'old-client', eventId: 'same-event' } }, { ok: true })
  f.observer.acknowledge('$events/result', { args: { clientId: 'new-client', eventId: 'same-event' } }, { ok: false })
  finish.resolve(); await answer; expect(f.ledger.inspection().unconfirmedOperations).toBe(1)
})
it('fences duplicate question ids instead of attributing a single acknowledgement to both', async () => {
  const f = fixture(), finish = deferred<void>(), remote = { openRemoteStream: () => (async function* () {})(), events: { answer: async (_frame: unknown, _client: string) => finish.promise } }
  f.observer.attach(remote); const a = remote.events.answer({ eventId: 'duplicate' }, 'client'), b = remote.events.answer({ eventId: 'duplicate' }, 'client')
  f.observer.acknowledge('$events/result', { args: { clientId: 'client', eventId: 'duplicate' } }, { ok: true })
  expect(f.invalidate).toHaveBeenCalled(); expect(f.observer.inspection().observedWaitingAnswers).toBe(2)
  finish.resolve(); await Promise.all([a, b]); expect(f.observer.inspection().observedWaitingAnswers).toBe(0)
  expect(f.ledger.inspection().pendingRequests).toBeNull()
})
it('restores inherited methods, fences stale cleanup, and does not erase later replacements', () => {
  const f = fixture(), stream = function () { return (async function* () {})() }, answer = async () => {}
  const remote = Object.assign(Object.create({ openRemoteStream: stream }), { events: Object.create({ answer }) })
  const stop = f.observer.attach(remote); expect(Object.hasOwn(remote, 'openRemoteStream')).toBe(true)
  const other = { openRemoteStream: stream, events: { answer } }, stopOther = f.observer.attach(other), method = other.openRemoteStream
  expect(Object.hasOwn(remote, 'openRemoteStream')).toBe(false); expect(Object.hasOwn(remote.events, 'answer')).toBe(false)
  stop(); expect(other.openRemoteStream).toBe(method)
  const replacement = function () { return (async function* () { return })() }; other.openRemoteStream = replacement
  expect(f.observer.inspection().streamDecoratorAttached).toBe(false); stopOther(); expect(other.openRemoteStream).toBe(replacement)
})
it('keeps unsupported source shapes unchanged and diagnostics free of request content or correlations', () => {
  const f = fixture(), source = { generated: true }, remote = { openRemoteStream: () => source, events: { answer: async () => {} } }
  f.observer.attach(remote); expect(remote.openRemoteStream()).toBe(source); expect(f.invalidate).toHaveBeenCalled()
  expect(JSON.stringify(f.observer.inspection())).not.toMatch(/eventId|clientId|endpoint|generated-session|payload|args/)
})
it('recognizes and restores the own descriptor when real Cordis traces method property reads', async () => {
  const f = fixture(), ctx = new Context()
  class Remote extends Service {
    events = { answer: async () => {} }
    constructor() { super(ctx, 'remote') }
    openRemoteStream(_endpoint: string) { return (async function* () { yield 7 })() }
  }
  new Remote()
  try {
    const remote = ctx.get('remote') as Remote, original = Object.getOwnPropertyDescriptor(remote, 'openRemoteStream')
    const stop = f.observer.attach(remote)
    expect(f.observer.inspection()).toMatchObject({ streamDecoratorAttached: true, answerDecoratorAttached: true })
    const stream = remote.openRemoteStream('generated/read'); expect(await stream.next()).toEqual({ done: false, value: 7 })
    await stream.next(); stop()
    expect(Object.getOwnPropertyDescriptor(remote, 'openRemoteStream')).toEqual(original)
    expect(f.observer.inspection().observedStreams).toBe(0)
  } finally { await ctx.fiber.dispose() }
})
it('does not turn an already valid RPC result into a failure when custom correlation access throws', () => {
  const f = fixture(), payload = Object.create(null)
  Object.defineProperty(payload, 'args', { get() { throw Error('Generated accessor rejected') } })
  expect(() => f.observer.acknowledge('$events/result', payload, { ok: true })).not.toThrow()
  expect(f.invalidate).toHaveBeenCalled()
})
it('preserves optional iterator return values and throw failures after the source has ended', async () => {
  const f = fixture(), source = { async next() { return { done: true, value: undefined } }, [Symbol.asyncIterator]() { return this } }
  const remote = { openRemoteStream: () => source, events: { answer: async () => {} } }
  f.observer.attach(remote); const stream = remote.openRemoteStream() as any
  await stream.next(); expect(await stream.return('generated-final-value')).toEqual({ done: true, value: 'generated-final-value' })
  const error = Error('Generated caller throw'); await expect(stream.throw(error)).rejects.toBe(error)
  expect(f.observer.inspection().observedStreams).toBe(0)
})
it('keeps an ended iterator method rejection asynchronous without resurrecting its count', async () => {
  const f = fixture(), error = Error('Generated ended source throw')
  const source = { async next() { return { done: true, value: undefined } }, throw() { throw error }, [Symbol.asyncIterator]() { return this } }
  const remote = { openRemoteStream: () => source, events: { answer: async () => {} } }
  f.observer.attach(remote); const stream = remote.openRemoteStream() as any; await stream.next()
  let result: Promise<unknown> | undefined; expect(() => { result = stream.throw(error) }).not.toThrow()
  await expect(result).rejects.toBe(error); expect(f.observer.inspection().observedStreams).toBe(0)
})
it('keeps unsupported accessor failures partial without breaking the Client registration', () => {
  const f = fixture(), remote = Object.create(null)
  Object.defineProperty(remote, 'openRemoteStream', { get() { throw Error('Generated unsupported service accessor') } })
  expect(() => f.observer.attach(remote)).not.toThrow()
  expect(f.observer.inspection().streamDecoratorAttached).toBe(false);expect(f.invalidate).toHaveBeenCalled()
})
