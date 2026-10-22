import { RemoteHistoryCache, historyKey, validHistory, type HistoryRecord } from './history-cache.ts'
import type { RemoteGateway } from './gateway.ts'
import type { RemoteWorkspace } from './types.ts'

interface Source { gateway: RemoteGateway; check(): void; title: string; updatedAt: number }
export class RemoteHistoryService {
  private jobs = new Map<string, { token: number; promise: Promise<void> }>()
  private paused = new Set<string>()
  private failures = new Map<string, string>()
  constructor(readonly cache: RemoteHistoryCache, private source: (item: RemoteWorkspace, sessionId: string) => Promise<Source>) {}
  async status() { return { ...await this.cache.list(), syncing: [...this.jobs.keys()], failures: Object.fromEntries(this.failures) } }
  async clear(keys: string[]): Promise<void> {
    for (const key of keys) { this.paused.add(key); this.failures.delete(key) }
    await this.cache.clear(keys)
  }
  sync(item: RemoteWorkspace, sessionId: string, explicit = true, hintUpdatedAt?: number): Promise<void> {
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
      if (!explicit && (!meta || meta.complete && hintUpdatedAt !== undefined && meta.remoteUpdatedAt >= hintUpdatedAt)) return
      const source = await this.source(item, sessionId)
      const check = () => { source.check(); if (!this.cache.current(token)) throw new Error('Local history copy was cleared; background sync stopped') }
      check()
      if (meta?.complete && meta.remoteUpdatedAt >= source.updatedAt) return
      const cached = await this.cache.read(key)
      const opening = await source.gateway.historySnapshot(sessionId)
      check()
      if (!validHistory(opening.records, opening.cursor)) throw new Error('Remote history is discontinuous; cached copy was preserved')
      if (cached && opening.cursor < cached.meta.cursor) throw new Error('Remote history moved backwards; cached copy was preserved')
      const records = new Map<number, HistoryRecord>()
      const merge = (rows: HistoryRecord[]) => {
        for (const record of rows) {
          const previous = records.get(record.event.seq)
          if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new Error('Remote history changed; cached copy was preserved')
          records.set(record.event.seq, record)
        }
      }
      if (cached) merge(cached.records)
      merge(opening.records)
      let before = opening.records[0]?.event.seq ?? 0, more = opening.hasMore
      const metadata = () => ({ key, hostId: item.hostId, workspaceId: item.workspaceId, sessionId, alias: item.alias, remotePath: item.remotePath,
        title: source.title || sessionId, savedAt: Date.now(), remoteUpdatedAt: source.updatedAt, cursor: opening.cursor, complete: !more })
      let pages = 0
      while (more && (!cached?.meta.complete || before > cached.meta.cursor + 1)) {
        if (!cached && pages % 10 === 0) await this.cache.save(metadata(), [...records.values()].sort((a, b) => a.event.seq - b.event.seq), token)
        check()
        const page = await source.gateway.rpc<{ records: HistoryRecord[]; hasMore: boolean }>('session/page', {
          request: { address: { kind: 'session', sessionId }, throughSeq: opening.cursor, beforeSeq: before, maxMessages: 500 },
        })
        check()
        if (!Array.isArray(page.records) || !page.records.length || !validHistory(page.records, before - 1) || typeof page.hasMore !== 'boolean') throw new Error('Remote history page has a gap')
        merge(page.records); before = page.records[0]!.event.seq; more = page.hasMore; pages++
      }
      const joined = [...records.values()].sort((a, b) => a.event.seq - b.event.seq)
      if (!validHistory(joined, opening.cursor) || (joined.length && joined[0]!.event.seq !== 0)) throw new Error('History is incomplete; previous local copy was preserved')
      more = false; check(); await this.cache.save(metadata(), joined, token); this.failures.delete(key)
    })().catch(error => {
      if (this.cache.current(token)) this.failures.set(key, error instanceof Error ? error.message : 'Local history sync failed')
    }).finally(() => { if (this.jobs.get(key) === job) this.jobs.delete(key) })
    this.jobs.set(key, job); return job.promise
  }
}
