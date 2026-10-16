/** Read-only receipts in this tab. No operation handles or executable recovery. */
import type { ClusterRequest, ClusterResult, ClusterTarget } from '../protocol.ts'

export type ClusterPhase = 'queued' | 'connecting' | 'running' | 'ok' | 'fail' | 'timeout' | 'stopped' | 'notRun' | 'unknown'
export interface ClusterRow extends ClusterTarget {
  phase: ClusterPhase; stdout: string; stderr: string; result?: ClusterResult
  outputTruncated?: Partial<Record<'stdout' | 'stderr', boolean>>
}
export interface ClusterRun {
  id: number; request: ClusterRequest; rows: ClusterRow[]; startedAt: number; finishedAt?: number
  phase: 'running' | 'stopping' | 'complete' | 'cancelled' | 'interrupted'; error?: string; recovered?: boolean
}
export interface ClusterRecord { runs: ClusterRun[]; selected: number | null; sequence: number }
export interface ClusterHistory { read(): string | null; write(value: string): void; clear(): void }
export const CLUSTER_HISTORY_BYTES = 1024 * 1024
export const CLUSTER_SAVED_STREAM_BYTES = 128 * 1024
const KEY = 'dsh-ssh:cluster:v1'
const phases: ClusterPhase[] = ['queued', 'connecting', 'running', 'ok', 'fail', 'timeout', 'stopped', 'notRun', 'unknown']
const encoder = new TextEncoder()
export function browserClusterHistory(): ClusterHistory {
  return { read: () => sessionStorage.getItem(KEY), write: value => sessionStorage.setItem(KEY, value), clear: () => sessionStorage.removeItem(KEY) }
}
export function clusterRowFinal(row: ClusterRow): boolean { return !['queued', 'connecting', 'running'].includes(row.phase) }
export function clusterFinalPhase(result: ClusterResult): ClusterPhase {
  return result.ok ? 'ok' : result.cancelled ? result.dispatched === false ? 'notRun' : 'stopped' : result.timedOut ? 'timeout' : 'fail'
}
const invalid = (): never => { throw new Error('Invalid cluster recovery record') }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid()
const number = (value: unknown, max = Number.MAX_SAFE_INTEGER): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : invalid()
function text(value: unknown, max: number, identity = false): string {
  if (typeof value !== 'string' || value.length > max || identity && (!value || /[\0\r\n]/.test(value))) return invalid()
  return value
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10000) return invalid()
  const list = value.map(item => text(item, 512, true))
  if (new Set(list).size !== list.length) return invalid()
  return list
}
function result(value: unknown, alias: string): ClusterResult {
  const row = object(value)
  if (row.alias !== alias || typeof row.ok !== 'boolean') return invalid()
  const parsed: ClusterResult = { alias, ok: row.ok }
  if (row.exitCode !== undefined) {
    if (row.exitCode !== null && (typeof row.exitCode !== 'number' || !Number.isSafeInteger(row.exitCode))) return invalid()
    parsed.exitCode = row.exitCode as number | null
  }
  if (row.durationMs !== undefined) parsed.durationMs = number(row.durationMs)
  if (row.error !== undefined) parsed.error = text(row.error, 32768)
  for (const key of ['timedOut', 'dispatched', 'cancelled'] as const) {
    if (row[key] !== undefined) { if (typeof row[key] !== 'boolean') return invalid(); parsed[key] = row[key] }
  }
  if (parsed.ok && (parsed.cancelled || parsed.timedOut || parsed.dispatched === false)) return invalid()
  return parsed
}
/** Validates the entire bounded record before exposing any restored receipt. */
export function decodeClusterHistory(raw: string): ClusterRecord {
  if (encoder.encode(raw).byteLength > CLUSTER_HISTORY_BYTES) return invalid()
  const record = object(JSON.parse(raw)), ids = new Set<number>()
  if (record.version !== 1 || !Array.isArray(record.runs) || record.runs.length > 3) return invalid()
  const sequence = number(record.sequence)
  const runs = record.runs.map(value => {
    const saved = object(value), id = number(saved.id), startedAt = number(saved.startedAt)
    if (!id || id > sequence || ids.has(id) || !startedAt || !['running', 'stopping', 'complete', 'cancelled', 'interrupted'].includes(String(saved.phase))) return invalid()
    ids.add(id)
    if (!Array.isArray(saved.rows) || !saved.rows.length || saved.rows.length > 10000) return invalid()
    const aliases = new Set<string>()
    const rows: ClusterRow[] = saved.rows.map(value => {
      const item = object(value), alias = text(item.alias, 512, true)
      if (aliases.has(alias) || !phases.includes(item.phase as ClusterPhase)) return invalid()
      aliases.add(alias)
      const row: ClusterRow = { alias, host: text(item.host, 512, true), user: text(item.user, 512, true), port: number(item.port, 65535),
        updatedAt: number(item.updatedAt), phase: item.phase as ClusterPhase, stdout: text(item.stdout, CLUSTER_HISTORY_BYTES), stderr: text(item.stderr, CLUSTER_HISTORY_BYTES) }
      if (!row.port || !row.updatedAt) return invalid()
      if (item.result !== undefined) { row.result = result(item.result, alias); if (clusterFinalPhase(row.result) !== row.phase) return invalid() }
      if (['ok', 'fail', 'timeout', 'stopped'].includes(row.phase) && !row.result) return invalid()
      if (item.outputTruncated !== undefined) {
        const flags = object(item.outputTruncated); row.outputTruncated = {}
        for (const key of ['stdout', 'stderr'] as const) if (flags[key] !== undefined) {
          if (typeof flags[key] !== 'boolean') return invalid(); row.outputTruncated[key] = flags[key]
        }
      }
      return row
    })
    const input = object(saved.request), command = text(input.command, CLUSTER_HISTORY_BYTES)
    if (!command.trim()) return invalid()
    const request: ClusterRequest = { command, expectedTargets: rows.map(({ alias, updatedAt }) => ({ alias, updatedAt })) }
    if (input.aliases !== undefined) request.aliases = strings(input.aliases)
    if (input.environment !== undefined) request.environment = text(input.environment, 512, true)
    if (input.tags !== undefined) request.tags = strings(input.tags)
    if (input.maxWorkers !== undefined) { request.maxWorkers = number(input.maxWorkers, 8); if (!request.maxWorkers) return invalid() }
    if (input.timeoutMs !== undefined) { request.timeoutMs = number(input.timeoutMs, 3600000); if (!request.timeoutMs) return invalid() }
    if (input.expectedTargets !== undefined) {
      if (!Array.isArray(input.expectedTargets) || input.expectedTargets.length !== rows.length) return invalid()
      const expected = input.expectedTargets.map(value => { const target = object(value); return { alias: text(target.alias, 512, true), updatedAt: number(target.updatedAt) } })
      const versions = new Map(rows.map(row => [row.alias, row.updatedAt]))
      if (new Set(expected.map(value => value.alias)).size !== rows.length || expected.some(target => versions.get(target.alias) !== target.updatedAt)) return invalid()
    }
    const run: ClusterRun = { id, request, rows, startedAt, phase: saved.phase as ClusterRun['phase'] }
    if (saved.finishedAt !== undefined) { run.finishedAt = number(saved.finishedAt); if (run.finishedAt < startedAt) return invalid() }
    if (saved.error !== undefined) run.error = text(saved.error, 32768)
    if (saved.recovered !== undefined) { if (typeof saved.recovered !== 'boolean') return invalid(); run.recovered = saved.recovered }
    if (['running', 'stopping'].includes(run.phase) && run.finishedAt !== undefined) return invalid()
    if (['complete', 'cancelled'].includes(run.phase) && (!run.finishedAt || rows.some(row => !clusterRowFinal(row) || !row.result))) return invalid()
    return run
  })
  const selected = record.selected === null ? null : number(record.selected)
  if (selected !== null && !ids.has(selected) || runs.length && selected === null) return invalid()
  return { runs, selected, sequence }
}
const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength
function prefixWithin(text: string, budget: number): string {
  // Budget includes JSON escaping, not just the unescaped UTF-8 output.
  let low = 0, high = Math.min(text.length, budget)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (jsonBytes(text.slice(0, mid)) - 2 <= budget) low = mid; else high = mid - 1
  }
  if (low < text.length && /[\uD800-\uDBFF]/.test(text.charAt(low - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(low))) low--
  return text.slice(0, low)
}
/** Keeps identities/results, then bounded output prefixes; never mutates live output. */
export function encodeClusterHistory(record: ClusterRecord): string {
  const runs = record.runs.map(run => ({ id: run.id, startedAt: run.startedAt, finishedAt: run.finishedAt, phase: run.phase, error: run.error, recovered: run.recovered,
    request: { command: run.request.command, aliases: run.request.aliases, environment: run.request.environment, tags: run.request.tags,
      maxWorkers: run.request.maxWorkers, timeoutMs: run.request.timeoutMs, expectedTargets: run.rows.map(({ alias, updatedAt }) => ({ alias, updatedAt })) },
    rows: run.rows.map(row => ({ alias: row.alias, host: row.host, port: row.port, user: row.user, updatedAt: row.updatedAt, phase: row.phase,
      result: row.result === undefined ? undefined : result(row.result, row.alias), stdout: '', stderr: '', outputTruncated: { stdout: false, stderr: false } })) }))
  const saved = { version: 1, sequence: record.sequence, selected: record.selected, runs }
  let budget = CLUSTER_HISTORY_BYTES - jsonBytes(saved)
  if (budget < 0) throw new Error('Cluster identities and command exceed the recovery record limit')
  // Recent receipts get the output allowance first; metadata for all three remains.
  for (let index = runs.length - 1; index >= 0; index--) for (let rowIndex = 0; rowIndex < runs[index]!.rows.length; rowIndex++) {
    const source = record.runs[index]!.rows[rowIndex]!, row = runs[index]!.rows[rowIndex]!
    for (const stream of ['stdout', 'stderr'] as const) {
      row[stream] = prefixWithin(source[stream], Math.min(budget, CLUSTER_SAVED_STREAM_BYTES))
      budget -= jsonBytes(row[stream]) - 2
      row.outputTruncated[stream] = Boolean(source.outputTruncated?.[stream]) || row[stream].length < source[stream].length
    }
  }
  const raw = JSON.stringify(saved)
  decodeClusterHistory(raw) // No successful write can produce an unreadable checkpoint.
  return raw
}
export function recoverClusterRecord(record: ClusterRecord): ClusterRecord {
  return { ...record, runs: record.runs.map(run => ['running', 'stopping'].includes(run.phase) || run.phase === 'interrupted' && run.rows.some(row => row.phase === 'unknown') ? { ...run, phase: 'interrupted', recovered: true,
    rows: run.rows.map(row => clusterRowFinal(row) ? row : { ...row, phase: 'unknown' }) } : run) }
}
