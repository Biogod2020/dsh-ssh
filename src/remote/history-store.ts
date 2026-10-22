import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, lstat, open, rename, unlink, readdir, rm, link } from 'node:fs/promises'
import { join } from 'node:path'
import { historyKey, validHistory, validMeta, type HistoryMeta, type HistoryRecord, type HistoryDocument, type HistoryInput, type HistoryStore, type HistoryToken, type HistoryStorageAudit } from './history-cache.ts'
import { auditHistoryFiles } from './history-storage-audit.ts'
export { historyKey } from './history-cache.ts'

interface Segment { file: string; first: number; last: number; count: number; bytes: number; sha256: string; eventType?:string }
interface Manifest { version: 2; generation: string; remoteHistoryEpoch: null; meta: HistoryMeta; segments: Segment[]; legacyDigest?: string; legacyBytes?:number; indexBytes:number; indexEntries:number; indexHash:string }
type DiskManifest = Omit<Manifest,'segments'>
interface IndexEntry { previous:string; prepend:Segment[]; append:Segment[] }
interface Fence { generation: number; enabled: boolean }
interface Control { version: 2; snoozedUntil: number; fences: Record<string, Fence>; writerEpoch?: string }
const keyPattern = /^[a-f0-9]{64}$/
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const isKey = (key: string) => keyPattern.test(key)
const maxSegmentBytes = 64 * 1024 * 1024
const windowBytes = 2 * 1024 * 1024
const validSegment = (s: Segment) => s && typeof s.file==='string' && uuid.test(s.file.replace(/\.json$/, '')) && s.file.endsWith('.json')
  && [s.first, s.last, s.count, s.bytes].every(Number.isSafeInteger) && s.first >= 0 && s.last >= s.first
  && s.count === s.last - s.first + 1 && s.bytes > 0 && s.bytes <= maxSegmentBytes && keyPattern.test(s.sha256)
  && (s.eventType===undefined || typeof s.eventType==='string' && s.eventType.length<=256)
function validManifest(m: Manifest, key: string): boolean {
  if (!m || m.version !== 2 || !uuid.test(m.generation) || m.remoteHistoryEpoch !== null || !validMeta(m.meta) || m.meta.key !== key
    || !Array.isArray(m.segments) || !m.segments.every(validSegment)
    || m.legacyDigest !== undefined && !keyPattern.test(m.legacyDigest)
    || m.legacyBytes!==undefined && (!Number.isSafeInteger(m.legacyBytes)||m.legacyBytes<0)
    || !Number.isSafeInteger(m.indexBytes)||m.indexBytes<0||!Number.isSafeInteger(m.indexEntries)||m.indexEntries<0||!keyPattern.test(m.indexHash)) return false
  return m.segments.every((s, n) => !n || s.first === m.segments[n - 1]!.last + 1)
    && m.meta.records === m.segments.reduce((sum, s) => sum + s.count, 0)
    && m.meta.cursor === (m.segments.at(-1)?.last ?? -1)
    && (!m.meta.complete || !m.segments.length || m.segments[0]!.first === 0)
    && m.meta.bytes >= m.segments.reduce((sum, s) => sum + s.bytes, 0)
}

/** Immutable private history segments. Legacy JSON is read only for migration.
 * Local generation IDs are not evidence of a remote history incarnation. */
export class SegmentedHistoryCache implements HistoryStore {
  private readonly owner = randomUUID()
  private readonly store: string
  private ready: Promise<void>
  private chain: Promise<unknown> = Promise.resolve()
  private entries = new Map<string, HistoryMeta>()
  private manifests = new Map<string, Manifest>()
  private issues = new Map<string, string>()
  private control: Control = { version: 2, snoozedUntil: 0, fences: {} }
  private fatal?: string
  private writeIssue?:string
  private writer = false
  private controlHash?: string
  private closed = false
  private mutationRevision = 0
  private writing = 0
  private storageAudit?: HistoryStorageAudit
  private auditing?: Promise<HistoryStorageAudit>
  constructor(private root: string) {
    this.store = join(root, 'v2'); this.ready = this.load()
    // One background inventory after startup. Status reads and Session
    // navigation only consume its snapshot; they never start another scan.
    void this.audit().catch(() => {})
  }
  private key(key: string): void { if (!isKey(key)) throw new Error('Invalid history cache identity') }
  private async directory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await lstat(path)
    if (!info.isDirectory() || (info.mode & 0o077)) throw new Error('Unsafe history directory')
  }
  private async exists(path: string): Promise<boolean> {
    try { const s = await lstat(path); if (!s.isFile() || (s.mode & 0o077)) throw new Error('Unsafe history file'); return true }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e }
  }
  private async bytes(path: string, budget = 256 * 1024 * 1024): Promise<Buffer> {
    const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const s = await f.stat()
      if (!s.isFile() || (s.mode & 0o077) || s.size > budget) throw new Error('Unsafe or oversized history file')
      return await f.readFile()
    } finally { await f.close() }
  }
  private async syncDirectory(path: string): Promise<void> {
    const f = await open(path, constants.O_RDONLY | constants.O_DIRECTORY)
    try { await f.sync() } finally { await f.close() }
  }
  private async manifest(key:string):Promise<Manifest> {
    const raw=JSON.parse((await this.bytes(join(this.store,key,'manifest.json'))).toString()) as DiskManifest
    if(!raw||raw.version!==2||!uuid.test(raw.generation)||!validMeta(raw.meta)||raw.meta.key!==key
      ||!Number.isSafeInteger(raw.indexBytes)||raw.indexBytes<0||raw.indexBytes>256*1024*1024
      ||!Number.isSafeInteger(raw.indexEntries)||raw.indexEntries<0||!keyPattern.test(raw.indexHash))throw new Error('Invalid history manifest')
    await this.directory(join(this.store,key,raw.generation))
    const file=await open(join(this.store,key,raw.generation,'segments.jsonl'),constants.O_RDONLY|constants.O_NOFOLLOW)
    const buffer=Buffer.alloc(raw.indexBytes)
    try {
      const info=await file.stat()
      if(!info.isFile()||(info.mode&0o077)||info.size<raw.indexBytes)throw new Error('Invalid committed history index')
      let offset=0
      while(offset<buffer.length){const {bytesRead}=await file.read(buffer,offset,buffer.length-offset,offset);if(!bytesRead)throw new Error('History index was truncated');offset+=bytesRead}
    } finally {await file.close()}
    const text=buffer.toString(), lines=text?text.split('\n'):[]
    if(lines.length&&lines.pop()!=='')throw new Error('Incomplete committed history index')
    let hash=digest('');const front:Segment[][]=[],back:Segment[][]=[]
    for(const line of lines){
      const entry=JSON.parse(line) as IndexEntry
      if(entry.previous!==hash||!Array.isArray(entry.prepend)||!entry.prepend.every(validSegment)||!Array.isArray(entry.append)||!entry.append.every(validSegment))throw new Error('Invalid history index entry')
      front.push(entry.prepend);back.push(entry.append);hash=digest(hash+'\n'+line+'\n')
    }
    if(lines.length!==raw.indexEntries||hash!==raw.indexHash)throw new Error('History index checksum mismatch')
    const m={...raw,segments:[...front.reverse().flat(),...back.flat()]}
    if(!validManifest(m,key))throw new Error('History index ranges disagree with the manifest')
    return m
  }
  private async atomic(path: string, value: unknown, check = () => true): Promise<boolean> {
    await this.exists(path)
    const temporary = path + '.' + randomUUID() + '.tmp'
    let published=false
    try {
      const f = await open(temporary, 'wx', 0o600)
      try { await f.writeFile(JSON.stringify(value)); await f.sync() } finally { await f.close() }
      if (!check()) return false
      await rename(temporary, path);published=true
      await this.syncDirectory(join(path, '..')); return true
    } catch(error) {
      // Rename can succeed before directory fsync fails. Reusing the old
      // in-memory root could then truncate an index prefix the visible root
      // already references. Preserve readable snapshots; reopen before writes.
      if(published)this.writeIssue='A history commit may have reached disk; reopen this storage before further writes. Saved files were preserved.'
      throw error
    } finally { await unlink(temporary).catch(e => {
      if(e.code!=='ENOENT'){
        if(published)this.writeIssue='A history commit may have reached disk; reopen this storage before further writes. Saved files were preserved.'
        throw e
      }
    }) }
  }
  private async load(): Promise<void> {
    try {
      await this.directory(this.root); await this.directory(this.store)
      const control = join(this.store, 'control.json')
      if (await this.exists(control)) {
        const raw = await this.bytes(control), c = JSON.parse(raw.toString()) as Control
        if (c.version !== 2 || !Number.isFinite(c.snoozedUntil) || c.snoozedUntil < 0 || !c.fences || typeof c.fences !== 'object'
          || c.writerEpoch !== undefined && !uuid.test(c.writerEpoch)
          || Object.entries(c.fences).some(([k,v]) => !isKey(k) || !v || !Number.isSafeInteger(v.generation) || v.generation < 0 || typeof v.enabled !== 'boolean')) throw new Error('Invalid history write barriers')
        this.control = c; this.controlHash = digest(raw)
      }
      const legacyIndex = join(this.root, 'index.json')
      if (await this.exists(legacyIndex)) {
        try {
          const index = JSON.parse((await this.bytes(legacyIndex)).toString())
          if (index.version !== 1 || !Array.isArray(index.entries) || !index.entries.every(validMeta)) throw new Error()
          for (const meta of index.entries as HistoryMeta[]) this.entries.set(meta.key, meta)
          if (!await this.exists(control) && Number.isFinite(index.snoozedUntil)) this.control.snoozedUntil = index.snoozedUntil
        } catch { this.issues.set('legacy-index', 'Legacy history index needs recovery; original files were preserved') }
      }
      for (const name of await readdir(this.root)) if (/^[a-f0-9]{64}\.json$/.test(name) && !this.entries.has(name.slice(0, -5))) {
        const key = name.slice(0, -5)
        try { const copy = await this.legacy(key); if (copy) this.entries.set(key, copy.meta) }
        catch { this.issues.set(key, 'Legacy history is damaged; original file was preserved') }
      }
      for (const key of await readdir(this.store)) if (isKey(key)) {
        try {
          await this.directory(join(this.store, key))
          const path = join(this.store, key, 'manifest.json')
          if (!await this.exists(path)) continue // An uncommitted interrupted migration.
          const m=await this.manifest(key)
          this.manifests.set(key, m); this.entries.set(key, m.meta)
        } catch { this.issues.set(key, 'History manifest is damaged; original files were preserved') }
      }
      for (const [key, fence] of Object.entries(this.control.fences)) if (!fence.enabled) this.entries.delete(key)
    } catch { this.fatal = 'Local history storage is unavailable. Its files were preserved.' }
  }
  private check(): void { if (this.fatal) throw new Error(this.fatal) }
  private enabled(key: string): boolean { return this.control.fences[key]?.enabled !== false }
  token(key?:string): HistoryToken { if(!key)throw new Error('Segmented history writes require a session identity');this.key(key);return { key, generation:this.control.fences[key]?.generation??0, owner:this.owner } }
  current(token: HistoryToken): boolean {
    return typeof token !== 'number' && token.owner===this.owner && isKey(token.key) && this.enabled(token.key)
      && token.generation===(this.control.fences[token.key]?.generation??0)
  }
  private allowed(key: string, token: HistoryToken): boolean {
    return this.enabled(key) && this.current(token) && typeof token!=='number' && token.key===key
  }
  private async persistControl(): Promise<void> {
    const snapshot=structuredClone(this.control)
    try{await this.atomic(join(this.store,'control.json'),snapshot)}
    catch(error){this.writeIssue='History write barriers could not be confirmed; reopen this storage before further writes. Saved files were preserved.';throw error}
    this.controlHash=digest(JSON.stringify(snapshot))
  }
  private queue<T>(fn: () => Promise<T>, mutates: boolean | (() => boolean | Promise<boolean>) = true): Promise<T> {
    const next = this.chain.then(async () => {
      await this.ready; this.check(); if(this.writeIssue)throw new Error(this.writeIssue);if (this.closed) throw new Error('History writer is closed')
      const changing = !this.writer || (typeof mutates === 'function' ? await mutates() : mutates)
      if (changing) { ++this.mutationRevision; ++this.writing; if (this.storageAudit) this.storageAudit.stale = true }
      try { await this.acquire(); return await fn() }
      finally { if (changing) { --this.writing; ++this.mutationRevision } }
    })
    this.chain = next.catch(() => {}); return next
  }
  private async acquire(): Promise<void> {
    if (this.writer) return
    const lock = join(this.store, 'writer.lock'), temporary = join(this.store, 'owner-' + this.owner + '.tmp')
    const f = await open(temporary, 'wx', 0o600)
    try { await f.writeFile(JSON.stringify({ pid: process.pid, owner: this.owner })); await f.sync() } finally { await f.close() }
    try {
      try { await link(temporary, lock) }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        // Serialize stale-owner recovery. Comparing then unlinking without this
        // guard can accidentally remove a competing newly acquired live lock.
        const guard=join(this.store,'recovery.lock')
        try { await link(temporary,guard) }
        catch (guardError) {
          if ((guardError as NodeJS.ErrnoException).code==='EEXIST') throw new Error('History lock recovery is in progress or needs inspection; disk copies remain readable')
          throw guardError
        }
        try {
          const raw = await this.bytes(lock), other = JSON.parse(raw.toString())
          if (!Number.isSafeInteger(other.pid) || other.pid <= 0 || !uuid.test(other.owner)) throw new Error('History writer lock needs inspection')
          try { process.kill(other.pid, 0); throw new Error('Another history writer is active; disk copies remain readable') }
          catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe }
          if (!raw.equals(await this.bytes(lock))) throw new Error('History writer changed during recovery')
          await unlink(lock); await link(temporary, lock)
        } finally { await unlink(guard); await this.syncDirectory(this.store) }
      }
      this.writer = true
      const path=join(this.store,'control.json'), actual=await this.exists(path) ? digest(await this.bytes(path)) : undefined
      if (actual!==this.controlHash) {
        await unlink(lock); this.writer=false
        throw new Error('History was changed by another writer; reopen this storage before writing')
      }
      // A reader can be constructed while another writer owns the same epoch.
      // Refresh immutable manifest pointers under the lock before its first write.
      for (const key of await readdir(this.store)) if (isKey(key)) {
        const directory=join(this.store,key); await this.directory(directory)
        const path=join(directory,'manifest.json')
        if (!await this.exists(path)) continue
        let m:Manifest
        try {m=await this.manifest(key)}catch{this.issues.set(key,'History manifest is damaged; original files were preserved');continue}
        this.manifests.set(key,m)
        if (this.enabled(key)) this.entries.set(key,m.meta)
      }
      this.control.writerEpoch=this.owner
      try { await this.persistControl(); await this.syncDirectory(this.store) }
      catch(e) { this.fatal='History writer metadata could not be persisted; saved files were preserved'; throw e }
    } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e }) }
  }
  private async legacy(key: string): Promise<HistoryDocument | undefined> {
    const path = join(this.root, key + '.json')
    if (!await this.exists(path)) return undefined
    const copy = JSON.parse((await this.bytes(path)).toString()) as HistoryDocument
    if (!validMeta(copy.meta) || copy.meta.key !== key || !validHistory(copy.records, copy.meta.cursor)
      || copy.meta.complete && copy.records.length && copy.records[0]!.event.seq !== 0) throw new Error('Legacy history is damaged; original file was preserved')
    const indexed = this.entries.get(key)
    if (indexed && indexed.cursor > copy.meta.cursor) throw new Error('Legacy index is ahead of its data; original file was preserved')
    return copy
  }
  async meta(key: string): Promise<HistoryMeta | undefined> {
    await this.ready; this.key(key); this.check()
    const meta = this.enabled(key) && this.entries.get(key); return meta ? { ...meta } : undefined
  }
  async present(key: string): Promise<boolean> {
    await this.ready; this.key(key); this.check()
    if (!this.enabled(key) || !this.entries.has(key)) return false
    const m = this.manifests.get(key)
    return m ? await this.exists(join(this.store, key, 'manifest.json')) && (!m.segments.length || await this.exists(join(this.store, key, m.generation, m.segments.at(-1)!.file)))
      : this.exists(join(this.root, key + '.json'))
  }
  async list() {
    await this.ready; await this.chain
    const entries = [...this.entries.values()].filter(m => this.enabled(m.key)).map(m => ({ ...m })).sort((a,b) => b.savedAt-a.savedAt)
    const bytes = entries.reduce((sum,m) => sum+m.bytes,0), now = Date.now()
    const storage = this.storageAudit && (({ byKey: _byKey, ...summary }) => ({ ...summary }))(this.storageAudit)
    const reasons = [Math.max(bytes, storage?.stale ? 0 : storage?.fileBytes ?? 0) >= 512*1024*1024 ? 'size' : '', entries.length >= 100 ? 'count' : '', entries.some(m => now-m.firstSavedAt >= 30*86400000) ? 'age' : '',
      storage && !storage.stale && storage.unreferencedBytes > 0 ? 'unreferenced' : '',
      storage && !storage.stale && storage.incomplete ? 'inventory' : ''].filter(Boolean)
    return { entries, bytes, reminder: reasons.length > 0 && now >= this.control.snoozedUntil, reasons, ...(storage ? { storage } : {}),
      warning: this.fatal ?? this.writeIssue ?? (this.issues.size ? `${this.issues.size} local history issue(s); original files were preserved` : undefined) }
  }
  audit(): Promise<HistoryStorageAudit> {
    if (this.auditing) return this.auditing
    this.auditing = (async () => {
      await this.ready; this.check()
      const revision = this.mutationRevision, writing = this.writing > 0
      const cleared = new Map(Object.entries(this.control.fences).filter(([, value]) => !value.enabled).map(([key, value]) => [key, value.generation]))
      const references = new Map<string, number | undefined>()
      for (const key of this.entries.keys()) if (this.enabled(key) && !this.manifests.has(key)) references.set(key + '.json', undefined)
      for (const [key, m] of this.manifests) if (this.enabled(key)) {
        references.set(`v2/${key}/manifest.json`, undefined)
        references.set(`v2/${key}/${m.generation}/segments.jsonl`, m.indexBytes)
        for (const segment of m.segments) references.set(`v2/${key}/${m.generation}/${segment.file}`, undefined)
        if (m.legacyDigest) { references.set(`v2/${key}/legacy.v1.json`, undefined); references.set(key + '.json', undefined) }
      }
      const report = await auditHistoryFiles(this.root, references, () => this.closed)
      for (const [key, value] of Object.entries(report.byKey)) if (cleared.has(key)) value.clearedGeneration = cleared.get(key)
      report.stale = writing || this.writing > 0 || revision !== this.mutationRevision
      this.storageAudit = report
      return structuredClone(report)
    })().finally(() => { this.auditing = undefined })
    return this.auditing
  }
  private async segment(key: string, m: Manifest, s: Segment): Promise<HistoryRecord[]> {
    const path = join(this.store, key, m.generation, s.file)
    const raw = await this.bytes(path,maxSegmentBytes)
    if (raw.length !== s.bytes || digest(raw) !== s.sha256) throw new Error('History segment is damaged; original files were preserved')
    const rows = JSON.parse(raw.toString()) as HistoryRecord[]
    if (!validHistory(rows, s.last) || rows.length !== s.count || rows[0]?.event.seq !== s.first) throw new Error('History segment range is invalid')
    return rows
  }
  private async document(key: string, beforeSeq?: number, limit?: number): Promise<HistoryDocument | undefined> {
    if (!this.enabled(key)) return undefined
    if (this.issues.has(key)) throw new Error(this.issues.get(key))
    const m = this.manifests.get(key)
    if (!m) {
      const copy = await this.legacy(key); if (!copy || limit === undefined) return copy
      const eligible = copy.records.filter(r => beforeSeq === undefined || r.event.seq < beforeSeq)
      const records:HistoryRecord[]=[], omitted:Array<{seq:number;bytes:number}>=[];let used=0
      for (let n=eligible.length-1;n>=0&&records.length<limit;n--) {
        const row=eligible[n]!, bytes=Buffer.byteLength(JSON.stringify(row))
        if (bytes>windowBytes) {records.unshift({type:'event',event:{seq:row.event.seq,type:row.event.type}});omitted.unshift({seq:row.event.seq,bytes});continue}
        if (records.length&&used+bytes>windowBytes) break
        used+=bytes;records.unshift(row)
      }
      return { meta: copy.meta, records, page: { beforeSeq: records[0]?.event.seq ?? 0, hasMore: eligible.length > records.length,...(omitted.length?{omitted}:{}) } }
    }
    if (limit===undefined) {
      const records:HistoryRecord[]=[]
      for(const s of m.segments) records.push(...await this.segment(key,m,s))
      return {meta:{...m.meta},records}
    }
    const records: HistoryRecord[] = [], selected = m.segments.filter(s => beforeSeq === undefined || s.first < beforeSeq)
    const omitted:Array<{seq:number;bytes:number}>=[];let used=0
    pages: for (let n = selected.length-1; n >= 0; n--) {
      const s=selected[n]!
      if (limit!==undefined && s.count===1 && s.bytes>windowBytes) {
        const path=join(this.store,key,m.generation,s.file)
        if (!await this.exists(path) || (await lstat(path)).size!==s.bytes) throw new Error('Large history record is unavailable or damaged; original files were preserved')
        records.unshift({type:'event',event:{seq:s.first,type:s.eventType??'history/large-record'}})
        omitted.unshift({seq:s.first,bytes:s.bytes})
        if (records.length>=limit) break
        continue
      }
      const rows = (await this.segment(key,m,selected[n]!)).filter(r => beforeSeq === undefined || r.event.seq < beforeSeq)
      for (let r=rows.length-1;r>=0;r--) {
        if (limit!==undefined) {
          const bytes=Buffer.byteLength(JSON.stringify(rows[r]))
          if (records.length && used+bytes>windowBytes) break pages
          used+=bytes
        }
        records.unshift(rows[r]!)
        if (limit!==undefined && records.length>=limit) break pages
      }
      if (limit !== undefined && records.length >= limit) break
    }
    return { meta: { ...m.meta }, records, ...(limit === undefined ? {} : { page: { beforeSeq: records[0]?.event.seq ?? 0,
      hasMore: !!records.length && records[0]!.event.seq > (m.segments[0]?.first ?? 0), ...(omitted.length?{omitted}:{}) } }) }
  }
  async read(key: string): Promise<HistoryDocument | undefined> { await this.ready; await this.chain; this.key(key); this.check(); return this.document(key) }
  async window(key: string, beforeSeq?: number, limit = 200): Promise<HistoryDocument | undefined> {
    await this.ready; await this.chain; this.key(key); this.check()
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)) throw new Error('Invalid history window')
    return this.document(key,beforeSeq,limit)
  }
  async event(key:string,seq:number):Promise<HistoryRecord|undefined> {
    await this.ready;await this.chain;this.key(key);this.check()
    if (!Number.isSafeInteger(seq)||seq<0) throw new Error('Invalid history event')
    if (!this.enabled(key)) return undefined
    if (this.issues.has(key)) throw new Error(this.issues.get(key))
    const m=this.manifests.get(key)
    if (!m) return (await this.legacy(key))?.records.find(r=>r.event.seq===seq)
    const s=m.segments.find(s=>s.first<=seq&&s.last>=seq)
    return s ? (await this.segment(key,m,s)).find(r=>r.event.seq===seq) : undefined
  }
  private async segments(key: string, generation: string, rows: HistoryRecord[]): Promise<Segment[]> {
    const directory = join(this.store,key,generation); await this.directory(directory)
    const result: Segment[] = []; let batch: HistoryRecord[] = [], bytes = 2
    const flush = async () => {
      if (!batch.length) return
      const raw = JSON.stringify(batch), file = randomUUID()+'.json'
      if (Buffer.byteLength(raw) > maxSegmentBytes) throw new Error('History event exceeds the supported segment budget; saved history was preserved')
      const f = await open(join(directory,file),'wx',0o600)
      try { await f.writeFile(raw); await f.sync() } finally { await f.close() }
      result.push({ file, first:batch[0]!.event.seq, last:batch.at(-1)!.event.seq, count:batch.length, bytes:Buffer.byteLength(raw), sha256:digest(raw),
        ...(batch.length===1&&Buffer.byteLength(raw)>windowBytes?{eventType:batch[0]!.event.type.slice(0,256)}:{}) })
      batch=[]; bytes=2
    }
    for (const row of rows) {
      const length=Buffer.byteLength(JSON.stringify(row))+1
      if (batch.length && (batch.length >= 500 || bytes+length > 1024*1024)) await flush()
      batch.push(row); bytes+=length
    }
    await flush(); await this.syncDirectory(directory); return result
  }
  private async commit(meta: HistoryInput, segments: Segment[], generation: string, firstSavedAt: number, token: HistoryToken, legacyDigest?: string, legacyBytes?:number): Promise<boolean> {
    if(!this.allowed(meta.key,token))return false
    const previous=this.manifests.get(meta.key)
    if(previous&&previous.generation!==generation)throw new Error('History storage generation changed')
    const first=previous?.segments.length ? segments.findIndex(s=>s.file===previous.segments[0]!.file) : 0
    if(first<0||previous?.segments.some((s,n)=>segments[first+n]!==s))throw new Error('Committed history index cannot be replaced')
    const prepend=segments.slice(0,first),append=segments.slice(first+(previous?.segments.length??0))
    let indexBytes=previous?.indexBytes??0,indexEntries=previous?.indexEntries??0,indexHash=previous?.indexHash??digest('')
    if(!previous||prepend.length||append.length){
      const entry:IndexEntry={previous:indexHash,prepend,append},line=JSON.stringify(entry)+'\n'
      const path=join(this.store,meta.key,generation,'segments.jsonl')
      const file=await open(path,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW|(previous?0:constants.O_EXCL),0o600)
      try{
        const info=await file.stat()
        if(!info.isFile()||(info.mode&0o077)||info.size<indexBytes)throw new Error('History index was changed or truncated')
        // Only bytes beyond the committed root are abandoned transaction data.
        // Previously committed descriptor bytes and history segments never change.
        if(info.size>indexBytes)await file.truncate(indexBytes)
        await file.writeFile(line);await file.sync()
      }finally{await file.close()}
      await this.syncDirectory(join(this.store,meta.key,generation))
      indexBytes+=Buffer.byteLength(line);indexEntries++;indexHash=digest(indexHash+'\n'+line)
    }
    const m: Manifest = { version:2, generation, remoteHistoryEpoch:null, meta: { ...meta, firstSavedAt, bytes:0, records:segments.reduce((sum,s)=>sum+s.count,0) }, segments,
      indexBytes,indexEntries,indexHash,...(legacyDigest ? { legacyDigest,legacyBytes:legacyBytes??0 } : {}) }
    const {segments:_segments,...disk}=m
    const dataBytes=segments.reduce((sum,s)=>sum+s.bytes,0)+(legacyBytes??0)+indexBytes
    for (let n=0;n<4;n++) m.meta.bytes=dataBytes+Buffer.byteLength(JSON.stringify(disk))
    if (!validManifest(m,meta.key)) throw new Error('History manifest has a gap or invalid metadata')
    if (!await this.atomic(join(this.store,meta.key,'manifest.json'),disk,()=>this.allowed(meta.key,token))) return false
    if (!this.allowed(meta.key,token)) return false
    this.manifests.set(meta.key,m); this.entries.set(meta.key,m.meta); return true
  }
  private async archiveLegacy(key: string, expectedDigest: string): Promise<void> {
    const source=join(this.root,key+'.json'), destination=join(this.store,key,'legacy.v1.json')
    if (!await this.exists(source)) return
    ++this.mutationRevision; ++this.writing; if (this.storageAudit) this.storageAudit.stale = true
    try {
      if (digest(await this.bytes(source)) !== expectedDigest) throw new Error('Legacy history changed during migration; both copies were preserved')
      if (await this.exists(destination)) {
        if (digest(await this.bytes(destination)) !== expectedDigest) throw new Error('Legacy history archive conflicts; both copies were preserved')
        await unlink(source)
      } else await rename(source,destination)
      await this.syncDirectory(this.root); await this.syncDirectory(join(this.store,key))
    } finally { --this.writing; ++this.mutationRevision }
  }
  private async migrate(key: string, token: HistoryToken): Promise<Manifest | undefined> {
    if (this.issues.has(key)) throw new Error(this.issues.get(key))
    const existing=this.manifests.get(key)
    if (existing) { if (existing.legacyDigest) await this.archiveLegacy(key,existing.legacyDigest); return existing }
    const copy=await this.legacy(key); if (!copy) return undefined
    const raw=await this.bytes(join(this.root,key+'.json')), legacyDigest=digest(raw), generation=randomUUID()
    // Check the exact bytes used for the migration, not an earlier read.
    const verified=JSON.parse(raw.toString()) as HistoryDocument
    if (JSON.stringify(copy)!==JSON.stringify(verified)) throw new Error('Legacy history changed during migration')
    await this.directory(join(this.store,key))
    const segments=await this.segments(key,generation,copy.records)
    if (!await this.commit(copy.meta,segments,generation,copy.meta.firstSavedAt,token,legacyDigest,raw.length)) return undefined
    await this.archiveLegacy(key,legacyDigest); return this.manifests.get(key)
  }
  private input(meta: HistoryInput, rows: HistoryRecord[]): void {
    this.key(meta.key)
    if (!validMeta({ ...meta,firstSavedAt:0,bytes:0,records:0 }) || rows.length && !validHistory(rows,rows.at(-1)!.event.seq)) throw new Error('Invalid history input')
  }
  async save(meta: HistoryInput, records: HistoryRecord[], token: HistoryToken): Promise<boolean> {
    this.input(meta,records)
    if (!validHistory(records,meta.cursor) || meta.complete && records.length && records[0]!.event.seq!==0) throw new Error('History has a gap; saved copy was preserved')
    return this.queue(async()=>{
      if (!this.allowed(meta.key,token)) return false
      const existing=await this.migrate(meta.key,token)
      if (existing) {
        const old=await this.document(meta.key)
        for (const row of old!.records) {
          const next=records[row.event.seq-(records[0]?.event.seq??0)]
          if (!next || JSON.stringify(next)!==JSON.stringify(row)) throw new Error('History replacement conflicts with saved records')
        }
        const first=existing.segments[0]?.first??0, last=existing.meta.cursor
        const before=await this.segments(meta.key,existing.generation,records.filter(r=>r.event.seq<first))
        const after=await this.segments(meta.key,existing.generation,records.filter(r=>r.event.seq>last))
        return this.commit(meta,[...before,...existing.segments,...after],existing.generation,existing.meta.firstSavedAt,token,existing.legacyDigest,existing.legacyBytes)
      }
      const generation=randomUUID(); await this.directory(join(this.store,meta.key))
      const segments=await this.segments(meta.key,generation,records)
      return this.commit(meta,segments,generation,Date.now(),token)
    })
  }
  private extend(meta: HistoryInput, records: HistoryRecord[], token: HistoryToken, prepend: boolean): Promise<boolean> {
    this.input(meta,records)
    return this.queue(async()=>{
      if (!this.allowed(meta.key,token)) return false
      const m=await this.migrate(meta.key,token)
      const first=m?.segments[0]?.first, last=m?.meta.cursor??-1
      if (records.length && m && (prepend ? records.at(-1)!.event.seq!==(first??0)-1 : records[0]!.event.seq!==last+1)) throw new Error('History increment is not contiguous; saved records were preserved')
      const generation=m?.generation??randomUUID(); await this.directory(join(this.store,meta.key))
      const segments=await this.segments(meta.key,generation,records)
      return this.commit(meta,prepend ? [...segments,...(m?.segments??[])] : [...(m?.segments??[]),...segments],generation,m?.meta.firstSavedAt??Date.now(),token,m?.legacyDigest,m?.legacyBytes)
    })
  }
  append(meta: HistoryInput, records: HistoryRecord[], token: HistoryToken) { return this.extend(meta,records,token,false) }
  prepend(meta: HistoryInput, records: HistoryRecord[], token: HistoryToken) { return this.extend(meta,records,token,true) }
  prepare(key: string, token: HistoryToken): Promise<{ meta: HistoryMeta; firstSeq: number } | undefined> {
    this.key(key)
    return this.queue(async()=>{
      if (!this.allowed(key,token)) return undefined
      const m=await this.migrate(key,token)
      return m ? {meta:{...m.meta},firstSeq:m.segments[0]?.first??0} : undefined
    }, async () => {
      const existing = this.manifests.get(key)
      return !existing || !!existing.legacyDigest && await this.exists(join(this.root, key + '.json'))
    })
  }
  private async remove(key: string): Promise<void> {
    const path=join(this.root,key+'.json'); if (await this.exists(path)) await unlink(path)
    const directory=join(this.store,key)
    try { const s=await lstat(directory); if (!s.isDirectory() || (s.mode&0o077)) throw new Error('Unsafe history directory'); await rm(directory,{recursive:true}) }
    catch(e) { if ((e as NodeJS.ErrnoException).code!=='ENOENT') throw e }
    this.entries.delete(key); this.manifests.delete(key); this.issues.delete(key)
    await this.syncDirectory(this.root); await this.syncDirectory(this.store)
  }
  async clear(keys: string[]): Promise<void> {
    if (!Array.isArray(keys) || keys.some(k=>!isKey(k))) throw new Error('Invalid history selection')
    const selection = [...new Set(keys)]
    await this.ready; this.check()
    for (const key of selection) this.control.fences[key]={generation:(this.control.fences[key]?.generation??0)+1,enabled:false}
    return this.queue(async()=>{
      await this.persistControl()
      for (const key of selection) await this.remove(key)
    })
  }
  async resume(key: string): Promise<void> {
    await this.ready; this.key(key); this.check()
    if (this.enabled(key)) return
    return this.queue(async()=>{
      if (this.enabled(key)) return
      await this.remove(key)
      this.control.fences[key]={generation:(this.control.fences[key]?.generation??0)+1,enabled:true}
      await this.persistControl()
    })
  }
  /** Continue a previously durable clear only. A reopened copy or a newer
   * selection is not covered by the old confirmation and is never removed. */
  finishClear(selection: { key: string; generation: number }[]): Promise<void> {
    if (!Array.isArray(selection) || selection.length > 1000 || selection.some(value => !value || !isKey(value.key)
      || !Number.isSafeInteger(value.generation) || value.generation < 0) || new Set(selection.map(value => value.key)).size !== selection.length) throw new Error('Invalid interrupted clear selection')
    const snapshot = selection.map(value => ({ key: value.key, generation: value.generation }))
    return this.queue(async () => {
      const check = (value: { key: string; generation: number }) => {
        const current = this.control.fences[value.key]
        if (!current || current.enabled || current.generation !== value.generation) throw new Error('The saved history selection changed. Check file sizes again before continuing the clear.')
      }
      for (const value of snapshot) check(value)
      for (const value of snapshot) { check(value); await this.remove(value.key) }
    })
  }
  snooze(): Promise<void> { return this.queue(async()=>{this.control.snoozedUntil=Date.now()+7*86400000;await this.persistControl()}) }
  /** Explicit offline downgrade export. Never exposes stale migration backups. */
  exportV1(target: string): Promise<void> {
    return this.queue(async()=>{
      try { await lstat(target); throw new Error('History export destination already exists') }
      catch(e) { if ((e as NodeJS.ErrnoException).code!=='ENOENT') throw e }
      await this.directory(target); const entries: HistoryMeta[]=[]
      for (const key of this.entries.keys()) if (this.enabled(key)) {
        const copy=await this.document(key); if (!copy) continue
        for(let n=0;n<4;n++)copy.meta.bytes=Buffer.byteLength(JSON.stringify(copy))
        await this.atomic(join(target,key+'.json'),copy); entries.push(copy.meta)
      }
      await this.atomic(join(target,'index.json'),{version:1,entries,snoozedUntil:this.control.snoozedUntil})
    })
  }
  async close(): Promise<void> {
    this.closed=true; await this.ready; await this.chain
    await this.auditing?.catch(() => {})
    if (!this.writer) return
    const path=join(this.store,'writer.lock'), owner=JSON.parse((await this.bytes(path)).toString())
    if (owner.owner!==this.owner) throw new Error('History writer lock changed; it was preserved')
    await unlink(path); await this.syncDirectory(this.store); this.writer=false
  }
}
