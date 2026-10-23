/** Fixed generated Session-list data. This measures a controller decoder,
 * not SSH, native navigation, browser memory or physical disk IO. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { cpus, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { CatalogJsonReader } from '../src/remote/catalog-json.ts'

const [variant, countText, output] = process.argv.slice(2), count = Number(countText)
assert(['legacy', 'worker'].includes(variant) && [100, 1000, 10000].includes(count) && output,
  'usage: node --expose-gc --experimental-transform-types scripts/catalog-json-benchmark.mjs legacy|worker 100|1000|10000 NEW_OUTPUT_JSON')
assert.equal(typeof global.gc, 'function', 'Run with --expose-gc')
const items = Array.from({ length: count }, (_, index) => ({ sessionId: 'generated-session-' + index,
  updatedAt: index, running: false, blank: false, origin: 'user',
  projections: { values: { title: ('Generated 中英文 🧪 title ' + index + ' ').repeat(10) } },
}))
const expected = { rpcId: 'generated-benchmark', result: { ok: true, value: { items } } }
const input = Buffer.from(JSON.stringify(expected)), reader = new CatalogJsonReader()
const parse = () => variant === 'legacy' ? Promise.resolve(JSON.parse(input.toString('utf8'))) : reader.parse(input)
const latency = [], gaps = [], rss = []
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return { samples: sorted.length, p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) }
}
let failures = 0
try {
  assert.deepEqual(await parse(), expected)
  while (reader.stats().active) await delay(1)
  for (let sample = 0; sample < 100; sample++) {
    global.gc()
    let previous = performance.now(), maximumGap = 0, maximumRss = process.memoryUsage.rss()
    const heartbeat = setInterval(() => {
      const now = performance.now(); maximumGap = Math.max(maximumGap, now - previous); previous = now
      maximumRss = Math.max(maximumRss, process.memoryUsage.rss())
    }, 1)
    try {
      await delay(2)
      const began = performance.now(), value = await parse()
      latency.push(performance.now() - began)
      assert.equal(value.result.value.items.length, count)
      assert.equal(value.result.value.items[count - 1].projections.values.title, items[count - 1].projections.values.title)
      while (reader.stats().active) await delay(1)
      await delay(2)
      gaps.push(maximumGap); rss.push(maximumRss)
    } catch (error) { failures++; throw error }
    finally { clearInterval(heartbeat) }
  }
  const report = {
    schema: 1, scope: 'Controller JSON decoding only; no SSH, native UI, model, disk or network benchmark',
    variant, sessions: count, inputBytes: input.length, inputSha256: createHash('sha256').update(input).digest('hex'),
    node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, memoryBytes: totalmem(),
    methodology: { samples: 100, separateProcessPerCase: true, gcBeforeEachSample: true, reusedInputBuffer: true,
      warmup: 'one full verified decode before timing; Worker startup is outside these warm samples',
      timedWork: 'UTF-8 decoding and JSON parsing; Worker return cloning included', timerMilliseconds: 1,
      timerGapIncludesWorkerExitAndTailObservation: true, noForcedSystemCacheFlush: true,
      processRssIncludesAllThreadsAndRuntime: true, workerLifetime: 'one reusable bounded Worker; 30-second idle retirement',
      limitation: 'Timer scheduling is sampled, not a profiler; Worker startup, buffer copies, result cloning and GC still cost time.' },
    milliseconds: summary(latency), maximumTimerGapMilliseconds: summary(gaps), processRssBytes: summary(rss),
    workersStarted: reader.stats().workersStarted, workerDecodes: reader.stats().workerDecodes, failures,
  }
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify({ variant, sessions: count, inputBytes: input.length, milliseconds: report.milliseconds,
    maximumTimerGapMilliseconds: report.maximumTimerGapMilliseconds, failures }))
} finally { reader.close() }
