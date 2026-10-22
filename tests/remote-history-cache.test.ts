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
it('syncs full history once, merges later suffixes, and never fetches unchanged or unopened histories', async () => {
  const f = await fixture(); let updatedAt = 1
  const all = f.rows(0, 5)
  const gateway = { historySnapshot: vi.fn(async () => ({ header: { id: 'session' }, cursor: updatedAt === 1 ? 2 : 5,
    records: updatedAt === 1 ? all.slice(2, 3) : all.slice(2), hasMore: true })), rpc: vi.fn(async () => ({ records: all.slice(0, 2), hasMore: false })) }
  const source = vi.fn(async () => ({ gateway: gateway as unknown as RemoteGateway, check() {}, updatedAt, title: 'Saved' }))
  const service = new RemoteHistoryService(f.cache, source)
  await service.sync(f.item, 'never-opened', false, 10)
  expect(source).not.toHaveBeenCalled()
  await service.sync(f.item, 'session')
  expect((await f.cache.read(f.key))?.records).toEqual(all.slice(0, 3))
  expect(gateway.rpc).toHaveBeenCalledOnce()
  await service.sync(f.item, 'session', false, 1); await service.sync(f.item, 'session')
  expect(gateway.historySnapshot).toHaveBeenCalledOnce()
  updatedAt = 2; await service.sync(f.item, 'session')
  expect((await f.cache.read(f.key))?.records).toEqual(all)
  expect(gateway.rpc).toHaveBeenCalledOnce()
})
it('does not refill a cleared copy from an already dispatched background read', async () => {
  const f = await fixture(); let finish!: (value: unknown) => void
  const gateway = { historySnapshot: vi.fn(() => new Promise(resolve => { finish = resolve })) }
  const service = new RemoteHistoryService(f.cache, async () => ({ gateway: gateway as unknown as RemoteGateway, check() {}, title: 'Saved', updatedAt: 1 }))
  const syncing = service.sync(f.item, 'session')
  for (let n = 0; n < 100 && !finish; n++) await new Promise(resolve => setTimeout(resolve, 1))
  await service.clear([f.key])
  finish({ header: { id: 'session' }, cursor: 2, records: f.rows(0, 2), hasMore: false }); await syncing
  expect(await f.cache.read(f.key)).toBeUndefined()
  await service.sync(f.item, 'session', false, 2)
  expect(gateway.historySnapshot).toHaveBeenCalledOnce()
})
