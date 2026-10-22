import { createHash, randomUUID } from 'node:crypto'
import { mkdir, lstat, readFile, writeFile, rename, unlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface HistoryRecord { type: 'event'; event: { seq: number; type: string; [key: string]: unknown } }
export interface HistoryMeta {
  key: string; hostId: string; workspaceId: string; sessionId: string; alias: string; remotePath: string; title: string
  savedAt: number; firstSavedAt: number; remoteUpdatedAt: number; cursor: number; complete: boolean; bytes: number; records: number
}
export interface HistoryDocument { meta: HistoryMeta; records: HistoryRecord[] }
export const historyKey = (hostId: string, workspaceId: string, sessionId: string) => createHash('sha256').update(JSON.stringify([hostId, workspaceId, sessionId])).digest('hex')
const isKey = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const validMeta = (value: HistoryMeta) => value && isKey(value.key) && typeof value.hostId === 'string' && typeof value.workspaceId === 'string'
  && typeof value.sessionId === 'string' && historyKey(value.hostId, value.workspaceId, value.sessionId) === value.key
  && typeof value.alias === 'string' && typeof value.remotePath === 'string' && typeof value.title === 'string'
  && [value.savedAt, value.firstSavedAt, value.remoteUpdatedAt, value.bytes, value.records].every(x => Number.isFinite(x) && x >= 0)
  && Number.isSafeInteger(value.cursor) && value.cursor >= -1 && typeof value.complete === 'boolean'
export function validHistory(records: HistoryRecord[], cursor: number): boolean {
  if (!Array.isArray(records) || !Number.isSafeInteger(cursor) || cursor < -1) return false
  return records.every((row, n) => row?.type === 'event' && row.event && typeof row.event.type === 'string'
    && Number.isSafeInteger(row.event.seq) && row.event.seq >= 0 && row.event.seq <= cursor
    && (n === 0 || row.event.seq === records[n - 1]!.event.seq + 1))
    && (records.length === 0 ? cursor === -1 : records.at(-1)!.event.seq === cursor)
}

/** Permanent private disk copies. No TTL, quota eviction, credentials or executable state. */
export class RemoteHistoryCache {
  private entries = new Map<string, HistoryMeta>()
  private chain: Promise<unknown> = Promise.resolve()
  private ready: Promise<void>
  private revision = 0
  private snoozedUntil = 0
  private issue?: string
  constructor(private root: string) { this.ready = this.load() }
  private async privateFile(path: string): Promise<boolean> {
    try { const info = await lstat(path); if (!info.isFile() || (info.mode & 0o077)) throw new Error('Unsafe cache file'); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }
  private async load(): Promise<void> {
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const info = await lstat(this.root)
      if (!info.isDirectory() || (info.mode & 0o077)) throw new Error('Unsafe cache directory')
      const path = join(this.root, 'index.json')
      if (await this.privateFile(path)) {
        const value = JSON.parse(await readFile(path, 'utf8'))
        if (value.version !== 1 || !Array.isArray(value.entries) || !value.entries.every(validMeta)) throw new Error('Invalid history index')
        this.entries = new Map(value.entries.map((entry: HistoryMeta) => [entry.key, entry]))
        if (Number.isFinite(value.snoozedUntil)) this.snoozedUntil = value.snoozedUntil
      }
      // Recover a data file committed just before a controller crash, so it
      // remains visible and selectively clearable rather than becoming orphaned.
      for (const name of await readdir(this.root)) if (/^[a-f0-9]{64}\.json$/.test(name) && !this.entries.has(name.slice(0, -5))) {
        const file = join(this.root, name)
        if (!await this.privateFile(file)) continue
        const document = JSON.parse(await readFile(file, 'utf8')) as HistoryDocument
        if (!validMeta(document.meta) || document.meta.key + '.json' !== name || !validHistory(document.records, document.meta.cursor)) throw new Error('Invalid history file')
        this.entries.set(document.meta.key, document.meta)
      }
    } catch { this.issue = 'Local history cache is unavailable. Its files were preserved.' }
  }
  token(): number { return this.revision }
  async meta(key: string): Promise<HistoryMeta | undefined> { await this.ready; const value = this.entries.get(key); return value ? { ...value } : undefined }
  current(token: number): boolean { return token === this.revision }
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => { await this.ready; if (this.issue) throw new Error(this.issue); return fn() })
    this.chain = next.catch(() => {}); return next
  }
  private async atomic(path: string, value: unknown): Promise<void> {
    if (await this.privateFile(path)) { /* Refuse symlinks and publicly readable replacements. */ }
    const temporary = `${path}.${randomUUID()}.tmp`
    try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await rename(temporary, path) }
    finally { await unlink(temporary).catch(() => {}) }
  }
  private index(): Promise<void> { return this.atomic(join(this.root, 'index.json'), { version: 1, entries: [...this.entries.values()], snoozedUntil: this.snoozedUntil }) }
  async list() {
    await this.ready; await this.chain
    const entries = [...this.entries.values()].map(x => ({ ...x })).sort((a, b) => b.savedAt - a.savedAt)
    const bytes = entries.reduce((sum, x) => sum + x.bytes, 0), now = Date.now()
    const reasons = [bytes >= 512 * 1024 * 1024 ? 'size' : '', entries.length >= 100 ? 'count' : '',
      entries.some(x => now - x.firstSavedAt >= 30 * 86400000) ? 'age' : ''].filter(Boolean)
    return { entries, bytes, reminder: reasons.length > 0 && now >= this.snoozedUntil, reasons, warning: this.issue }
  }
  async read(key: string): Promise<HistoryDocument | undefined> {
    await this.ready; await this.chain
    if (this.issue) throw new Error(this.issue)
    if (!isKey(key)) throw new Error('Invalid history cache identity')
    const meta = this.entries.get(key); if (!meta) return undefined
    const path = join(this.root, key + '.json')
    if (!await this.privateFile(path)) return undefined
    const document = JSON.parse(await readFile(path, 'utf8')) as HistoryDocument
    if (!validMeta(document.meta) || document.meta.key !== key || !validHistory(document.records, document.meta.cursor)) throw new Error('Local history is damaged; original file was preserved')
    return document
  }
  async save(meta: Omit<HistoryMeta, 'bytes' | 'records' | 'firstSavedAt'>, records: HistoryRecord[], token: number): Promise<boolean> {
    return this.queue(async () => {
      if (!this.current(token)) return false
      if (!validHistory(records, meta.cursor) || (meta.complete && records.length && records[0]!.event.seq !== 0)) throw new Error('History has a gap; it was not cached')
      const entry: HistoryMeta = { ...meta, bytes: 0, records: records.length, firstSavedAt: this.entries.get(meta.key)?.firstSavedAt ?? Date.now() }
      if (!validMeta(entry)) throw new Error('Invalid history cache metadata')
      entry.bytes = Buffer.byteLength(JSON.stringify({ meta: entry, records }))
      entry.bytes = Buffer.byteLength(JSON.stringify({ meta: entry, records }))
      await this.atomic(join(this.root, meta.key + '.json'), { meta: entry, records })
      this.entries.set(meta.key, entry); await this.index(); return true
    })
  }
  async clear(keys: string[]): Promise<void> {
    if (!Array.isArray(keys) || keys.some(key => !isKey(key))) throw new Error('Invalid history selection')
    ++this.revision // Fence all older background writes before waiting for IO.
    await this.queue(async () => {
      for (const key of new Set(keys)) {
        const path = join(this.root, key + '.json')
        if (await this.privateFile(path)) await unlink(path)
        this.entries.delete(key)
      }
      await this.index()
    })
  }
  async snooze(): Promise<void> { await this.queue(async () => { this.snoozedUntil = Date.now() + 7 * 86400000; await this.index() }) }
}
