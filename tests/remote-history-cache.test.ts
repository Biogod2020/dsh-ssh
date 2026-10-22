import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, readdir, unlink, chmod, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteHistoryCache, historyKey, type HistoryRecord } from '../src/remote/history-cache.ts'
import { RemoteHistoryService } from '../src/remote/history-service.ts'
import type { RemoteGateway } from '../src/remote/gateway.ts'

const roots: string[] = []
afterEach(async () => { vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ssh-history-cache-')); roots.push(root)
  const cache = new RemoteHistoryCache(join(root, 'history')); await cache.list()
  const item = { id: 'local-project', hostId: 'host', workspaceId: 'remote-project', alias: 'fixture', title: 'Project', remotePath: '/remote/project' }
  const key = historyKey(item.hostId, item.workspaceId, 'session')
  const meta = { key, hostId: item.hostId, workspaceId: item.workspaceId, sessionId: 'session', alias: item.alias, remotePath: item.remotePath,
    title: 'Saved conversation', savedAt: Date.now(), remoteUpdatedAt: 1, cursor: 2, complete: true }
  const rows = (from: number, to: number): HistoryRecord[] => Array.from({ length: to - from + 1 }, (_, n) => ({ type: 'event', event: { seq: from + n, type: n % 2 ? 'assistant/message' : 'user/message', content: [{ type: 'text', text: 'saved '+(from+n) }] } }))
  return { root, cache, key, meta, item, rows }
}
it('persists complete history on disk across restarts and years, with private files and no automatic eviction', async () => {
  const f = await fixture(); const records = f.rows(0, 2)
  await f.cache.save(f.meta, records, f.cache.token())
  expect((await stat(join(f.root, 'history'))).mode & 0o777).toBe(0o700)
  expect((await stat(join(f.root, 'history', f.key + '.json'))).mode & 0o777).toBe(0o600)
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 10 * 365 * 86400000)
  const restarted = new RemoteHistoryCache(join(f.root, 'history'))
  expect((await restarted.read(f.key))?.records).toEqual(records)
  expect((await restarted.list()).reminder).toBe(true)
  await restarted.snooze(); expect((await restarted.list()).reminder).toBe(false)
  expect((await new RemoteHistoryCache(join(f.root, 'history')).read(f.key))?.records).toEqual(records)
})
it('clears selected local copies only, fences pending writes, and preserves other Hosts', async () => {
  const f = await fixture(), token = f.cache.token(), otherKey = historyKey('other-host', f.meta.workspaceId, 'session')
  await f.cache.save(f.meta, f.rows(0, 2), token)
  await f.cache.save({ ...f.meta, key: otherKey, hostId: 'other-host' }, f.rows(0, 2), token)
  await f.cache.clear([f.key])
  expect(await f.cache.save(f.meta, f.rows(0, 2), token)).toBe(false)
  expect(await f.cache.read(f.key)).toBeUndefined()
  expect((await f.cache.read(otherKey))?.records).toHaveLength(3)
  expect(await readdir(join(f.root, 'history'))).not.toContain(f.key+'.json')
})
it('recovers a committed file without its index and refuses unsafe files without overwriting them', async () => {
  const f = await fixture(); await f.cache.save(f.meta, f.rows(0, 2), f.cache.token())
  await unlink(join(f.root, 'history/index.json'))
  expect((await new RemoteHistoryCache(join(f.root, 'history')).list()).entries).toHaveLength(1)
  const file = join(f.root, 'history', f.key+'.json'), original = await readFile(file, 'utf8')
  await chmod(file, 0o644)
  const unsafe = new RemoteHistoryCache(join(f.root, 'history'))
  expect((await unsafe.list()).warning).toContain('preserved')
  await expect(unsafe.save(f.meta, f.rows(0, 2), unsafe.token())).rejects.toThrow('preserved')
  expect(await readFile(file, 'utf8')).toBe(original)
})
it('rejects path traversal, gaps, and symlinked roots', async () => {
  const f = await fixture()
  await expect(f.cache.read('../../other')).rejects.toThrow('identity')
  await expect(f.cache.save(f.meta, [f.rows(0, 2)[0]!, f.rows(0, 2)[2]!], f.cache.token())).rejects.toThrow('gap')
  const target = join(f.root, 'target'); await writeFile(target, 'untouched', { mode: 0o600 }); await symlink(target, join(f.root, 'symlink'))
  const unsafe = new RemoteHistoryCache(join(f.root, 'symlink'))
  expect((await unsafe.list()).warning).toBeTruthy(); expect(await readFile(target, 'utf8')).toBe('untouched')
})
it('uses cursors instead of list timestamps, coalesces checks, and never downloads unopened histories', async () => {
  const f = await fixture(), all = f.rows(0, 5); let head = 2
  const delta = vi.fn(async (after: number) => ({ cursor: head, throughSeq: head, records: all.slice(after + 1, head + 1) }))
  const source = vi.fn(async () => ({ gateway: {} as RemoteGateway, delta, check() {}, updatedAt: 1, title: 'Saved' }))
  const service = new RemoteHistoryService(f.cache, source)
  await service.sync(f.item, 'never-opened', false, 10); expect(source).not.toHaveBeenCalled()
  await service.sync(f.item, 'session'); expect((await f.cache.read(f.key))?.records).toEqual(all.slice(0, 3))
  await service.sync(f.item, 'session', false, 1); expect(delta).toHaveBeenCalledOnce()
  const diskReads = vi.spyOn(f.cache, 'read')
  await service.sync(f.item, 'session'); expect(delta).toHaveBeenLastCalledWith(2, undefined)
  expect(diskReads).not.toHaveBeenCalled()
  const file = join(f.root, 'history', f.key + '.json'), before = await readFile(file, 'utf8')
  await service.sync(f.item, 'session'); expect(await readFile(file, 'utf8')).toBe(before)
  // Assistant/tool events can advance while the list timestamp stays at 1.
  head = 5; await service.sync(f.item, 'session')
  expect(delta).toHaveBeenLastCalledWith(2, undefined); expect((await f.cache.read(f.key))?.records).toEqual(all)
  const restarted = new RemoteHistoryService(new RemoteHistoryCache(join(f.root, 'history')), source)
  await restarted.sync(f.item, 'session'); expect(delta).toHaveBeenLastCalledWith(5, undefined)
})
it('checkpoints forward batches and resumes only missing events after interruption and process restart', async () => {
  const f = await fixture(), all = f.rows(0, 1103); let fail = true
  const delta = vi.fn(async (after: number, cut?: number) => {
    if (fail && after === 499) throw new Error('connection lost')
    const end = Math.min(after + 500, cut ?? 1103)
    return { cursor: cut ?? 1103, throughSeq: end, records: all.slice(after + 1, end + 1) }
  })
  const source = async () => ({ gateway: {} as RemoteGateway, delta, check() {}, updatedAt: 1, title: 'Saved' })
  const first = new RemoteHistoryService(f.cache, source); await first.sync(f.item, 'session')
  expect((await f.cache.read(f.key))?.meta).toMatchObject({ complete: false, cursor: 499, records: 500 })
  expect(Object.keys((await first.status()).failures)).toEqual([f.key])
  fail = false; delta.mockClear()
  const cache = new RemoteHistoryCache(join(f.root, 'history')), restarted = new RemoteHistoryService(cache, source)
  await restarted.sync(f.item, 'session')
  expect(delta.mock.calls).toEqual([[499, undefined], [999, 1103]])
  expect((await cache.read(f.key))?.records).toEqual(all); expect((await cache.read(f.key))?.meta.complete).toBe(true)
})
it.each(['gap', 'rewind', 'empty', 'cut-change'])('preserves a complete disk copy on a %s response', async kind => {
  const f = await fixture(); await f.cache.save(f.meta, f.rows(0, 2), f.cache.token())
  const before = await readFile(join(f.root, 'history', f.key + '.json'), 'utf8')
  const delta = vi.fn(async () => kind === 'rewind' ? { cursor: 1, throughSeq: 1, records: [] }
    : kind === 'empty' ? { cursor: 5, throughSeq: 2, records: [] }
    : kind === 'cut-change' ? { cursor: 4, throughSeq: 5, records: f.rows(3, 5) }
    : { cursor: 5, throughSeq: 5, records: f.rows(4, 5) })
  const service = new RemoteHistoryService(f.cache, async () => ({ gateway: {} as RemoteGateway, delta, check() {}, updatedAt: 1, title: 'Saved' }))
  await service.sync(f.item, 'session'); expect(Object.keys((await service.status()).failures)).toEqual([f.key])
  expect(await readFile(join(f.root, 'history', f.key + '.json'), 'utf8')).toBe(before); expect(delta).toHaveBeenCalledOnce()
})
it('resumes suffix checkpoints made by earlier releases without deleting or redownloading the saved suffix', async () => {
  const f = await fixture(); await f.cache.save({ ...f.meta, cursor: 5, complete: false }, f.rows(3, 5), f.cache.token())
  const gateway = { historySnapshot: vi.fn(async () => ({ header: { id: 'session' }, cursor: 5, records: f.rows(3, 5), hasMore: true })),
    rpc: vi.fn(async () => ({ records: f.rows(0, 2), hasMore: false })) }
  const delta = vi.fn(async (after: number) => ({ cursor: after, throughSeq: after, records: [] }))
  const service = new RemoteHistoryService(f.cache, async () => ({ gateway: gateway as unknown as RemoteGateway, delta, check() {}, updatedAt: 1, title: 'Saved' }))
  await service.sync(f.item, 'session'); expect((await f.cache.read(f.key))?.records).toEqual([...f.rows(0, 2), ...f.rows(3, 5)])
  expect((await f.cache.read(f.key))?.meta.complete).toBe(true); expect(delta).toHaveBeenLastCalledWith(5, undefined); expect(gateway.historySnapshot).not.toHaveBeenCalled()
})
it('does not refill a cleared copy from an already dispatched background read', async () => {
  const f = await fixture(); let finish!: (value: unknown) => void
  const delta = vi.fn(() => new Promise<any>(resolve => { finish = resolve }))
  const service = new RemoteHistoryService(f.cache, async () => ({ gateway: {} as RemoteGateway, delta, check() {}, title: 'Saved', updatedAt: 1 }))
  const syncing = service.sync(f.item, 'session')
  for (let n = 0; n < 100 && !finish; n++) await new Promise(resolve => setTimeout(resolve, 1))
  await service.clear([f.key])
  finish({ cursor: 2, throughSeq: 2, records: f.rows(0, 2) }); await syncing
  expect(await f.cache.read(f.key)).toBeUndefined()
  expect((await service.status()).failures).toEqual({})
  await service.sync(f.item, 'session', false, 2)
  expect(delta).toHaveBeenCalledOnce()
})

it('bounds concurrent history reads and stops queued reads after local clearing', async () => {
  const f = await fixture(); const finishes: Array<() => void> = []; let active = 0, peak = 0
  const delta = vi.fn(async () => {
    active++; peak = Math.max(peak, active)
    await new Promise<void>(resolve => finishes.push(resolve)); active--
    return { cursor: 2, throughSeq: 2, records: f.rows(0, 2) }
  })
  const service = new RemoteHistoryService(f.cache, async () => ({ gateway: {} as RemoteGateway, delta, check() {}, updatedAt: 1, title: 'Saved' }))
  const jobs = Array.from({ length: 6 }, (_, n) => service.sync({ ...f.item, hostId:n%2?'other-host':f.item.hostId }, 'session-' + n))
  await vi.waitFor(() => expect(finishes).toHaveLength(2))
  await service.clear([historyKey(f.item.hostId, f.item.workspaceId, 'session-0')])
  finishes.forEach(finish => finish()); await Promise.all(jobs)
  expect(peak).toBe(2); expect(delta).toHaveBeenCalledTimes(2)
  expect((await service.status()).entries).toHaveLength(0)
})

it('recovers a data commit ahead of the index and checks only after its actual disk cursor', async () => {
  const f = await fixture(); await f.cache.save(f.meta, f.rows(0, 2), f.cache.token())
  const index = join(f.root, 'history/index.json'), stale = await readFile(index, 'utf8')
  await f.cache.save({ ...f.meta, cursor: 5 }, f.rows(0, 5), f.cache.token())
  await writeFile(index, stale)
  const cache = new RemoteHistoryCache(join(f.root, 'history'))
  const all = f.rows(0, 5), delta = vi.fn(async (after: number) => ({ cursor: 5, throughSeq: 5, records: all.slice(after + 1) }))
  const service = new RemoteHistoryService(cache, async () => ({ gateway: {} as RemoteGateway, delta, check() {}, title: f.meta.title, updatedAt: 1 }))
  await service.sync(f.item, 'session')
  expect(delta.mock.calls.map(x => x[0])).toEqual([2, 5])
  expect((await cache.meta(f.key))?.cursor).toBe(5); expect((await cache.read(f.key))?.records).toEqual(all)
  expect((await new RemoteHistoryCache(join(f.root, 'history')).meta(f.key))?.cursor).toBe(5)
  expect((await service.status()).failures).toEqual({})
})
it('refills a missing data file rather than treating its stale index as a complete disk copy', async () => {
  const f = await fixture(); await f.cache.save(f.meta, f.rows(0, 2), f.cache.token())
  await unlink(join(f.root, 'history', f.key + '.json'))
  const delta = vi.fn(async () => ({ cursor: 2, throughSeq: 2, records: f.rows(0, 2) }))
  const service = new RemoteHistoryService(f.cache, async () => ({ gateway: {} as RemoteGateway, delta, check() {}, title: f.meta.title, updatedAt: 1 }))
  await service.sync(f.item, 'session'); expect(delta).toHaveBeenCalledWith(-1, undefined)
  expect((await f.cache.read(f.key))?.records).toEqual(f.rows(0, 2))
})
