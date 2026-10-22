import { RemoteHistoryCache, historyKey, validHistory, type HistoryRecord, type HistoryDocument } from './history-cache.ts'
import type { RemoteGateway } from './gateway.ts'
import type { RemoteWorkspace } from './types.ts'
import type { HistoryDelta } from './history-reader.ts'

interface Source { gateway: RemoteGateway; delta(afterSeq: number, throughSeq?: number): Promise<HistoryDelta>; check(): void; title: string; updatedAt: number }
export class RemoteHistoryService {
  private jobs = new Map<string, { token: number; promise: Promise<void> }>()
  private checked = new Map<string, number>()
  private reading = 0
  private waiting: Array<() => void> = []
  private async read<T>(fn: () => Promise<T>): Promise<T> {
    if (this.reading >= 2) await new Promise<void>(resolve => this.waiting.push(resolve))
    else this.reading++
    try { return await fn() }
    finally { const next = this.waiting.shift(); if (next) next(); else this.reading-- }
  }
  private paused = new Set<string>()
  private failures = new Map<string, string>()
  constructor(readonly cache: RemoteHistoryCache, private source: (item: RemoteWorkspace, sessionId: string) => Promise<Source>) {}
  async status() { return { ...await this.cache.list(), syncing: [...this.jobs.keys()], failures: Object.fromEntries(this.failures) } }
  async clear(keys: string[]): Promise<void> {
    for (const key of keys) { this.paused.add(key); this.failures.delete(key); this.checked.delete(key) }
    await this.cache.clear(keys)
  }
  sync(item: RemoteWorkspace, sessionId: string, explicit = true, hintUpdatedAt?: number, running = false): Promise<void> {
    if (!sessionId || sessionId.length > 256 || /[\u0000-\u001f\u007f]/.test(sessionId)) return Promise.resolve()
    const key = historyKey(item.hostId, item.workspaceId, sessionId)
    if (explicit) this.paused.delete(key)
    else if (this.paused.has(key)) return Promise.resolve()
    const existing = this.jobs.get(key)
    if (existing && this.cache.current(existing.token)) return existing.promise
    const token = this.cache.token()
    const job = { token, promise: undefined as unknown as Promise<void> }
    job.promise = (async () => {
      const meta = await this.cache.meta(key)
      if (!explicit && (!meta || meta.complete && meta.remoteUpdatedAt >= (hintUpdatedAt ?? 0)
        && Date.now() - (this.checked.get(key) ?? -Infinity) < (running ? 5000 : 30000))) return
      const source = await this.source(item, sessionId)
      const check = () => { source.check(); if (!this.cache.current(token)) throw new Error('Local history copy was cleared; background sync stopped') }
      check()
      let opening: HistoryDelta | undefined
      if (meta?.complete && await this.cache.present(key)) {
        opening = await this.read(() => { check(); return source.delta(meta.cursor, undefined) })
        check()
        if (opening.cursor === meta.cursor && opening.throughSeq === meta.cursor && Array.isArray(opening.records) && !opening.records.length
          && meta.title === (source.title || sessionId) && meta.remoteUpdatedAt === source.updatedAt) {
          this.checked.set(key, Date.now()); this.failures.delete(key); return
        }
      }
      let cached: HistoryDocument | undefined = await this.cache.read(key)
      if (opening && cached?.meta.cursor !== meta?.cursor) opening = undefined
      // Finish older suffix checkpoints without fetching their saved tail again.
      if (cached && cached.records.length && cached.records[0]!.event.seq > 0) {
        while (cached.records[0]!.event.seq > 0) {
          const before: number = cached.records[0]!.event.seq, cursor: number = cached.meta.cursor
          const page: { records: HistoryRecord[]; hasMore: boolean } = await this.read(() => { check(); return source.gateway.rpc<{ records: HistoryRecord[]; hasMore: boolean }>('session/page', {
            request: { address: { kind: 'session', sessionId }, throughSeq: cursor, beforeSeq: before, maxMessages: 500 },
          }) })
          check()
          if (!page.records?.length || !validHistory(page.records, before - 1)
            || page.hasMore !== (page.records[0]!.event.seq > 0)) throw new Error('Remote history page has a gap; saved copy was preserved')
          const records: HistoryRecord[] = [...page.records, ...cached.records]
          await this.cache.save({ ...cached.meta, complete: !page.hasMore, savedAt: Date.now() }, records, token)
          check(); cached = { meta: (await this.cache.meta(key))!, records }
        }
      }
      let after = cached?.meta.cursor ?? -1, head: number | undefined
      for (;;) {
        const delta = opening ?? await this.read(() => { check(); return source.delta(after, head) })
        opening = undefined
        check()
        if (!Number.isSafeInteger(delta.cursor) || delta.cursor < after || head !== undefined && delta.cursor !== head
          || !Number.isSafeInteger(delta.throughSeq) || delta.throughSeq < after || delta.throughSeq > delta.cursor
          || !Array.isArray(delta.records) || (delta.records.length ? !validHistory(delta.records, delta.throughSeq)
            || delta.records[0]!.event.seq !== after + 1 : delta.throughSeq !== after || delta.cursor !== after)) throw new Error('Remote history delta has a gap; saved copy was preserved')
        head = delta.cursor
        const records = [...(cached?.records ?? []), ...delta.records]
        const complete = delta.throughSeq === head
        // Unchanged validation sends no history and does not rewrite its file.
        if (delta.records.length || !cached || !cached.meta.complete || cached.meta.title !== (source.title || sessionId)
          || cached.meta.remoteUpdatedAt !== source.updatedAt) {
          await this.cache.save({ key, hostId: item.hostId, workspaceId: item.workspaceId, sessionId, alias: item.alias, remotePath: item.remotePath,
            title: source.title || sessionId, savedAt: Date.now(), remoteUpdatedAt: source.updatedAt, cursor: delta.throughSeq, complete }, records, token)
          check()
          cached = { meta: { ...((await this.cache.meta(key))!) }, records }
        }
        if (complete) break
        if (delta.throughSeq === after) throw new Error('Remote history delta did not advance')
        after = delta.throughSeq
      }
      this.checked.set(key, Date.now()); this.failures.delete(key)
    })().catch(error => {
      if (this.cache.current(token)) this.failures.set(key, error instanceof Error ? error.message : 'Local history sync failed')
    }).finally(() => { if (this.jobs.get(key) === job) this.jobs.delete(key) })
    this.jobs.set(key, job); return job.promise
  }
}
