import { lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { RemoteSessionCatalog } from './types.ts'

/** A private, replaceable navigation cache; corrupt source is kept for inspection. */
export class RemoteSessionCache {
  private entries: Record<string, RemoteSessionCatalog> = {}
  private issue?: string
  constructor(private path: string) {
    try {
      let info: ReturnType<typeof lstatSync>
      try { info = lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 8 * 1024 * 1024) throw new Error()
      const value = JSON.parse(readFileSync(path, 'utf8'))
      if (value.version !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) throw new Error()
      for (const [id, entry] of Object.entries(value.entries)) {
        if (!/^[a-f0-9]{24}$/.test(id) || !validCatalog(entry)) throw new Error()
      }
      this.entries = value.entries
    } catch { this.issue = 'The saved remote session list is unavailable. Its source was preserved.' }
  }
  get(id: string, workspaceId: string): RemoteSessionCatalog {
    const entry = this.entries[id]
    return { ...(entry?.workspaceId === workspaceId ? structuredClone(entry) : { workspaceId, sessions: [] }), stale: true,
      ...(this.issue ? { warning: this.issue } : {}) }
  }
  save(id: string, entry: RemoteSessionCatalog): void {
    if (this.issue) return
    const entries = { ...this.entries, [id]: entry }
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, entries }), { flag: 'wx', mode: 0o600 })
      renameSync(temporary, this.path); this.entries = entries
    } catch {
      try { unlinkSync(temporary) } catch {}
      this.issue = 'The remote session list could not be saved. Remote sessions are unchanged.'
    }
  }
}
function validCatalog(entry: unknown): entry is RemoteSessionCatalog {
  const x = entry as RemoteSessionCatalog
  return !!x && typeof x.workspaceId === 'string' && Array.isArray(x.sessions) && x.sessions.length <= 20000
    && typeof x.checkedAt === 'number' && Number.isFinite(x.checkedAt)
    && x.sessions.every(s => s && typeof s.sessionId === 'string' && s.sessionId.length > 0 && s.sessionId.length <= 256 && !/[\u0000-\u001f\u007f]/.test(s.sessionId)
      && typeof s.title === 'string' && s.title.length <= 1024 && typeof s.running === 'boolean' && typeof s.blank === 'boolean'
      && typeof s.updatedAt === 'number' && Number.isFinite(s.updatedAt))
}
