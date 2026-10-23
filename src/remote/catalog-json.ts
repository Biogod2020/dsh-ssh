import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { HistoryReadScheduler } from './history-read-scheduler.ts'

export const catalogJsonLimit = 8 * 1024 * 1024
const readErrors = {
  size: 'Remote catalog exceeds its 8 MiB byte budget; saved lists were preserved',
  encoding: 'Remote catalog encoding is invalid', syntax: 'Remote catalog JSON is invalid',
  busy: 'Remote catalog decoder is busy; saved lists were preserved', closed: 'Catalog decoder is closed',
  timeout: 'Remote catalog decoding exceeded its total wait budget', worker: 'Remote catalog decoder failed; saved lists were preserved',
  queue: 'Remote catalog read queue is full; saved lists were preserved', 'queue-timeout': 'Remote catalog queue wait timed out',
  'stream-timeout': 'Remote catalog observer stopped responding; saved lists were preserved',
  backlog: 'Remote catalog observer exceeded its backlog budget; saved lists were preserved',
} as const
/** Only these local, fixed messages may be shown with a saved directory.
 * Arbitrary remote errors and JSON content never enter this diagnostic. */
export class CatalogReadError extends Error {
  constructor(readonly code: keyof typeof readErrors) { super(readErrors[code]); this.name = 'CatalogReadError' }
}
// Small directories are cheaper to decode locally than to clone across a
// thread boundary. The fixed-data benchmark keeps this choice reviewable.
const inlineLimit = 1024 * 1024
const pendingLimit = 16 * 1024 * 1024
const source = new URL('data:text/javascript,' + encodeURIComponent(`
import { parentPort } from 'node:worker_threads';
parentPort.on('message', ({ id, input }) => {
  let phase = 'encoding';
  try {
    const text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input);
    phase = 'json'; const value = JSON.parse(text);
    phase = 'clone'; parentPort.postMessage({ id, ok: true, value });
  } catch { parentPort.postMessage({ id, ok: false, phase }); }
});
`))
const cancelled = () => new DOMException('Catalog read cancelled', 'AbortError')
interface Job {
  id: string; input: string | Uint8Array; bytes: number; settled: boolean; released: boolean
  resolve(value: unknown): void; reject(error: Error): void
  signal?: AbortSignal; abort(): void; timer?: ReturnType<typeof setTimeout>; worker?: Worker
}

/** CPU isolation for large controller-owned reads. No RPC or disk access lives
 * in the Worker. Limits apply across Hosts, not separately to each request. */
export class CatalogJsonReader {
  private active?: Job
  private queue: Job[] = []
  private bytes = 0
  private closed = false
  private workers = 0
  private workerDecodes = 0
  private worker?: Worker
  private retiring = false
  private idle?: ReturnType<typeof setTimeout>
  stats() { return { active: this.active ? 1 : 0, queued: this.queue.length, pendingBytes: this.bytes, workersStarted: this.workers, workerDecodes: this.workerDecodes } }
  async parse(input: string | Uint8Array, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new CatalogReadError('closed')
    if (signal?.aborted) throw cancelled()
    const bytes = typeof input === 'string' ? Buffer.byteLength(input) : input.byteLength
    if (bytes > catalogJsonLimit) throw new CatalogReadError('size')
    if (bytes <= inlineLimit) {
      let text: string
      try { text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input) }
      catch { throw new CatalogReadError('encoding') }
      try { return JSON.parse(text) } catch { throw new CatalogReadError('syntax') }
    }
    if (this.queue.length >= 2 || this.bytes + bytes > pendingLimit) throw new CatalogReadError('busy')
    return new Promise((resolve, reject) => {
      const job: Job = { id: randomUUID(), input: typeof input === 'string' ? input : new Uint8Array(input), bytes, resolve, reject, signal, settled: false, released: false, abort: () => this.finish(job, cancelled(), undefined, true) }
      this.bytes += bytes; this.queue.push(job)
      // This is an end-to-end decoder budget, including queue wait; it does
      // not promise five additional seconds after a delayed Worker starts.
      job.timer = setTimeout(() => this.finish(job, new CatalogReadError('timeout'), undefined, true), 5000)
      signal?.addEventListener('abort', job.abort, { once: true })
      if (signal?.aborted) job.abort()
      this.pump()
    })
  }
  private release(job: Job): void {
    if (job.released) return
    job.released = true; this.bytes -= job.bytes; job.input = ''
    if (this.active === job) this.active = undefined
    else this.queue = this.queue.filter(value => value !== job)
    this.pump()
  }
  private finish(job: Job, error?: Error, value?: unknown, terminate = false): void {
    if (job.settled) return
    job.settled = true; clearTimeout(job.timer); job.signal?.removeEventListener('abort', job.abort)
    if (error) job.reject(error); else job.resolve(value)
    // A completed parse can reuse the thread. Cancellation instead keeps its
    // reservation until confirmed exit; late results cannot affect a new job.
    if (terminate && job.worker) this.retire(job.worker)
    else this.release(job)
  }
  private retire(worker: Worker): void {
    if (this.worker !== worker || this.retiring) return
    this.retiring = true; clearTimeout(this.idle)
    void worker.terminate().catch(() => { /* Retain reservations until a confirmed exit. */ })
  }
  private createWorker(): Worker {
    const worker = new Worker(source, { env: {}, stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } })
    this.worker = worker; this.workers++
    worker.stdout.resume(); worker.stderr.resume()
    worker.on('message', result => {
      const job = this.active
      if (this.worker !== worker || !job || job.worker !== worker || job.id !== result?.id || job.settled) return
      this.workerDecodes++
      if (result.ok !== true) this.finish(job, new CatalogReadError(result.phase === 'encoding' ? 'encoding' : result.phase === 'json' ? 'syntax' : 'worker'))
      else this.finish(job, undefined, result.value)
    })
    worker.once('error', () => {
      const job = this.active
      if (job?.worker === worker) this.finish(job, new CatalogReadError('worker'), undefined, true)
      else this.retire(worker)
    })
    worker.once('exit', () => {
      if (this.worker !== worker) return
      clearTimeout(this.idle); this.worker = undefined; this.retiring = false
      const job = this.active
      if (job?.worker === worker) {
        if (!job.settled) this.finish(job, new CatalogReadError('worker'))
        this.release(job)
      } else this.pump()
    })
    return worker
  }
  private pump(): void {
    if (this.closed || this.active || this.retiring) return
    clearTimeout(this.idle)
    const job = this.queue.shift()
    if (!job) {
      const worker = this.worker
      if (worker) {
        worker.unref()
        this.idle = setTimeout(() => { if (!this.active && !this.queue.length) this.retire(worker) }, 30000)
        this.idle.unref()
      }
      return
    }
    this.active = job
    try {
      const worker = this.worker ?? this.createWorker()
      job.worker = worker; worker.ref(); worker.postMessage({ id: job.id, input: job.input })
    } catch { this.finish(job, new CatalogReadError('worker'), undefined, true) }
  }
  close(): void {
    this.closed = true
    clearTimeout(this.idle)
    for (const job of [...this.queue, ...(this.active ? [this.active] : [])]) this.finish(job, cancelled(), undefined, true)
    if (this.worker) this.retire(this.worker)
  }
}

export const catalogJsonReader = new CatalogJsonReader()
const catalogReads = new HistoryReadScheduler()
let pendingReads = 0

/** Limit reception as well as CPU work: two reads globally and one per Host.
 * Only explicitly read-only calls use this lane. A cancelled queued observer
 * never dispatches, and active requests retain their existing protocol deadline. */
export async function runCatalogRead<T>(hostId: string, signal: AbortSignal, read: () => Promise<T>, foreground = false): Promise<T> {
  if (signal.aborted) throw cancelled()
  if (pendingReads >= 10) throw new CatalogReadError('queue')
  const key = 'catalog-' + randomUUID()
  let dispatched = false
  pendingReads++
  const abort = () => catalogReads.cancel(key, cancelled())
  const deadline = setTimeout(() => { if (!dispatched) catalogReads.cancel(key, new CatalogReadError('queue-timeout')) }, 10000)
  signal.addEventListener('abort', abort, { once: true })
  try {
    const result = catalogReads.run({ key, hostId, foreground }, async () => {
      dispatched = true; clearTimeout(deadline)
      if (signal.aborted) throw cancelled()
      return read()
    })
    if (signal.aborted) abort()
    return await result
  } finally { pendingReads--; clearTimeout(deadline); signal.removeEventListener('abort', abort) }
}

/** Count decompressed response bytes before decoding; Content-Length is not a
 * trusted budget. No oversized or invalid response is partially published. */
export async function readCatalogJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const body = response.body
  if (!body) throw new CatalogReadError('syntax')
  if (signal?.aborted) { await body.cancel().catch(() => {}); throw cancelled() }
  const reader = body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      const result = await reader.read()
      if (signal?.aborted) throw cancelled()
      if (result.done) break
      bytes += result.value.byteLength
      if (bytes > catalogJsonLimit) { await reader.cancel(); throw new CatalogReadError('size') }
      chunks.push(result.value)
    }
  } finally { signal?.removeEventListener('abort', abort); reader.releaseLock() }
  return catalogJsonReader.parse(Buffer.concat(chunks, bytes), signal)
}
