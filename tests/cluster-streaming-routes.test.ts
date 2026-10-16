import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SshEngine } from '../src/engine.ts'
import { HostStore } from '../src/store.ts'
import { makeRoutes } from '../src/routes.ts'
import { SshApi } from '../src/client/api.ts'
import { TestSshd } from './helpers/sshd.ts'
import type { ClusterOptions } from '../src/engine/cluster.ts'
import type { ClusterResult, ClusterStreamFrame } from '../src/protocol.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.unstubAllGlobals(); for (const close of cleanup.splice(0)) await close() })
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cluster-stream-')), remote = join(root, 'remote'); mkdirSync(remote)
  const sshd = await TestSshd.start({ home: remote }), store = new HostStore(join(root, 'hosts.json'))
  for (const alias of ['first', 'second', 'third']) store.create({ alias, host: '127.0.0.1', port: sshd.port, user: process.env.USER!, auth: { kind: 'key', keyPath: sshd.clientKey } })
  const engine = new SshEngine(store), { routes } = makeRoutes({ store, engine, stagingDir: join(root, 'stage'), requestRejection: () => undefined })
  const server: Server = createServer((req, res) => {
    const route = routes.find(route => route.path === req.url?.split('?')[0])!
    void Promise.resolve(route.handler(req, res)).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(String(error)) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  cleanup.push(async () => { engine.dispose(); sshd.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }) })
  const nativeFetch = globalThis.fetch
  vi.stubGlobal('fetch', (path: string | URL | Request, options?: RequestInit) => nativeFetch(typeof path === 'string' ? new URL(path, base) : path, options))
  return { remote, store, engine, base }
}

it('streams real SSH output before exit, Stop keeps partial output and never dispatches queued hosts', async () => {
  const f = await fixture(), api = new SshApi(), events: ClusterStreamFrame[] = []
  let stopping: Promise<void> | undefined
  let runId = ''
  const results = await api.clusterStream({ command: 'printf dispatch >> "$HOME/dispatch-count"; printf before-stop; sleep 2; printf after-stop', aliases: ['first', 'second', 'third'], maxWorkers: 1 }, frame => {
    events.push(frame)
    if (frame.type === 'plan') runId = frame.runId
    if (frame.type === 'output' && !stopping) stopping = api.cancelCluster(runId)
  })
  await stopping
  expect(results[0]).toMatchObject({ alias: 'first', cancelled: true, dispatched: true, stdout: 'before-stop' })
  expect(results.slice(1)).toMatchObject([{ alias: 'second', cancelled: true, dispatched: false }, { alias: 'third', cancelled: true, dispatched: false }])
  expect(readFileSync(join(f.remote, 'dispatch-count'), 'utf8')).toBe('dispatch')
  expect(events.at(-1)).toEqual({ type: 'complete', cancelled: true })
  expect((await f.engine.exec('first', 'printf STILL_ALIVE')).stdout).toBe('STILL_ALIVE')
}, 15000)

it('cancels the actual run after the response reader disconnects and clears its Stop handle', async () => {
  const f = await fixture(), original = f.engine.cluster.bind(f.engine)
  let options: ClusterOptions | undefined, pending: Promise<ClusterResult[]> | undefined
  vi.spyOn(f.engine, 'cluster').mockImplementation(value => { options = value; pending = original(value); return pending })
  const controller = new AbortController(), response = await fetch(f.base + '/api/dsh-ssh/cluster/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
    body: JSON.stringify({ command: 'printf dispatch >> "$HOME/lost-count"; printf before-loss; sleep 2', aliases: ['first', 'second'], maxWorkers: 1 }) })
  const reader = response.body!.getReader(), decoder = new TextDecoder()
  let text = ''
  while (!text.includes('before-loss')) { const { value } = await reader.read(); text += decoder.decode(value) }
  const runId = JSON.parse(text.split('\n')[0]!).runId
  controller.abort(); await reader.cancel().catch(() => undefined)
  await vi.waitFor(() => expect(options?.signal?.aborted).toBe(true))
  expect((await pending!)[1]).toMatchObject({ alias: 'second', dispatched: false, cancelled: true })
  expect(readFileSync(join(f.remote, 'lost-count'), 'utf8')).toBe('dispatch')
  const stopped = await fetch(f.base + '/api/dsh-ssh/cluster/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId }) })
  expect(stopped.status).toBe(404)
  expect(f.engine.cluster).toHaveBeenCalledOnce()
}, 15000)

it('streams a large real SSH response with browser clipping and preserves the connection', async () => {
  const f = await fixture()
  const result = await new SshApi().clusterStream({ command: "head -c 300000 /dev/zero | tr '\\000' x", aliases: ['first'] }, () => {})
  expect(result[0]?.ok).toBe(true)
  expect(result[0]?.stdout).toBe('x'.repeat(128 * 1024) + '\n…[browser output truncated]')
  expect((await f.engine.exec('first', 'printf AFTER_LARGE')).stdout).toBe('AFTER_LARGE')
}, 15000)

it('rejects stale reviewed targets before issuing any command', async () => {
  const f = await fixture(), oldVersion = f.store.find('first')!.updatedAt
  f.store.update('first', { description: 'Changed after review' })
  const res = await fetch(f.base + '/api/dsh-ssh/cluster/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'printf should-not-run', aliases: ['first'], expectedTargets: [{ alias: 'first', updatedAt: oldVersion }] }) })
  expect(res.status).toBe(400); expect(await res.text()).toContain('no command was dispatched')
  expect(f.engine.pool.size).toBe(0)
}, 15000)

it('freezes cached versions so an edited queued host is never dispatched', async () => {
  const f = await fixture()
  const results = await f.engine.cluster({ command: 'printf dispatch >> "$HOME/frozen-count"; printf completed', aliases: ['first', 'second'], maxWorkers: 1,
    onEvent: event => { if (event.type === 'result' && event.result.alias === 'first') f.store.update('second', { description: 'Changed while queued' }) },
  })
  expect(results[0]).toMatchObject({ ok: true, dispatched: true })
  expect(results[1]).toMatchObject({ ok: false, dispatched: false, error: expect.stringContaining('configuration changed') })
  expect(readFileSync(join(f.remote, 'frozen-count'), 'utf8')).toBe('dispatch')
}, 15000)
