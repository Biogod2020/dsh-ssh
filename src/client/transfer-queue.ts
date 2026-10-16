/** Sequential transfers. Recovery metadata never replays a started operation. */
import { TransferCancelledError, type DownloadDestination, type DownloadProgress, type SshApi } from './api.ts'
import type { SshHostSummary } from '../protocol.ts'
import { tt } from './panel/helpers.ts'
import { decodeTransferHistory, encodeTransferHistory, type TransferHistory } from './transfer-history.ts'

export type TransferPhase = 'queued' | 'awaitingFile' | 'awaitingSave' | 'staging' | 'connecting' | 'transferring' | 'saving' | 'stopping' | 'done' | 'browserSave' | 'cancelled' | 'error' | 'interrupted'
export interface TransferJob {
  id: number; kind: 'upload' | 'download'; alias: string; host: string; port: number; user: string; updatedAt: number
  path: string; file: string; phase: TransferPhase; transferred: number; total: number; percent: number; speedBps?: number
  error?: string; dispatched?: boolean
  sourceSize?: number; sourceModified?: number; saveMode?: 'picker' | 'browser'
  localName?: string
}
interface Payload { file?: File; destination?: DownloadDestination; saveMode?: 'picker' | 'browser' }
interface Snapshot { jobs: TransferJob[]; paused: boolean; activeId?: number; restored?: boolean; historyIssue?: 'read' | 'write' }
export const transferFinished = (job: TransferJob): boolean => ['done', 'browserSave', 'cancelled', 'error', 'interrupted'].includes(job.phase)
const waiting = (job: TransferJob): boolean => ['queued', 'awaitingFile', 'awaitingSave'].includes(job.phase)
function recover(job: TransferJob): TransferJob {
  if (transferFinished(job)) return job
  return { ...job, phase: waiting(job) ? job.kind === 'upload' ? 'awaitingFile' : 'awaitingSave' : 'interrupted',
    dispatched: waiting(job) ? false : true, speedBps: undefined }
}

export class TransferQueue {
  private state: Snapshot = { jobs: [], paused: false }
  private payloads = new Map<number, Payload>()
  private listeners = new Set<() => void>()
  private sequence = 0
  private alive = true
  private operation?: { id: number; controller: AbortController }
  private lastCheckpoint = 0
  constructor(private api: SshApi, private history?: TransferHistory) { this.readHistory() }
  private readHistory(): void {
    if (!this.history) return
    try {
      const raw = this.history.read()
      if (raw === null) { if (this.state.historyIssue === 'read') this.state = { jobs: [], paused: true }; return }
      const saved = decodeTransferHistory(raw); this.sequence = saved.sequence
      this.state = { jobs: saved.jobs.map(recover), paused: true, restored: saved.jobs.length > 0 }
    } catch { this.state = { jobs: [], paused: true, historyIssue: 'read' } }
  }
  snapshot = (): Snapshot => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  attach = (): void => { this.alive = true }
  detach = (): void => {
    this.alive = false
    this.operation?.controller.abort(); this.operation = undefined; this.payloads.clear()
    this.publish({ ...this.state, activeId: undefined, paused: true, jobs: this.state.jobs.map(job => this.history ? recover(job) : transferFinished(job) ? job : { ...job, phase: 'cancelled', dispatched: job.phase !== 'queued' }) })
  }
  private publish(next: Snapshot, checkpoint = true): void {
    // Completed jobs hold metadata only. Retain at most the latest 30.
    const finished = next.jobs.filter(transferFinished), retained = new Set(finished.slice(-30).map(job => job.id))
    this.state = { ...next, jobs: next.jobs.filter(job => !transferFinished(job) || retained.has(job.id)) }
    if (checkpoint && this.history && this.state.historyIssue !== 'read') {
      try { this.history.write(encodeTransferHistory(this.state.jobs, this.sequence)); this.lastCheckpoint = Date.now(); this.state = { ...this.state, historyIssue: undefined } }
      catch { this.state = { ...this.state, paused: true, historyIssue: 'write' } }
    }
    this.listeners.forEach(listener => listener())
  }
  private update(id: number, patch: Partial<TransferJob>): void {
    this.publish({ ...this.state, jobs: this.state.jobs.map(job => job.id === id ? { ...job, ...patch } : job) })
  }
  private insert(host: SshHostSummary, items: Array<{ kind: TransferJob['kind']; path: string; file: string; payload: Payload; total: number }>): void {
    if (!this.alive) return
    if (this.state.historyIssue) throw new Error(tt('transfer.historyBlocked'))
    if (!Number.isFinite(host.updatedAt)) throw new Error(tt('transfer.queueHostChanged'))
    if (this.state.jobs.filter(job => !transferFinished(job)).length + items.length > 100) throw new Error(tt('transfer.queueLimit'))
    const targets = new Set<string>()
    for (const item of items) {
      if (!item.path.startsWith('/') || /[\0\r\n]/.test(item.path)) throw new Error(tt('transfer.absolutePath'))
      const key = item.kind + ':' + item.path
      if (targets.has(key) || this.state.jobs.some(job => !transferFinished(job) && job.alias === host.alias && job.kind === item.kind && job.path === item.path)) throw new Error(tt('transfer.duplicateTarget', { path: item.path }))
      targets.add(key)
    }
    const jobs = items.map(item => {
      const id = ++this.sequence; this.payloads.set(id, item.payload)
      return { id, kind: item.kind, alias: host.alias, host: host.host, port: host.port, user: host.user, updatedAt: host.updatedAt,
        path: item.path, file: item.file, phase: 'queued' as const, transferred: 0, total: item.total, percent: 0,
        ...(item.payload.file ? { sourceSize: item.payload.file.size, sourceModified: item.payload.file.lastModified } : {}),
        ...(item.kind === 'download' ? { saveMode: item.payload.saveMode, localName: item.payload.destination?.filename } : {}) }
    })
    this.publish({ ...this.state, jobs: [...this.state.jobs, ...jobs] }); void this.pump()
  }
  addUploads(host: SshHostSummary, path: string, files: File[]): void {
    if (!files.length) return
    if (files.length > 1 && !path.endsWith('/')) throw new Error(tt('transfer.multiDirectory'))
    if (files.some(file => !file.name || /[\/\\\0\r\n]/.test(file.name))) throw new Error(tt('transfer.invalidFilename'))
    this.insert(host, files.map(file => ({ kind: 'upload', path: path.endsWith('/') ? path + file.name : path, file: file.name, payload: { file }, total: file.size })))
  }
  addDownload(host: SshHostSummary, path: string, saveMode: 'picker' | 'browser', destination: DownloadDestination): void {
    this.insert(host, [{ kind: 'download', path, file: path.split('/').pop() || path, payload: { saveMode, destination }, total: 0 }])
  }
  pause = (): void => { this.publish({ ...this.state, paused: true }) }
  resume = (): void => { if (!this.alive || this.state.historyIssue) return; this.publish({ ...this.state, paused: false }); void this.pump() }
  retryHistory = (): void => {
    if (this.state.historyIssue === 'read') { this.readHistory(); this.listeners.forEach(listener => listener()) }
    else this.publish({ ...this.state, paused: true })
  }
  clearRecovery = (): void => {
    if (this.operation || !this.history || this.state.historyIssue !== 'read') return
    try { this.history.clear(); this.state = { jobs: [], paused: true }; this.sequence = 0; this.listeners.forEach(listener => listener()) }
    catch { /* Keep the original record and the paused state. */ }
  }
  restoreUploads(files: File[]): void {
    if (this.state.historyIssue) throw new Error(tt('transfer.historyBlocked'))
    const pending = this.state.jobs.filter(job => job.phase === 'awaitingFile'), matched = new Map<number, File>()
    for (const file of files) {
      const targets = pending.filter(job => job.file === file.name && job.sourceSize === file.size && job.sourceModified === file.lastModified)
      if (!targets.length || targets.some(job => matched.has(job.id))) throw new Error(tt('transfer.sourceMismatch', { file: file.name }))
      for (const job of targets) matched.set(job.id, file)
    }
    for (const [id, file] of matched) this.payloads.set(id, { file })
    this.publish({ ...this.state, paused: true, jobs: this.state.jobs.map(job => matched.has(job.id) ? { ...job, phase: 'queued' } : job) })
  }
  restoreDownload(id: number, destination: DownloadDestination): void {
    if (this.state.historyIssue) throw new Error(tt('transfer.historyBlocked'))
    const job = this.state.jobs.find(job => job.id === id && job.phase === 'awaitingSave')
    if (!job) return
    this.payloads.set(id, { destination, saveMode: job.saveMode ?? 'picker' })
    this.update(id, { phase: 'queued', localName: destination.filename })
  }
  cancel = (id: number): void => {
    const job = this.state.jobs.find(job => job.id === id)
    if (!job || transferFinished(job)) return
    if (waiting(job)) { this.payloads.delete(id); this.update(id, { phase: 'cancelled', dispatched: false }); return }
    this.pause(); this.update(id, { phase: 'stopping' }); this.operation?.controller.abort()
  }
  stopAll = (): void => {
    this.pause()
    for (const job of this.state.jobs) if (!transferFinished(job)) this.cancel(job.id)
  }
  clearFinished = (): void => this.publish({ ...this.state, jobs: this.state.jobs.filter(job => !transferFinished(job)) })
  private async pump(): Promise<void> {
    if (!this.alive || this.operation || this.state.paused || this.state.historyIssue) return
    const job = this.state.jobs.find(job => !transferFinished(job))
    if (!job) return
    if (job.phase !== 'queued' || !this.payloads.has(job.id)) { this.pause(); return }
    const payload = this.payloads.get(job.id)!, current = { id: job.id, controller: new AbortController() }
    this.operation = current
    this.publish({ ...this.state, activeId: job.id, jobs: this.state.jobs.map(row => row.id === job.id ? { ...row, phase: job.kind === 'upload' ? 'staging' : 'connecting' } : row) })
    // The active checkpoint must be saved before the HTTP request can dispatch.
    if (this.state.historyIssue) {
      this.operation = undefined; this.state = { ...this.state, activeId: undefined, jobs: this.state.jobs.map(row => row.id === job.id ? { ...row, phase: 'queued' as const } : row) }
      this.listeners.forEach(listener => listener()); return
    }
    const report = (progress: DownloadProgress): void => {
      if (this.operation !== current || !this.alive || current.controller.signal.aborted) return
      if (progress.phase === 'done') return // Only a confirmed result commits success.
      const checkpoint = this.state.jobs.find(row => row.id === job.id)?.phase !== progress.phase || Date.now() - this.lastCheckpoint >= 1000
      this.publish({ ...this.state, jobs: this.state.jobs.map(row => row.id === job.id ? { ...row, phase: progress.phase, transferred: progress.transferred, total: progress.total, percent: progress.percent, speedBps: progress.speedBps } : row) }, checkpoint)
    }
    try {
      if (job.kind === 'upload') {
        const result = await this.api.uploadFile(payload.file!, job.alias, job.path, report, current.controller.signal, job.updatedAt)
        if (this.operation !== current || !this.alive) return
        if (current.controller.signal.aborted) throw new TransferCancelledError(true)
        this.update(job.id, { phase: 'done', transferred: result.transferredBytes, percent: 100 })
      } else {
        const result = await this.api.downloadFile(job.alias, job.path, report, current.controller.signal, payload.saveMode, payload.destination, job.updatedAt)
        if (this.operation !== current || !this.alive) return
        if (current.controller.signal.aborted) throw new TransferCancelledError(true)
        if (!result.streamed && result.blob) {
          const url = URL.createObjectURL(result.blob), anchor = document.createElement('a')
          anchor.href = url; anchor.download = result.filename; document.body.appendChild(anchor); anchor.click(); anchor.remove()
          window.setTimeout(() => URL.revokeObjectURL(url), 10000)
        }
        this.update(job.id, { phase: result.streamed ? 'done' : 'browserSave', transferred: result.bytes, total: result.bytes, percent: 100 })
      }
    } catch (cause) {
      if (this.operation !== current || !this.alive) return
      const cancelled = cause instanceof TransferCancelledError || current.controller.signal.aborted
      this.publish({ ...this.state, paused: true })
      this.update(job.id, { phase: cancelled ? 'cancelled' : 'error', dispatched: cancelled ? cause instanceof TransferCancelledError ? cause.dispatched : true : undefined,
        error: cancelled ? undefined : cause instanceof Error ? cause.message : String(cause) })
    } finally {
      this.payloads.delete(job.id)
      if (this.operation === current) {
        this.operation = undefined
        this.publish({ ...this.state, activeId: undefined })
        if (this.alive && !this.state.paused) void this.pump()
      }
    }
  }
}
