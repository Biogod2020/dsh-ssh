import { afterEach, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile, readFile, lstat, chmod } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { remoteHistoryRead } from '../src/remote/history-reader.ts'

const read = (root: string, expected: {pid: number; port: number}, request: {sessionId: string; afterSeq: number; throughSeq?: number}) => remoteHistoryRead(root, expected, request, {readFile,lstat,join,isAbsolute})
const roots: string[] = [], servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'history-delta-')); roots.push(root)
  const records = Array.from({ length: 1104 }, (_, seq) => ({ type: 'event', event: { seq, type: seq % 8 ? 'tool/result' : 'user/message', data: 'fixture '.repeat(50) } }))
  const calls: Array<{ method: string; request: any }> = []
  const server = createServer(async (req, res) => {
    if (req.url === '/?token=fixture-only') { res.writeHead(303, { 'set-cookie': 'auth=fixture; HttpOnly', Location: '/' }); res.end(); return }
    if (req.headers.cookie !== 'auth=fixture' || req.headers.origin !== 'http://' + req.headers.host) { res.writeHead(403); res.end(); return }
    let raw = ''; for await (const chunk of req) raw += chunk
    const { rpcId, method, payload: { args: { request } } } = JSON.parse(raw)
    calls.push({ method, request })
    // Emulate message-aligned pages returning overlap. The SSH helper must
    // remove it remotely, including non-message events that list activity misses.
    const value = method === 'session/projections' ? { asOfSeq: records.length - 1, values: { title: 'fixture' } }
      : { records: records.slice(0, request.throughSeq + 1), hasMore: false }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ rpcId, result: { ok: true, value } }))
  })
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await mkdir(join(root, 'state'), { mode: 0o700 })
  const expected = { port, pid: process.pid }
  const receipt = { ...expected, protocol: 1, root, url: `http://127.0.0.1:${port}/?token=fixture-only` }
  await writeFile(join(root, 'state/server.json'), JSON.stringify(receipt), { mode: 0o600 })
  return { root, expected, calls, records }
}
it('checks exact cursor and transfers no history when the disk prefix is current', async () => {
  const f = await fixture(), value = await read(f.root, f.expected, { sessionId: 'session', afterSeq: 1103 })
  expect(value).toEqual({ cursor: 1103, throughSeq: 1103, records: [] })
  expect(f.calls.map(x => x.method)).toEqual(['session/projections'])
})
it('filters old message-aligned overlap before transport and bounds batches by events', async () => {
  const f = await fixture()
  const first = await read(f.root, f.expected, { sessionId: 'session', afterSeq: 1000 })
  expect(first.records).toEqual(f.records.slice(1001)); expect(first.cursor).toBe(1103)
  const page = await read(f.root, f.expected, { sessionId: 'session', afterSeq: -1 })
  expect(page.records).toEqual(f.records.slice(0, 500)); expect(page.throughSeq).toBe(499)
  const next = await read(f.root, f.expected, { sessionId: 'session', afterSeq: 499, throughSeq: 1103 })
  expect(next.records).toEqual(f.records.slice(500, 1000)); expect(next.throughSeq).toBe(999)
  expect(f.calls.filter(x => x.method === 'session/projections')).toHaveLength(2)
})
it('fails closed for changed remote identity, rewind, and malformed cursor without history reads', async () => {
  const f = await fixture()
  await expect(read(f.root, { ...f.expected, pid: 1 }, { sessionId: 'session', afterSeq: 0 })).rejects.toThrow('identity')
  expect(f.calls).toHaveLength(0)
  await expect(read(f.root, f.expected, { sessionId: 'session', afterSeq: 2000 })).rejects.toThrow('backwards')
  await expect(read(f.root, f.expected, { sessionId: 'session', afterSeq: 1.5 })).rejects.toThrow('Invalid')
  expect(f.calls.map(x => x.method)).toEqual(['session/projections'])
})

it('serializes a standalone remote program without bundler closure dependencies', () => {
  expect(remoteHistoryRead.toString()).not.toMatch(/__vite|__name|__import/)
})

it('reads history from the serialized program in a fresh Node process', async () => {
  const f = await fixture(), request = { sessionId: 'session', afterSeq: 1100 }
  const source = `const {readFile,lstat}=await import('node:fs/promises');
const {join,isAbsolute}=await import('node:path');
const result=await (${remoteHistoryRead.toString()})(process.argv[1],JSON.parse(process.argv[2]),JSON.parse(process.argv[3]),{readFile,lstat,join,isAbsolute});
process.stdout.write(JSON.stringify(result));`
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--input-type=module', '-e', source, f.root, JSON.stringify(f.expected), JSON.stringify(request)], { timeout: 10000 })
  expect(JSON.parse(stdout)).toEqual({ cursor: 1103, throughSeq: 1103, records: f.records.slice(1101) })
  expect(f.calls.map(x => x.method)).toEqual(['session/projections', 'session/page'])
})

it.skipIf(process.platform === 'win32')('rejects a remote receipt with group or other access', async () => {
  const f = await fixture()
  await chmod(join(f.root, 'state/server.json'), 0o644)
  await expect(read(f.root, f.expected, { sessionId: 'session', afterSeq: 1100 })).rejects.toThrow('Unsafe remote server receipt')
  expect(f.calls).toHaveLength(0)
})
