/** Long-running acceptance helper. All callbacks target generated isolated
 * data; an uncertain append is recorded and never dispatched again. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { cpus, totalmem } from 'node:os'

export function soakDuration(args) {
  const options = args.filter(value => value.startsWith('--soak-seconds='))
  assert(options.length <= 1, 'Supply one soak duration')
  if (!options.length) return 0
  const seconds = Number(options[0].slice('--soak-seconds='.length))
  assert(Number.isSafeInteger(seconds) && seconds >= 5 && seconds <= 7 * 86400, 'Soak duration must be 5 through 604800 whole seconds')
  return seconds
}

export async function runHistorySoak({ seconds, archiveSha256, harnessSha256, runtime, output, initialCopy, append, read, status, signal }) {
  assert(seconds >= 5 && Number.isSafeInteger(seconds))
  assert(output && /^[a-f0-9]{64}$/.test(archiveSha256))
  const wallBegan = Date.now(), began = performance.now(), interval = Math.min(60000, Math.floor(seconds * 1000 / 10))
  const report = {
    schema: 1, scope: 'Installed DSH with generated SSH/history/drafts; no native renderer, WAN or model request',
    node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, memoryBytes: totalmem(), ...(runtime ? {runtime} : {}),
    archiveSha256, requestedSeconds: seconds, intervalMilliseconds: interval, startedAt: new Date(wallBegan).toISOString(),
    observerSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'), ...(harnessSha256 ? {harnessSha256} : {}),
    completed: false, passed: false, minimum24HoursVerified: false, modelRequests: 0, uncertainAppend: false, confirmedAppends: 0, samples: [], failures: [],
  }
  let copy = initialCopy, next = began, ordinal = 0, priorClockDelta = 0
  const record = (phase, error) => report.failures.push({ phase, ordinal, elapsedMilliseconds: performance.now() - began, errorClass: error.name })
  async function checkpoint() {
    const temporary = output + '.' + randomUUID() + '.tmp'
    await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, output)
  }
  const pause = milliseconds => new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, milliseconds)
    signal?.addEventListener('abort', finish, { once: true })
    if (signal?.aborted) finish()
  })
  // A later run must not overwrite a previous observation, including failures.
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  try {
    await checkpoint()
    while (!signal?.aborted) {
      if (performance.now() < next) await pause(next - performance.now())
      if (signal?.aborted) break
      const sampledAt = performance.now(), late = sampledAt - next
      const clockDelta = Date.now() - wallBegan - (sampledAt - began)
      if (Math.abs(clockDelta - priorClockDelta) > 5000) record('clock-or-suspend-gap', new Error('Wall and monotonic clocks diverged'))
      priorClockDelta = clockDelta
      if (late > Math.min(5000, interval * .5)) record('scheduling-gap', new Error('Observation paused or delayed'))
      const prior = report.samples.at(-1)
      if (prior && sampledAt - began - prior.elapsedMilliseconds > interval + 5000)
        record('probe-spacing-gap', new Error('Runtime checks were not observed at the required cadence'))
      let minimumCursor = copy.meta.cursor
      // Test continual incremental commits without generating model requests.
      // Each ordinal is dispatched at most once, including after a lost ACK.
      if (ordinal > 0 && ordinal % 5 === 0 && !report.uncertainAppend) {
        try { await append(ordinal); report.confirmedAppends++; minimumCursor++ }
        catch (error) { report.uncertainAppend = true; record('append-outcome-unconfirmed', error) }
      }
      let resources
      try {
        resources = await status()
        assert.equal(resources.remotePidPreserved, true)
        const latest = await read(minimumCursor)
        assert.equal(latest.meta.key, initialCopy.meta.key)
        assert.equal(latest.meta.firstSavedAt, initialCopy.meta.firstSavedAt)
        assert.equal(latest.meta.complete, true)
        assert(latest.meta.cursor >= minimumCursor)
        assert.deepEqual(latest.records.slice(0, copy.records.length), copy.records)
        copy = latest
      } catch (error) { record('runtime-history-or-draft-check', error) }
      report.samples.push({ ordinal, elapsedMilliseconds: performance.now() - began, schedulingDelayMilliseconds: late,
        cursor: copy.meta.cursor, records: copy.records.length, ...(resources ?? {}) })
      await checkpoint()
      if (performance.now() - began >= seconds * 1000) { report.completed = true; break }
      ordinal++
      // Never burst missed work after sleep. Retain the gap as a failure.
      next = Math.min(performance.now() + interval, began + seconds * 1000)
    }
  } finally {
    report.elapsedMilliseconds = performance.now() - began
    report.wallElapsedMilliseconds = Date.now() - wallBegan
    report.finishedAt = new Date().toISOString()
    report.interrupted = signal?.aborted === true
    report.minimumSamples = Math.ceil(seconds * 1000 / interval * .95)
    report.passed = report.completed && !report.interrupted && report.failures.length === 0
      && report.elapsedMilliseconds >= seconds * 1000 && report.wallElapsedMilliseconds >= seconds * 1000
      && report.samples.length >= report.minimumSamples
    report.minimum24HoursVerified = report.passed && seconds >= 86400
    await checkpoint()
  }
  if (!report.passed) throw new Error('Isolated runtime soak did not pass; inspect its private report')
  return copy
}
