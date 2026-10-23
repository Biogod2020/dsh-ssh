import { CatalogReadError, catalogJsonLimit } from './catalog-json.ts'

export interface WorkspaceDirectory {
  items: Array<{ workspaceId: string; sessionIds: string[] }>
  archivedSessionIds: string[]
}
const invalid = () => new Error('Remote workspace directory is incompatible')
const maxRows = 20000, maxReferences = 100000
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 256) throw invalid()
  return value
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > maxReferences) throw invalid()
  const result = value.map(id)
  if (new Set(result).size !== result.length) throw invalid()
  return result
}
function row(value: any): WorkspaceDirectory['items'][number] {
  return { workspaceId: id(value?.workspaceId), sessionIds: ids(value?.sessionIds) }
}
function cost(value: WorkspaceDirectory['items'][number]) {
  return { bytes: Buffer.byteLength(JSON.stringify(value)), references: value.sessionIds.length }
}
/** The installed SDK's ordered workspace.follow projection. There is no
 * persistent remote cursor: a new socket must begin with a full baseline.
 * Keep only membership/archive fields used by the local session directory. */
export class WorkspaceDirectoryProjection {
  private rows = new Map<string, WorkspaceDirectory['items'][number]>()
  private removed = new Set<string>()
  private archived: string[] = []
  private archiveBytes = 2
  private bytes = 0
  private references = 0
  private current?: WorkspaceDirectory
  snapshot(): WorkspaceDirectory | undefined { return this.current }
  accept(frame: any): WorkspaceDirectory | undefined {
    const before = this.current
    if (frame?.type === 'baseline' || frame?.type === 'replace') {
      if (frame.type === 'baseline' && before) throw invalid()
      if (!before && frame.type !== 'baseline') throw invalid()
      if (!Array.isArray(frame.value?.items) || frame.value.items.length > maxRows) throw invalid()
      const next = new Map<string, WorkspaceDirectory['items'][number]>()
      let bytes = 0, references = 0
      for (const value of frame.value.items) {
        const view = row(value)
        if (next.has(view.workspaceId)) throw invalid()
        if (this.removed.has(view.workspaceId)) continue
        next.set(view.workspaceId, view)
        const size = cost(view); bytes += size.bytes; references += size.references
      }
      const archived = ids(frame.value.archivedSessionIds)
      this.check(next.size, bytes, references, archived)
      this.rows = next; this.bytes = bytes; this.references = references; this.archived = archived; this.archiveBytes = Buffer.byteLength(JSON.stringify(archived))
    } else {
      if (!before) throw invalid()
      if (frame?.type === 'upsert') {
        const view = row(frame.workspace)
        if (this.removed.has(view.workspaceId)) return undefined
        const old = this.rows.get(view.workspaceId)
        if (old && old.sessionIds.length === view.sessionIds.length && old.sessionIds.every((value, n) => value === view.sessionIds[n])) return undefined
        const previous = old ? cost(old) : { bytes: 0, references: 0 }, next = cost(view)
        const bytes = this.bytes - previous.bytes + next.bytes, references = this.references - previous.references + next.references
        this.check(this.rows.size + (old ? 0 : 1), bytes, references, this.archived)
        this.rows.set(view.workspaceId, view); this.bytes = bytes; this.references = references
      } else if (frame?.type === 'remove') {
        const workspaceId = id(frame.workspaceId), old = this.rows.get(workspaceId)
        if (!this.removed.has(workspaceId) && this.removed.size >= maxRows) throw new CatalogReadError('size')
        this.removed.add(workspaceId)
        if (!old) return undefined
        const previous = cost(old); this.rows.delete(workspaceId); this.bytes -= previous.bytes; this.references -= previous.references
      } else if (frame?.type === 'archived') {
        const archived = ids(frame.archivedSessionIds)
        this.check(this.rows.size, this.bytes, this.references, archived)
        if (archived.length === this.archived.length && archived.every((value, n) => value === this.archived[n])) return undefined
        this.archived = archived; this.archiveBytes = Buffer.byteLength(JSON.stringify(archived))
      } else if (frame?.type === 'order') {
        ids(frame.workspaceIds); return undefined // Session lists retain their existing updatedAt order.
      } else if (frame?.type === 'pinned') {
        ids(frame.pinnedSessionIds); return undefined // Pinning does not change project membership.
      } else throw invalid()
    }
    // Old snapshots stay detached when an increment arrives during a list RPC.
    // Manager revision checks decide whether that combined read may be saved.
    this.current = { items: [...this.rows.values()], archivedSessionIds: this.archived }
    return this.current
  }
  private check(rows: number, bytes: number, references: number, archived: string[]) {
    if (rows > maxRows || references > maxReferences || bytes + rows + 100 + (archived === this.archived ? this.archiveBytes : Buffer.byteLength(JSON.stringify(archived))) > catalogJsonLimit) throw new CatalogReadError('size')
  }
}
