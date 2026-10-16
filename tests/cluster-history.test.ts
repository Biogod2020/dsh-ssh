import { expect, it } from 'vitest'
import { CLUSTER_HISTORY_BYTES, CLUSTER_SAVED_STREAM_BYTES, decodeClusterHistory, encodeClusterHistory, recoverClusterRecord, type ClusterRecord, type ClusterRun } from '../src/client/cluster-history.ts'
function run(id = 1): ClusterRun { return { id, phase: 'running', startedAt: 100, request: { command: 'printf original', maxWorkers: 1, timeoutMs: 60000, aliases: ['first', 'second'] },
  rows: [{ alias: 'first', host: 'old.host', user: 'original', port: 2222, updatedAt: 12, phase: 'running', stdout: 'before disconnect\n', stderr: '' },
    { alias: 'second', host: 'second.host', user: 'original', port: 2223, updatedAt: 13, phase: 'queued', stdout: '', stderr: '' }] } }
function record(): ClusterRecord { return { runs: [run()], sequence: 1, selected: 1 } }
it('restores original identities and output, turns all unfinished hosts unknown and never invents a finish time', () => {
  const original = record(), saved = encodeClusterHistory(original), recovered = recoverClusterRecord(decodeClusterHistory(saved))
  expect(recovered.runs[0]).toMatchObject({ phase: 'interrupted', recovered: true, request: { command: 'printf original', expectedTargets: [{ alias: 'first', updatedAt: 12 }, { alias: 'second', updatedAt: 13 }] } })
  expect(recovered.runs[0]?.rows.map(row => row.phase)).toEqual(['unknown', 'unknown'])
  expect(recovered.runs[0]?.rows[0]).toMatchObject({ host: 'old.host', user: 'original', port: 2222, stdout: 'before disconnect\n' })
  expect(recovered.runs[0]?.finishedAt).toBeUndefined(); expect(original.runs[0]?.phase).toBe('running')
})
it('preserves confirmed success and cancellation receipts when the rest of a run is interrupted', () => {
  const original = record(), row = original.runs[0]!.rows[0]!
  row.phase = 'ok'; row.result = { alias: 'first', ok: true, exitCode: 0, durationMs: 50, dispatched: true }
  const restored = recoverClusterRecord(decodeClusterHistory(encodeClusterHistory(original)))
  expect(restored.runs[0]?.rows[0].result).toEqual(row.result); expect(restored.runs[0]?.rows[0].phase).toBe('ok'); expect(restored.runs[0]?.rows[1].phase).toBe('unknown')
  original.runs[0]!.phase = 'cancelled'; original.runs[0]!.finishedAt = 200
  original.runs[0]!.rows[1] = { ...original.runs[0]!.rows[1]!, phase: 'notRun', result: { alias: 'second', ok: false, cancelled: true, dispatched: false } }
  expect(recoverClusterRecord(decodeClusterHistory(encodeClusterHistory(original))).runs[0]?.phase).toBe('cancelled')
})
it('marks a saved response-loss receipt as recovered while keeping its error and confirmed host result', () => {
  const original = record(); original.runs[0]!.phase = 'interrupted'; original.runs[0]!.error = 'network error'; original.runs[0]!.finishedAt = 200
  original.runs[0]!.rows[0]!.phase = 'ok'; original.runs[0]!.rows[0]!.result = { alias: 'first', ok: true, exitCode: 0 }
  original.runs[0]!.rows[1]!.phase = 'unknown'
  const restored = recoverClusterRecord(decodeClusterHistory(encodeClusterHistory(original)))
  expect(restored.runs[0]).toMatchObject({ recovered: true, error: 'network error', rows: [{ phase: 'ok' }, { phase: 'unknown' }] })
})
it('whitelists public metadata, avoids duplicate result output and stores no operation handles or host credentials', () => {
  const original = record(); Object.assign(original.runs[0]!, { runId: 'private-handle', controller: {}, password: 'fixture-private' })
  Object.assign(original.runs[0]!.rows[0]!, { auth: { password: 'fixture-private' }, proxyCommand: 'private-command' })
  original.runs[0]!.rows[0]!.phase = 'ok'; original.runs[0]!.rows[0]!.result = { alias: 'first', ok: true, stdout: 'duplicated-stdout', stderr: 'duplicated-stderr' }
  const raw = encodeClusterHistory(original)
  expect(raw).not.toMatch(/private-handle|fixture-private|private-command|duplicated-stdout|duplicated-stderr/)
  expect(raw).toContain('before disconnect')
})
it('bounds saved output including JSON escaping, preserves unicode prefixes, labels omissions and leaves live content unchanged', () => {
  const original: ClusterRecord = { runs: [run(1), run(2), run(3)], sequence: 3, selected: 3 }
  for (const r of original.runs) for (const row of r.rows) { row.stdout = '中文🙂\\\n\0'.repeat(80000); row.stderr = 'stderr'.repeat(100000) }
  const before = original.runs[2]!.rows[0]!.stdout, raw = encodeClusterHistory(original), saved = decodeClusterHistory(raw)
  expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(CLUSTER_HISTORY_BYTES)
  for (const r of saved.runs) for (const row of r.rows) for (const stream of ['stdout', 'stderr'] as const) {
    expect(new TextEncoder().encode(JSON.stringify(row[stream])).byteLength - 2).toBeLessThanOrEqual(CLUSTER_SAVED_STREAM_BYTES)
    expect(row.outputTruncated?.[stream]).toBe(true)
    expect(original.runs.find(source => source.id === r.id)!.rows.find(source => source.alias === row.alias)![stream].startsWith(row[stream])).toBe(true)
    expect(row[stream]).not.toMatch(/[\uD800-\uDBFF]$/)
  }
  expect(original.runs[2]!.rows[0]!.stdout).toBe(before)
  expect(saved.runs[2]!.rows[0]!.stdout.length).toBeGreaterThan(0)
  expect(decodeClusterHistory(encodeClusterHistory(saved)).runs[2]?.rows[0]?.outputTruncated?.stdout).toBe(true)
})
it.each([
  (saved: any) => { saved.version = 2 },
  (saved: any) => { saved.sequence = -1 },
  (saved: any) => { saved.runs.push(saved.runs[0]) },
  (saved: any) => { saved.selected = 42 },
  (saved: any) => { saved.runs[0].rows[1].alias = 'first' },
  (saved: any) => { saved.runs[0].rows[0].updatedAt = 0 },
  (saved: any) => { saved.runs[0].rows[0].port = 65536 },
  (saved: any) => { saved.runs[0].rows[0].stdout = null },
  (saved: any) => { saved.runs[0].rows[0].phase = 'ok' },
  (saved: any) => { saved.runs[0].request.expectedTargets[0].updatedAt++ },
  (saved: any) => { saved.runs[0].request.maxWorkers = 9 },
  (saved: any) => { saved.runs[0].phase = 'complete'; saved.runs[0].finishedAt = 200 },
])('rejects malformed identities, phases, options and receipt scope %#', mutate => {
  const saved = JSON.parse(encodeClusterHistory(record())); mutate(saved); expect(() => decodeClusterHistory(JSON.stringify(saved))).toThrow()
})
it('rejects oversized or impossible metadata before it can replace a usable checkpoint', () => {
  expect(() => decodeClusterHistory(' '.repeat(CLUSTER_HISTORY_BYTES + 1))).toThrow()
  const original = record(); original.runs[0]!.request.command = 'x'.repeat(CLUSTER_HISTORY_BYTES)
  expect(() => encodeClusterHistory(original)).toThrow(/limit/)
  expect(() => encodeClusterHistory({ ...record(), runs: [run(1), run(2), run(3), run(4)], sequence: 4, selected: 4 })).toThrow()
})
