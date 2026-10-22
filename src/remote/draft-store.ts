import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, lstat, open, rename, unlink, link } from 'node:fs/promises'
import { join } from 'node:path'

export interface SavedDraft {
  version: 1; hostId: string; sessionId: string; revision: string; operationId: string
  text: string; hadReferences: boolean; hadAttachments: boolean; savedAt: number
}
export interface DraftWrite {
  expectedRevision: string | null; operationId: string; text: string; hadReferences: boolean; hadAttachments: boolean
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuid.test(value)
const maxTextBytes = 8 * 1024 * 1024
function identity(hostId: string, sessionId: string): string {
  if (typeof hostId !== 'string' || !/^[a-f0-9]{24}$/.test(hostId) || typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 || /[\u0000-\u001f\u007f]/.test(sessionId)) throw new Error('Invalid draft identity')
  return createHash('sha256').update(JSON.stringify([hostId, sessionId])).digest('hex')
}
const flags = (value: { hadReferences: unknown; hadAttachments: unknown }) => typeof value.hadReferences === 'boolean' && typeof value.hadAttachments === 'boolean'
export class DraftConflictError extends Error {
  constructor() { super('The saved draft changed in another view. Both copies were preserved; choose which draft to keep.'); this.name = 'DraftConflictError' }
}

/** Local text drafts are independent of remote logs and browser origins.
 * Empty drafts retain a revision so a late request cannot undo an explicit clear. */
export class LocalDraftStore {
  private readonly owner = randomUUID()
  private ready: Promise<void>
  private chain: Promise<unknown> = Promise.resolve()
  private writer = false
  private stopping?: Promise<void>
  private issue?: string
  constructor(private readonly root: string) {
    this.ready = (async () => {
      await mkdir(root, { recursive: true, mode: 0o700 })
      const info = await lstat(root)
      if (!info.isDirectory() || info.mode & 0o077) throw new Error('Draft directory must be private')
    })()
    // Lazy consumers still observe the original rejection, without an unused
    // store producing an unhandled process-level rejection before first use.
    void this.ready.catch(() => {})
  }
  get writeIssue(): string | undefined { return this.issue }
  private async bytes(path: string): Promise<Buffer | undefined> {
    let file
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    try {
      const info = await file.stat()
      if (!info.isFile() || info.mode & 0o077 || info.size > 64 * 1024 * 1024) throw new Error('Unsafe or oversized saved draft')
      return await file.readFile()
    } finally { await file.close() }
  }
  private async syncDirectory(): Promise<void> {
    const directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY)
    try { await directory.sync() } finally { await directory.close() }
  }
  async read(hostId: string, sessionId: string): Promise<SavedDraft | undefined> {
    const key = identity(hostId, sessionId); await this.ready
    const raw = await this.bytes(join(this.root, key + '.json'))
    if (!raw) return
    const value = JSON.parse(raw.toString()) as SavedDraft
    if (!value || value.version !== 1 || value.hostId !== hostId || value.sessionId !== sessionId || !isUuid(value.revision)
      || !isUuid(value.operationId) || typeof value.text !== 'string' || Buffer.byteLength(value.text) > maxTextBytes || !flags(value)
      || !Number.isSafeInteger(value.savedAt) || value.savedAt < 0) throw new Error('Saved draft is damaged; its file was preserved')
    return value
  }
  private async acquire(): Promise<void> {
    if (this.writer) return
    const temporary = join(this.root, 'owner-' + randomUUID() + '.tmp'), lock = join(this.root, 'writer.lock')
    const file = await open(temporary, 'wx', 0o600)
    try {
      try { await file.writeFile(JSON.stringify({ pid: process.pid, owner: this.owner })); await file.sync() } finally { await file.close() }
      try { await link(temporary, lock) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const guard = join(this.root, 'recovery.lock')
        try { await link(temporary, guard) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Draft lock recovery needs inspection; saved drafts remain readable')
          throw error
        }
        try {
          const raw = await this.bytes(lock)
          if (!raw) throw new Error('Draft writer changed during recovery')
          const previous = JSON.parse(raw.toString())
          if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0 || !isUuid(previous.owner)) throw new Error('Draft writer lock needs inspection')
          try { process.kill(previous.pid, 0); throw new Error('Another draft writer is active; saved drafts remain readable') }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
          if (!raw.equals((await this.bytes(lock)) ?? Buffer.alloc(0))) throw new Error('Draft writer changed during recovery')
          await unlink(lock); await link(temporary, lock)
        } finally { await unlink(guard); await this.syncDirectory() }
      }
      this.writer = true
      await this.syncDirectory()
    } finally { await unlink(temporary) }
  }
  write(hostId: string, sessionId: string, input: DraftWrite): Promise<SavedDraft> {
    const key = identity(hostId, sessionId)
    if (!input || input.expectedRevision !== null && !isUuid(input.expectedRevision) || !isUuid(input.operationId)
      || typeof input.text !== 'string' || Buffer.byteLength(input.text) > maxTextBytes || !flags(input)) throw new Error('Invalid or oversized text draft; current input was preserved')
    // Own the caller's snapshot before waiting behind another commit.
    const snapshot = { ...input }
    if (this.stopping) return Promise.reject(new Error('Draft writer is closing'))
    const next = this.chain.then(async () => {
      await this.ready
      if (this.issue) throw new Error(this.issue)
      await this.acquire()
      const current = await this.read(hostId, sessionId)
      if (current?.operationId === snapshot.operationId) {
        if (current.text !== snapshot.text || current.hadReferences !== snapshot.hadReferences || current.hadAttachments !== snapshot.hadAttachments) throw new DraftConflictError()
        return current
      }
      if ((current?.revision ?? null) !== snapshot.expectedRevision) throw new DraftConflictError()
      const value: SavedDraft = { version: 1, hostId, sessionId, revision: randomUUID(), operationId: snapshot.operationId,
        text: snapshot.text, hadReferences: snapshot.hadReferences, hadAttachments: snapshot.hadAttachments, savedAt: Date.now() }
      const path = join(this.root, key + '.json'), temporary = path + '.' + randomUUID() + '.tmp'
      let published = false
      try {
        const file = await open(temporary, 'wx', 0o600)
        try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
        await rename(temporary, path); published = true
        await this.syncDirectory(); return value
      } catch (error) {
        if (published) this.issue = 'Draft write could not be confirmed. Keep this view open and reopen storage before more writes.'
        throw error
      } finally {
        await unlink(temporary).catch(error => {
          if (error.code !== 'ENOENT') {
            if (published) this.issue = 'Draft write cleanup failed. Keep this view open and reopen storage before more writes.'
            throw error
          }
        })
      }
    })
    this.chain = next.catch(() => {}); return next
  }
  close(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = (async () => {
      await this.chain; await this.ready
      if (!this.writer) return
      const path = join(this.root, 'writer.lock'), raw = await this.bytes(path)
      const value = raw && JSON.parse(raw.toString())
      if (!value || value.owner !== this.owner || value.pid !== process.pid) throw new Error('Draft writer ownership changed; lock was preserved')
      await unlink(path); this.writer = false; await this.syncDirectory()
    })()
    return this.stopping
  }
}
