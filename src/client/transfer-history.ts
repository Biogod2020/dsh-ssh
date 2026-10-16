/** Per-tab recovery metadata. File bytes and writable handles are never stored. */
import type { TransferJob } from './transfer-queue.ts'
export interface TransferHistory { read(): string | null; write(value: string): void; clear(): void }
const KEY = 'dsh-ssh:transfers:v1'
export const TRANSFER_HISTORY_BYTES = 1024 * 1024
export function browserTransferHistory(): TransferHistory {
  return { read: () => sessionStorage.getItem(KEY), write: value => sessionStorage.setItem(KEY, value), clear: () => sessionStorage.removeItem(KEY) }
}
const phases = ['queued', 'awaitingFile', 'awaitingSave', 'staging', 'connecting', 'transferring', 'saving', 'stopping', 'done', 'browserSave', 'cancelled', 'error', 'interrupted']
const invalid = (): never => { throw new Error('Invalid transfer recovery record') }
const text = (value: unknown, max: number): string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value) ? value : invalid()
const number = (value: unknown, max = Number.MAX_SAFE_INTEGER): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : invalid()
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid()
export function encodeTransferHistory(jobs: TransferJob[], sequence: number): string {
  const value = JSON.stringify({ version: 1, sequence, jobs })
  // Never replace a readable checkpoint with a record our own reader rejects.
  decodeTransferHistory(value)
  return value
}
export function decodeTransferHistory(raw: string): { jobs: TransferJob[]; sequence: number } {
  if (new TextEncoder().encode(raw).length > TRANSFER_HISTORY_BYTES) return invalid()
  const record = object(JSON.parse(raw))
  if (record.version !== 1 || !Array.isArray(record.jobs) || record.jobs.length > 130) return invalid()
  const sequence = number(record.sequence), ids = new Set<number>()
  const jobs = record.jobs.map(value => {
    const row = object(value), id = number(row.id)
    if (!id || id > sequence || ids.has(id) || !phases.includes(String(row.phase)) || !['upload', 'download'].includes(String(row.kind))) return invalid()
    ids.add(id)
    const job: TransferJob = { id, kind: row.kind as TransferJob['kind'], phase: row.phase as TransferJob['phase'], alias: text(row.alias, 512),
      host: text(row.host, 512), user: text(row.user, 512), port: number(row.port, 65535), updatedAt: number(row.updatedAt),
      path: text(row.path, 4096), file: text(row.file, 512), transferred: number(row.transferred), total: number(row.total),
      percent: typeof row.percent === 'number' && Number.isFinite(row.percent) && row.percent >= 0 && row.percent <= 100 ? row.percent : invalid() }
    if (!job.port || !job.path.startsWith('/')) return invalid()
    if (row.dispatched !== undefined) { if (typeof row.dispatched !== 'boolean') return invalid(); job.dispatched = row.dispatched }
    if (row.error !== undefined) { if (typeof row.error !== 'string' || row.error.length > 32768) return invalid(); job.error = row.error }
    if (row.sourceSize !== undefined) job.sourceSize = number(row.sourceSize)
    if (row.sourceModified !== undefined) job.sourceModified = number(row.sourceModified)
    if (row.saveMode !== undefined) { if (!['picker', 'browser'].includes(String(row.saveMode))) return invalid(); job.saveMode = row.saveMode as 'picker' | 'browser' }
    if (job.kind === 'upload' && (job.sourceSize === undefined || job.sourceModified === undefined)) return invalid()
    if (job.kind === 'download' && job.saveMode === undefined) return invalid()
    if (row.localName !== undefined) {
      if (job.kind !== 'download' || job.saveMode !== 'picker') return invalid()
      job.localName = text(row.localName, 512)
      if (job.localName.includes('/')) return invalid()
    }
    if (job.phase === 'saving' && (job.kind !== 'download' || job.saveMode !== 'picker')) return invalid()
    return job
  })
  if (jobs.filter(job => !['done', 'browserSave', 'cancelled', 'error', 'interrupted'].includes(job.phase)).length > 100) return invalid()
  if (jobs.filter(job => ['done', 'browserSave', 'cancelled', 'error', 'interrupted'].includes(job.phase)).length > 30) return invalid()
  return { jobs, sequence }
}
