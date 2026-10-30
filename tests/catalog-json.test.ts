import { afterEach, expect, it, vi } from 'vitest'
import { CatalogJsonReader, catalogJsonLimit, readCatalogJson, runCatalogRead } from '../src/remote/catalog-json.ts'

const readers: CatalogJsonReader[] = []
afterEach(() => { vi.useRealTimers(); for (const reader of readers.splice(0)) reader.close() })
const decoder = () => { const reader = new CatalogJsonReader(); readers.push(reader); return reader }
const large = JSON.stringify({ title: 'Generated 中英文 🧪'.repeat(60000), project: 'fixture' })

it('isolates large parsing in a real Worker while the Host event loop remains available', async () => {
  const reader = decoder()
  let callbacks = 0
  const heartbeat = setInterval(() => callbacks++, 1)
  try {
    expect(await reader.parse(large)).toEqual(JSON.parse(large))
    expect(reader.stats().workersStarted).toBe(1)
    expect(await reader.parse(large)).toEqual(JSON.parse(large))
    expect(reader.stats().workersStarted).toBe(1)
    expect(callbacks).toBeGreaterThan(0)
    await vi.waitFor(() => expect(reader.stats()).toMatchObject({ active: 0, queued: 0, pendingBytes: 0 }))
  } finally { clearInterval(heartbeat) }
})

it('keeps small reads local and rejects invalid or oversized JSON without exposing its content', async () => {
  const reader = decoder()
  expect(await reader.parse('{"fixture":true}')).toEqual({ fixture: true })
  await expect(reader.parse('{"generated-private-title":')).rejects.toThrow(/^Remote catalog JSON is invalid$/)
  await expect(reader.parse('x'.repeat(catalogJsonLimit + 1))).rejects.toThrow('byte budget')
  expect(reader.stats()).toEqual({ active: 0, queued: 0, pendingBytes: 0, workersStarted: 0, workerDecodes: 0 })
})

it('bounds the queue, cancels queued work without starting it and retains the active slot until termination', async () => {
  const reader = decoder(), first = new AbortController(), queued = new AbortController()
  const a = reader.parse(large, first.signal), b = reader.parse(large, queued.signal), c = reader.parse(large)
  const rejectedA = expect(a).rejects.toMatchObject({ name: 'AbortError' })
  const rejectedB = expect(b).rejects.toMatchObject({ name: 'AbortError' })
  const busy = expect(reader.parse(large)).rejects.toThrow('busy')
  expect(reader.stats()).toMatchObject({ active: 1, queued: 2, workersStarted: 1 })
  queued.abort(); first.abort()
  expect(reader.stats()).toMatchObject({ active: 1, queued: 1, workersStarted: 1 })
  await Promise.all([rejectedA, rejectedB, busy])
  expect(await c).toEqual(JSON.parse(large))
  await vi.waitFor(() => expect(reader.stats()).toMatchObject({ active: 0, queued: 0, pendingBytes: 0, workersStarted: 2 }))
})

it('bounds retained bytes independently of request count', async () => {
  const reader = decoder(), a = new AbortController(), b = new AbortController()
  const text = JSON.stringify('x'.repeat(catalogJsonLimit - 32))
  const first = expect(reader.parse(text, a.signal)).rejects.toMatchObject({ name: 'AbortError' })
  const second = expect(reader.parse(text, b.signal)).rejects.toMatchObject({ name: 'AbortError' })
  const busy = expect(reader.parse(large)).rejects.toThrow('busy')
  expect(reader.stats()).toMatchObject({ active: 1, queued: 1, workersStarted: 1 })
  a.abort(); b.abort(); await Promise.all([first, second, busy])
  await vi.waitFor(() => expect(reader.stats().pendingBytes).toBe(0))
})

it('snapshots queued byte buffers and rejects malformed large UTF-8 without returning partial data',async()=>{
  const reader=decoder(),bytes=Buffer.from(large)
  const active=reader.parse(large),queued=reader.parse(bytes)
  bytes.fill(0x20)
  await active;expect(await queued).toEqual(JSON.parse(large))
  const invalid=Buffer.alloc(2*1024*1024,0x20);invalid[0]=0x22;invalid[1]=0xff;invalid[invalid.length-1]=0x22
  await expect(reader.parse(invalid)).rejects.toThrow(/^Remote catalog encoding is invalid$/)
  expect(await reader.parse(large)).toEqual(JSON.parse(large))
  expect(reader.stats().workersStarted).toBe(1)
})

it('retires the idle Worker and starts a new one without closing a newer job',async()=>{
  const reader=decoder()
  vi.useFakeTimers()
  try {await reader.parse(large);await vi.advanceTimersByTimeAsync(30000)}
  finally {vi.useRealTimers()}
  expect(await reader.parse(large)).toEqual(JSON.parse(large))
  expect(reader.stats().workersStarted).toBe(2)
})

it('counts actual response bytes and cancels overflow despite a smaller advertised length', async () => {
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array(catalogJsonLimit)); controller.enqueue(new Uint8Array(1))
  }, cancel })
  await expect(readCatalogJson(new Response(body, { headers: { 'content-length': '1' } }))).rejects.toThrow('byte budget')
  expect(cancel).toHaveBeenCalledOnce()
  await expect(readCatalogJson(new Response(new Uint8Array([0x22, 0xff, 0x22])))).rejects.toThrow('encoding')
})

it('cancels a stalled response body when its observer is disposed', async () => {
  const controller = new AbortController(), cancel = vi.fn()
  const pending = readCatalogJson(new Response(new ReadableStream({ cancel })), controller.signal)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort(); await rejected
  expect(cancel).toHaveBeenCalledOnce()
})

it('admits two Hosts, serializes one Host and never dispatches an aborted queued read', async () => {
  const controllers = Array.from({ length: 4 }, () => new AbortController())
  const gates = Array.from({ length: 3 }, () => {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    return { promise, resolve }
  })
  const calls: string[] = []
  const a = runCatalogRead('a', controllers[0]!.signal, async () => { calls.push('a'); await gates[0]!.promise })
  const skipped = runCatalogRead('a', controllers[1]!.signal, async () => { calls.push('never') })
  const b = runCatalogRead('b', controllers[2]!.signal, async () => { calls.push('b'); await gates[1]!.promise })
  const c = runCatalogRead('c', controllers[3]!.signal, async () => { calls.push('c'); await gates[2]!.promise })
  const rejected = expect(skipped).rejects.toMatchObject({ name: 'AbortError' })
  try {
    await vi.waitFor(() => expect(calls).toEqual(['a', 'b']))
    controllers[1]!.abort(); await rejected
    gates[1]!.resolve(); await b
    await vi.waitFor(() => expect(calls).toEqual(['a', 'b', 'c']))
  } finally { controllers.forEach(controller => controller.abort()); gates.forEach(gate => gate.resolve()); await Promise.allSettled([a, b, c, skipped]) }
})

it('rejects excess catalog observers before dispatch or response buffering',async()=>{
  const controllers=Array.from({length:11},()=>new AbortController())
  let release!:()=>void
  const first=runCatalogRead('one',controllers[0]!.signal,()=>new Promise<void>(resolve=>{release=resolve}))
  const dispatch=vi.fn(async()=>{})
  const queued=controllers.slice(1,8).map(controller=>runCatalogRead('one',controller.signal,dispatch))
  const rejected=queued.map(job=>expect(job).rejects.toMatchObject({name:'AbortError'}))
  try {
    await expect(runCatalogRead('extra',controllers[10]!.signal,dispatch)).rejects.toThrow('queue is full')
    const foreground = controllers.slice(8,10).map(controller=>runCatalogRead('one',controller.signal,dispatch,true))
    rejected.push(...foreground.map(job=>expect(job).rejects.toMatchObject({name:'AbortError'})))
    await expect(runCatalogRead('extra',controllers[10]!.signal,dispatch,true)).rejects.toThrow('queue is full')
    controllers.slice(1).forEach(controller=>controller.abort());await Promise.all(rejected)
    expect(dispatch).not.toHaveBeenCalled()
  } finally {controllers.forEach(controller=>controller.abort());release();await Promise.allSettled([first,...queued])}
})

it('promotes a shared queued catalog read ahead of background work without duplicating dispatch', async () => {
  const controller = new AbortController()
  let release!: () => void
  const active = runCatalogRead('promoted-host', controller.signal, () => new Promise<void>(resolve => { release = resolve }))
  const calls: string[] = []
  const background = Array.from({ length: 4 }, (_, n) => runCatalogRead('promoted-host', controller.signal, async () => { calls.push('background-' + n) }))
  const priority = { foreground: false }
  const selected = runCatalogRead('promoted-host', controller.signal, async () => { calls.push('selected') }, priority)
  try {
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    priority.foreground = true; release()
    await Promise.all([active, selected, ...background])
    // The fairness grant may admit one older observer first.
    expect(calls.indexOf('selected')).toBeLessThanOrEqual(1)
    expect(calls.filter(value => value === 'selected')).toHaveLength(1)
  } finally { controller.abort(); release(); await Promise.allSettled([active, selected, ...background]) }
})

it('gives an undispatched foreground observer one more queue window and sends its read once', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  let release!: () => void
  const active = runCatalogRead('waiting-host', controller.signal, () => new Promise<void>(resolve => { release = resolve }))
  const dispatch = vi.fn(async () => 'generated-result')
  const selected = runCatalogRead('waiting-host', controller.signal, dispatch, true)
  try {
    await vi.advanceTimersByTimeAsync(10001)
    expect(dispatch).not.toHaveBeenCalled()
    release(); await active
    expect(await selected).toBe('generated-result'); expect(dispatch).toHaveBeenCalledOnce()
  } finally { controller.abort(); release(); await Promise.allSettled([active, selected]); vi.useRealTimers() }
})

it('bounds foreground queue admission and never retries a dispatched read error', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  let release!: () => void
  const active = runCatalogRead('bounded-host', controller.signal, () => new Promise<void>(resolve => { release = resolve }))
  const dispatch = vi.fn(async () => {})
  const queued = runCatalogRead('bounded-host', controller.signal, dispatch, true)
  const rejected = expect(queued).rejects.toThrow('queue wait timed out')
  try {
    await vi.advanceTimersByTimeAsync(20001); await rejected; expect(dispatch).not.toHaveBeenCalled()
    release(); await active
    const failed = vi.fn(async () => { throw new Error('generated dispatched transport failure') })
    await expect(runCatalogRead('bounded-host', controller.signal, failed, true)).rejects.toThrow('transport failure')
    expect(failed).toHaveBeenCalledOnce()
  } finally { controller.abort(); release(); await Promise.allSettled([active, queued]); vi.useRealTimers() }
})
