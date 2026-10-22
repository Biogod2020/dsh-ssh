import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir, platform, arch, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import assert from 'node:assert/strict'

// Run in a disposable child process; count application IO, including metadata,
// instead of treating the compressed network response as the whole cost.
const originalOpen = fs.open, originalRead = fs.readFile
let io = { read: 0, written: 0, writes: 0 }
fs.open = async function (...args) {
  const handle = await originalOpen.apply(this, args)
  const write = handle.writeFile.bind(handle), read = handle.readFile.bind(handle), rangeRead=handle.read.bind(handle)
  let fullRead=false
  handle.writeFile = async function (data, ...options) {
    io.written += Buffer.byteLength(data); io.writes++
    return write(data, ...options)
  }
  handle.readFile = async function (...options) {fullRead=true;try{const data = await read(...options); io.read += Buffer.byteLength(data); return data}finally{fullRead=false}}
  handle.read=async function(...options){const result=await rangeRead(...options);if(!fullRead)io.read+=result.bytesRead;return result}
  return handle
}
fs.readFile = async function (...args) { const data = await originalRead.apply(this, args); io.read += Buffer.byteLength(data); return data }
syncBuiltinESMExports()
const [modulePath, countArg = '10000', samplesArg = '100', incrementsArg='30'] = process.argv.slice(2)
assert(modulePath, 'Supply a cache module and run Node with --experimental-transform-types --expose-gc')
const count = Number(countArg), samples = Number(samplesArg)
const increments=Number(incrementsArg)
assert(Number.isInteger(count) && count > 0 && count <= 100000)
assert(Number.isInteger(samples) && samples >= 30 && samples <= 200)
assert(Number.isInteger(increments)&&increments>=30&&increments<=10000)
const module = await import(pathToFileURL(resolve(modulePath)).href)
const Cache = module.SegmentedHistoryCache ?? module.RemoteHistoryCache
const root = await mkdtemp(join(tmpdir(), 'dsh-history-benchmark-'))
const key = module.historyKey('generated-host', 'generated-project', 'generated-session')
let cache = new Cache(root)
const text = 'Generated 中英文 history benchmark. '.repeat(24)
let records = Array.from({ length: count }, (_, seq) => ({ type: 'event', event: {
  seq, type: seq % 2 ? 'assistant/message' : 'user/message', content: [{ type: 'text', text: text + seq }],
} }))
let meta = { key, hostId: 'generated-host', workspaceId: 'generated-project', sessionId: 'generated-session', alias: 'fixture',
  remotePath: '/generated/project', title: 'Generated benchmark', cursor: count - 1, complete: true, savedAt: Date.now(), remoteUpdatedAt: 1 }
const summarize = values => { const sorted = [...values].sort((a,b) => a-b); return {
  samples: values.length, p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1),
} }
async function measure(n, fn) {
  const times = [], bytesRead = [], bytesWritten = [], writes = []
  for (let i=0;i<n;i++) {
    global.gc?.(); io = { read:0, written:0, writes:0 }
    const start = performance.now(); await fn(i); times.push(performance.now()-start)
    bytesRead.push(io.read); bytesWritten.push(io.written); writes.push(io.writes)
  }
  return { milliseconds: summarize(times), applicationBytesRead: summarize(bytesRead), applicationBytesWritten: summarize(bytesWritten), writeCalls: summarize(writes) }
}
try {
  await cache.list(); await cache.resume?.(key)
  await cache.save(meta, records, cache.token(key))
  const initialBytes = (await cache.meta(key)).bytes
  const readWindow = async () => {
    const copy = cache.window ? await cache.window(key, undefined, 100) : await cache.read(key)
    assert(copy && copy.records.slice(-100).length === Math.min(100, count)); return copy
  }
  const warm = await measure(samples, async () => { await readWindow() })
  const append = await measure(increments, async () => {
    const next = { type:'event', event:{seq:meta.cursor+1,type:'user/message',content:[{type:'text',text:'Generated single increment'}]} }
    meta = {...meta,cursor:next.event.seq,savedAt:Date.now()}
    if (cache.append) await cache.append(meta,[next],cache.token(key))
    else { records = [...records,next]; await cache.save(meta,records,cache.token(key)) }
  })
  const unchanged = await measure(samples, async () => { assert((await cache.meta(key)).cursor===meta.cursor); assert(await cache.present(key)) })
  const restart = await measure(30, async () => { await cache.close?.(); cache = new Cache(root); await readWindow() })
  console.log(JSON.stringify({ schema:1, store:Cache.name, node:process.version, platform:platform(), arch:arch(), memoryBytes:totalmem(),
    events:count, initialBytes, methodology:'generated mixed text; fixed 100-record window; GC before each untimed sample; filesystem cache not flushed; application IO includes metadata, not physical SSD bytes',
    warm,append,unchanged,restart,failures:0 },null,2))
} finally { await cache.close?.(); await rm(root,{recursive:true,force:true}) }
