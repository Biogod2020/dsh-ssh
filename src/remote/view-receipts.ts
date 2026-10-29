import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, lstat, open, link, unlink, opendir } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { isPrivateMode } from '../private-mode.ts'

/** This is a local observation id, not a replayable command or remote RPC id. */
export interface ViewReceiptInput {
  observationId: string
  startedAt: number
  endedAt: number
  transport: 'http' | 'stream'
  category: 'session' | 'workspace' | 'terminal' | 'files' | 'settings' | 'other'
  selectedSessionIdAtDispatch?: string
}
export interface ViewReceipt extends ViewReceiptInput {
  version: 1
  hostId: string
  outcome: 'unconfirmed'
}
export interface ViewReceiptPage { entries: ViewReceipt[]; next?: string; issue?: string }
export class ViewReceiptConflictError extends Error {
  constructor() { super('Observation identity already holds different metadata'); this.name = 'ViewReceiptConflictError' }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const hashPattern = /^[a-f0-9]{64}$/
const categories = ['session', 'workspace', 'terminal', 'files', 'settings', 'other']
const fields = ['observationId', 'startedAt', 'endedAt', 'transport', 'category', 'selectedSessionIdAtDispatch']
function host(value: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value)) throw new Error('Invalid receipt Host')
  return value
}
function key(hostId: string, id: string): string {
  host(hostId)
  if (typeof id !== 'string' || !uuid.test(id)) throw new Error('Invalid observation identity')
  return createHash('sha256').update(JSON.stringify([hostId, id])).digest('hex')
}
function canonical(hostId: string, value: ViewReceiptInput): ViewReceipt {
  // A separate whitelist prevents args, URLs, commands or credential fields
  // from silently entering this storage through an untyped HTTP caller.
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ended observation')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some(name => typeof name !== 'string' || !fields.includes(name))
    || Object.values(descriptors).some(item => !('value' in item))) throw new Error('Invalid ended observation')
  value = Object.fromEntries(Object.entries(descriptors).map(([name, item]) => [name, item.value])) as unknown as ViewReceiptInput
  if (!Number.isSafeInteger(value.startedAt) || value.startedAt < 0 || !Number.isSafeInteger(value.endedAt) || value.endedAt < value.startedAt || value.endedAt > 8640000000000000
    || !['http', 'stream'].includes(value.transport) || !categories.includes(value.category)
    || value.selectedSessionIdAtDispatch !== undefined && (typeof value.selectedSessionIdAtDispatch !== 'string'
      || !value.selectedSessionIdAtDispatch || value.selectedSessionIdAtDispatch.length > 256 || /[\u0000-\u001f\u007f]/.test(value.selectedSessionIdAtDispatch))) throw new Error('Invalid ended observation')
  key(hostId, value.observationId)
  return { version: 1, hostId, outcome: 'unconfirmed', observationId: value.observationId,
    startedAt: value.startedAt, endedAt: value.endedAt, transport: value.transport, category: value.category,
    ...(value.selectedSessionIdAtDispatch === undefined ? {} : { selectedSessionIdAtDispatch: value.selectedSessionIdAtDispatch }) }
}

/** Immutable, Host-owned metadata survives view disposal and application exit.
 * Atomic create makes identical retries safe across processes. A durable empty
 * clear marker prevents a delayed save from resurrecting a dismissed notice.
 * Nothing here invokes, checks or retries a remote operation. */
export class ViewReceiptStore {
  private ready: Promise<void>
  private issue?: string
  private pending = new Set<Promise<unknown>>()
  private closed = false
  private stopping?: Promise<void>
  private availableValue?: boolean
  private checkedAt = 0
  private checking?: Promise<boolean>
  private presenceRevision = 0
  constructor(private readonly root: string) {
    this.ready = (async () => { await this.privateDirectory(root); await this.sync(dirname(root)) })()
    void this.ready.catch(() => {})
  }
  get writeIssue(): string | undefined { return this.issue }
  available(): Promise<boolean> {
    if (this.issue) return Promise.resolve(true)
    const age = Date.now() - this.checkedAt
    if (this.availableValue !== undefined && age >= 0 && age < 60000) return Promise.resolve(this.availableValue)
    if (this.checking) return this.checking
    const revision = this.presenceRevision
    const read = (async () => {
      try { const result = await this.hosts('', 1); return !!result.items.length || !!result.issue }
      catch { return true }
    })().then(value => this.issue ? true : revision === this.presenceRevision ? value : this.availableValue ?? value)
    this.checking = read
    void read.then(value => { this.availableValue = value; this.checkedAt = Date.now(); if (this.checking === read) this.checking = undefined })
    return read
  }
  private write<T>(apply: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Local observation storage is closed'))
    const pending = Promise.resolve().then(apply)
    this.pending.add(pending)
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending))
    return pending
  }
  close(): Promise<void> {
    this.closed = true
    return this.stopping ??= (async () => { await this.ready.catch(() => {}); await Promise.allSettled([...this.pending]) })()
  }
  private async privateDirectory(path: string): Promise<void> {
    if (!isAbsolute(path)) throw new Error('Receipt directory must be absolute')
    // The owning profile directory must already exist. Do not create an
    // untracked chain of parents whose entries have not been fsynced.
    try { await mkdir(path, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    await this.checkDirectory(path)
  }
  private async checkDirectory(path: string): Promise<void> {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink() || !isPrivateMode(info)) throw new Error('Receipt directory must be private')
  }
  private async directory(hostId: string, create = true): Promise<string | undefined> {
    host(hostId); await this.ready; await this.checkDirectory(this.root)
    const path = join(this.root, hostId)
    if (create) { await this.privateDirectory(path); await this.sync(this.root) }
    else {
      let info
      try { info = await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      if (!info.isDirectory() || info.isSymbolicLink() || !isPrivateMode(info)) throw new Error('Receipt directory must be private')
    }
    return path
  }
  private async sync(path: string): Promise<void> {
    const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await fd.sync() } finally { await fd.close() }
  }
  private async bytes(path: string, max: number): Promise<Buffer | undefined> {
    let fd
    try { fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    try {
      const info = await fd.stat()
      if (!info.isFile() || !isPrivateMode(info) || info.size > max) throw new Error('Unsafe receipt file')
      const bytes = Buffer.alloc(max + 1), result = await fd.read(bytes, 0, bytes.length, 0), after = await fd.stat()
      if (result.bytesRead > max || result.bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('Receipt file changed during read')
      return bytes.subarray(0, result.bytesRead)
    } finally { await fd.close() }
  }
  async saveMany(hostId: string, values: ViewReceiptInput[]): Promise<Array<{ status: 'saved' | 'dismissed'; observationId: string }>> {
    host(hostId)
    if (!Array.isArray(values) || values.length > 64) throw new Error('Invalid observation batch')
    const snapshots = values.map(value => canonical(hostId, value)), identities = new Map<string, string>()
    for (const value of snapshots) {
      const raw = JSON.stringify(value), previous = identities.get(value.observationId)
      if (previous !== undefined && previous !== raw) throw new ViewReceiptConflictError()
      identities.set(value.observationId, raw)
    }
    return this.write(async () => {
      const result = []
      for (const value of snapshots) result.push(await this.saveSnapshot(value))
      return result
    })
  }
  async hosts(after = '', limit = 50): Promise<{ items: string[]; next?: string; issue?: string }> {
    if (after && !/^[a-f0-9]{24}$/.test(after) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid observation Host window')
    await this.ready; await this.checkDirectory(this.root)
    const items: string[] = []
    let issue = this.issue
    for await (const entry of await opendir(this.root)) {
      if (!/^[a-f0-9]{24}$/.test(entry.name) || entry.name <= after) continue
      // Validate a matching entry before exposing it as an owned directory.
      try { if (!await this.directory(entry.name, false)) continue }
      catch { issue = 'Some observation metadata could not be read; its files were preserved'; continue }
      const position = items.findIndex(value => value > entry.name)
      items.splice(position < 0 ? items.length : position, 0, entry.name)
      if (items.length > limit + 1) items.pop()
    }
    return { items: items.slice(0, limit), ...(items.length > limit ? { next: items[limit - 1] } : {}), ...(issue ? { issue } : {}) }
  }
  private async cleared(directory: string, id: string): Promise<boolean> {
    return (await this.bytes(join(directory, id + '.cleared'), 0)) !== undefined
  }
  private async create(directory: string, destination: string, bytes: Buffer): Promise<void> {
    const temporary = join(directory, 'pending-' + randomUUID() + '.tmp')
    const fd = await open(temporary, 'wx', 0o600)
    try {
      try { await fd.writeFile(bytes); await fd.sync() } finally { await fd.close() }
      try { await link(temporary, destination) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const existing = await this.bytes(destination, 8192)
        if (!existing?.equals(bytes)) throw new ViewReceiptConflictError()
      }
      await this.sync(directory)
    } finally { await unlink(temporary).catch(() => {}) }
  }
  async save(hostId: string, input: ViewReceiptInput): Promise<{ status: 'saved' | 'dismissed'; observationId: string }> {
    // Snapshot synchronously before the first await; callers cannot mutate
    // the input while directory operations or fsync are pending.
    const value = canonical(hostId, input)
    return this.write(() => this.saveSnapshot(value))
  }
  private async saveSnapshot(value: ViewReceipt): Promise<{ status: 'saved' | 'dismissed'; observationId: string }> {
    const { hostId } = value, id = key(hostId, value.observationId), raw = Buffer.from(JSON.stringify(value))
    const directory = (await this.directory(hostId))!
    if (this.issue) throw new Error('Local observation storage needs inspection')
    const dismissed = async () => {
      // A concurrent clearer may have linked the marker but not yet synced
      // its directory. Confirm durability ourselves before acknowledging it.
      await this.sync(directory)
      await unlink(join(directory, id + '.json')).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
      await this.sync(directory)
      return { status: 'dismissed' as const, observationId: value.observationId }
    }
    try {
      if (await this.cleared(directory, id)) return await dismissed()
      try { await this.create(directory, join(directory, id + '.json'), raw) }
      catch (error) {
        // EEXIST followed by ENOENT can be a completed concurrent clear,
        // rather than an identity collision. The immutable marker decides.
        if (!(error instanceof ViewReceiptConflictError) || !await this.cleared(directory, id)) throw error
      }
      if (await this.cleared(directory, id)) return await dismissed()
      ++this.presenceRevision; this.availableValue = true; this.checkedAt = Date.now()
      return { status: 'saved', observationId: value.observationId }
    } catch (error) {
      if (error instanceof ViewReceiptConflictError) throw error
      // A published hard link followed by a failed directory fsync cannot be
      // acknowledged as durable. Further releases must keep their views alive.
      this.issue = 'Local observation storage could not confirm a durable save'
      throw error
    }
  }
  async dismiss(hostId: string, observationId: string): Promise<void> {
    const id = key(hostId, observationId)
    return this.write(async () => {
      const directory = (await this.directory(hostId))!
      if (this.issue) throw new Error('Local observation storage needs inspection')
      try {
        await this.create(directory, join(directory, id + '.cleared'), Buffer.alloc(0))
        ++this.presenceRevision; this.availableValue = true; this.checkedAt = Date.now()
        await unlink(join(directory, id + '.json')).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
        await this.sync(directory)
      } catch (error) { this.issue = 'Local observation storage could not confirm a durable clear'; throw error }
    })
  }
  async list(hostId: string, after = '', limit = 50): Promise<ViewReceiptPage> {
    if (after && !hashPattern.test(after) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid observation window')
    const directory = await this.directory(hostId, false), names: string[] = []
    if (!directory) return { entries: [], ...(this.issue ? { issue: this.issue } : {}) }
    // Keep at most one page of filenames, even after years of notices and
    // clears. Stable hash ordering supports deterministic, bounded paging.
    for await (const entry of await opendir(directory)) {
      const match = /^([a-f0-9]{64})\.json$/.exec(entry.name)
      if (!match || match[1]! <= after) continue
      const id = match[1]!
      const position = names.findIndex(value => value > id)
      names.splice(position < 0 ? names.length : position, 0, id)
      if (names.length > limit + 1) names.pop()
    }
    const entries: ViewReceipt[] = []
    let issue = this.issue
    for (const id of names.slice(0, limit)) {
      try {
        if (await this.cleared(directory, id)) continue
        const raw = await this.bytes(join(directory, id + '.json'), 8192)
        if (!raw) continue
        const saved = JSON.parse(raw.toString()) as ViewReceipt
        const { version, hostId: owner, outcome, ...input } = saved
        const value = canonical(hostId, input)
        if (version !== 1 || owner !== hostId || outcome !== 'unconfirmed' || key(hostId, value.observationId) !== id) throw new Error('Invalid saved observation')
        entries.push(value)
      } catch { issue = 'Some observation metadata could not be read; its files were preserved' }
    }
    return { entries, ...(names.length > limit ? { next: names[limit - 1] } : {}), ...(issue ? { issue } : {}) }
  }
}
