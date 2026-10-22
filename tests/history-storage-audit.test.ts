import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { auditHistoryFiles } from '../src/remote/history-storage-audit.ts'
import { SegmentedHistoryCache, historyKey } from '../src/remote/history-store.ts'
import { RemoteHistoryCache } from '../src/remote/history-cache.ts'

const roots: string[] = [], stores: SegmentedHistoryCache[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function directory() { const path = await mkdtemp(join(tmpdir(), 'dsh-history-inventory-')); roots.push(path); return path }
async function fixture() {
  const root = await directory(), store = new SegmentedHistoryCache(root); stores.push(store); await store.audit()
  const key = historyKey('host', 'project', 'session'), records = [{ type: 'event' as const, event: { seq: 0, type: 'user/message', data: { content: 'Generated original history' } } }]
  const meta = { key, hostId: 'host', workspaceId: 'project', sessionId: 'session', alias: 'fixture', remotePath: '/generated', title: 'Generated', savedAt: Date.now(), remoteUpdatedAt: 1, cursor: 0, complete: true }
  await store.save(meta, records, store.token(key))
  const manifest = JSON.parse(await readFile(join(root, 'v2', key, 'manifest.json'), 'utf8'))
  return { root, store, key, records, meta, generation: join(root, 'v2', key, manifest.generation), manifest }
}
it('counts private file sizes without needing to read their contents or changing files', async () => {
  const root = await directory(), file = join(root, 'uncommitted.tmp')
  await writeFile(file, 'Generated unreadable text', { mode: 0o200 })
  const before = await lstat(file), report = await auditHistoryFiles(root, new Map())
  expect(report.fileBytes).toBe(before.size); expect(report.unreferencedBytes).toBe(before.size)
  expect(report.files).toBe(1); expect(report.incomplete).toBe(false)
  expect((await lstat(file)).mtimeMs).toBe(before.mtimeMs)
  await chmod(file, 0o600); expect(await readFile(file, 'utf8')).toBe('Generated unreadable text')
})
it('does not follow symlinks or scan publicly accessible directories and reports an incomplete inventory', async () => {
  const root = await directory(), outside = await directory()
  await writeFile(join(outside, 'private-generated-file'), 'Never inspect this outside file', { mode: 0o600 })
  await symlink(outside, join(root, 'outside-link'))
  await mkdir(join(root, 'public'), { mode: 0o755 }); await chmod(join(root, 'public'), 0o755)
  await writeFile(join(root, 'public', 'skip'), 'Not part of the private scan')
  const report = await auditHistoryFiles(root, new Map())
  expect(report.fileBytes).toBe(0); expect(report.skipped).toBe(2); expect(report.incomplete).toBe(true)
  expect(JSON.stringify(report)).not.toContain('private-generated-file'); expect(JSON.stringify(report)).not.toContain(outside)
})
it('accounts for uncommitted segments and index tails without treating them as saved history', async () => {
  const f = await fixture(), orphan = join(f.generation, randomUUID() + '.json')
  await writeFile(orphan, 'uncommitted', { mode: 0o600 }); await appendFile(join(f.generation, 'segments.jsonl'), 'abandoned\n')
  const files = await readdir(f.root, { recursive: true })
  let total = 0
  for (const name of files) { const info = await lstat(join(f.root, name)); if (info.isFile()) total += info.size }
  const audit = await f.store.audit(), summary = await f.store.list()
  expect(audit.fileBytes).toBe(total)
  expect(audit.unreferencedBytes).toBe(Buffer.byteLength('uncommittedabandoned\n'))
  expect(audit.byKey[f.key]!.unreferencedBytes).toBe(audit.unreferencedBytes)
  expect(audit.stale).toBe(false); expect(audit.incomplete).toBe(false)
  expect(summary.reasons).toContain('unreferenced'); expect(summary.reminder).toBe(true)
  expect(summary.storage).not.toHaveProperty('byKey')
  expect((await f.store.read(f.key))!.records).toEqual(f.records)
  expect(await readFile(orphan, 'utf8')).toBe('uncommitted')
})
it('reuses the snapshot on ordinary status/window/unchanged preparation and marks real changes stale', async () => {
  const f = await fixture(); await f.store.audit()
  const scan = vi.spyOn(f.store, 'audit')
  for (let n = 0; n < 5; n++) { await f.store.list(); await f.store.window(f.key); await f.store.prepare(f.key, f.store.token(f.key)) }
  expect(scan).not.toHaveBeenCalled(); expect((await f.store.list()).storage?.stale).toBe(false)
  await f.store.append({ ...f.meta, cursor: 1 }, [{ type: 'event', event: { seq: 1, type: 'assistant/message' } }], f.store.token(f.key))
  expect((await f.store.list()).storage?.stale).toBe(true)
  expect((await f.store.audit()).stale).toBe(false)
})
it('coalesces inventories without making a foreground append wait for the scan', async () => {
  const f = await fixture(); await f.store.audit()
  const first = f.store.audit(), second = f.store.audit()
  expect(first).toBe(second)
  await f.store.append({ ...f.meta, cursor: 1 }, [{ type: 'event', event: { seq: 1, type: 'assistant/message' } }], f.store.token(f.key))
  const report = await first
  expect(report.stale).toBe(true)
  expect((await f.store.read(f.key))!.records).toHaveLength(2)
})
it('only removes interrupted files when their selected copy is explicitly cleared and retains the clear barrier', async () => {
  const f = await fixture(), other = historyKey('other', 'project', 'session')
  await f.store.save({ ...f.meta, key: other, hostId: 'other' }, f.records, f.store.token(other))
  await writeFile(join(f.generation, randomUUID() + '.json'), 'uncommitted', { mode: 0o600 })
  const before = await f.store.audit(), token = f.store.token(f.key)
  expect(before.byKey[f.key]!.unreferencedBytes).toBeGreaterThan(0)
  await f.store.clear([f.key]); const after = await f.store.audit()
  expect(after.byKey[f.key]).toBeUndefined(); expect(after.byKey[other]!.fileBytes).toBeGreaterThan(0)
  expect((await f.store.read(other))!.records).toEqual(f.records)
  await f.store.resume(f.key)
  expect(await f.store.save(f.meta, f.records, token)).toBe(false)
  expect(await f.store.read(f.key)).toBeUndefined()
})
it('reminds about retained interrupted files without expiring them, including after restart and snooze', async () => {
  const f = await fixture(), orphan = join(f.generation, randomUUID() + '.json')
  await writeFile(orphan, 'keep this file', { mode: 0o600 }); await f.store.close()
  const reopened = new SegmentedHistoryCache(f.root); stores.push(reopened); await reopened.audit()
  expect((await reopened.list()).reminder).toBe(true)
  await reopened.snooze(); await reopened.audit()
  expect((await reopened.list()).reminder).toBe(false)
  const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 8 * 86400000)
  expect((await reopened.list()).reminder).toBe(true)
  expect(await readFile(orphan, 'utf8')).toBe('keep this file')
  expect((await reopened.read(f.key))!.records).toEqual(f.records)
})
it('finishes a reviewed interrupted clear without enabling its old writers', async () => {
  const f = await fixture(), remove = vi.spyOn(f.store as any, 'remove').mockRejectedValueOnce(new Error('Injected interrupted deletion'))
  await expect(f.store.clear([f.key])).rejects.toThrow('Injected')
  remove.mockRestore()
  const audit = await f.store.audit(), generation = audit.byKey[f.key]!.clearedGeneration!
  expect(Number.isSafeInteger(generation)).toBe(true)
  const token = f.store.token(f.key)
  await f.store.finishClear([{ key: f.key, generation }])
  expect((await f.store.audit()).byKey[f.key]).toBeUndefined()
  expect(await f.store.save(f.meta, f.records, token)).toBe(false)
  expect(await f.store.read(f.key)).toBeUndefined()
})
it('rejects the whole old cleanup selection when a copy was reopened and preserves its new history', async () => {
  const f = await fixture(), remove = vi.spyOn(f.store as any, 'remove').mockRejectedValueOnce(new Error('Injected interrupted deletion'))
  await expect(f.store.clear([f.key])).rejects.toThrow('Injected'); remove.mockRestore()
  const generation = (await f.store.audit()).byKey[f.key]!.clearedGeneration!
  await f.store.resume(f.key); await f.store.save(f.meta, f.records, f.store.token(f.key))
  const before = (await f.store.audit()).byKey[f.key]!.fileBytes
  await expect(f.store.finishClear([{ key: f.key, generation }])).rejects.toThrow('selection changed')
  expect((await f.store.read(f.key))!.records).toEqual(f.records)
  expect((await f.store.audit()).byKey[f.key]!.fileBytes).toBe(before)
})
it('owns a normal clear selection before waiting, so caller changes cannot clear another Host', async () => {
  const f = await fixture(), other = historyKey('other', 'project', 'session')
  await f.store.save({ ...f.meta, key: other, hostId: 'other' }, f.records, f.store.token(other))
  const otherToken = f.store.token(other), selection = [f.key]
  const clearing = f.store.clear(selection); selection[0] = other
  await clearing
  expect(await f.store.read(f.key)).toBeUndefined()
  expect((await f.store.read(other))!.records).toEqual(f.records)
  expect(f.store.current(otherToken)).toBe(true)
})
it('owns the reviewed cleanup identity before queueing and does not follow a changed caller object', async () => {
  const f = await fixture(), other = historyKey('other', 'project', 'session')
  await f.store.save({ ...f.meta, key: other, hostId: 'other' }, f.records, f.store.token(other))
  const remove = vi.spyOn(f.store as any, 'remove').mockRejectedValueOnce(new Error('Injected interrupted deletion'))
  await expect(f.store.clear([f.key, other])).rejects.toThrow('Injected'); remove.mockRestore()
  const before = await f.store.audit(), selection = [{ key: f.key, generation: before.byKey[f.key]!.clearedGeneration! }]
  const clearing = f.store.finishClear(selection); selection[0]!.key = other; selection[0]!.generation = before.byKey[other]!.clearedGeneration!
  await clearing
  const after = await f.store.audit()
  expect(after.byKey[f.key]).toBeUndefined(); expect(after.byKey[other]!.fileBytes).toBeGreaterThan(0)
})
it('marks a late legacy archival change even if its source appeared after the preparation probe', async () => {
  const f = await fixture(); await f.store.close()
  // A separate generated identity exercises the legacy path, not the already
  // committed v2 fixture above. Its original archive remains byte-for-byte.
  const key = historyKey('legacy', 'project', 'session'), legacy = new RemoteHistoryCache(f.root)
  await legacy.list(); await legacy.save({ ...f.meta, key, hostId: 'legacy' }, f.records, legacy.token())
  const store = new SegmentedHistoryCache(f.root); stores.push(store)
  await store.prepare(key, store.token(key)); await store.audit()
  const source = join(f.root, key + '.json'), archive = join(f.root, 'v2', key, 'legacy.v1.json'), original = await readFile(archive)
  const exists = (store as any).exists.bind(store); let probes = 0
  vi.spyOn(store as any, 'exists').mockImplementation(async (...args: unknown[]) => {
    if (args[0] === source && ++probes === 1) { await writeFile(source, original, { mode: 0o600 }); return false }
    return exists(...args)
  })
  await store.prepare(key, store.token(key))
  expect((await store.list()).storage?.stale).toBe(true)
  expect(await readFile(archive)).toEqual(original)
  await expect(lstat(source)).rejects.toHaveProperty('code', 'ENOENT')
  expect((await store.read(key))!.records).toEqual(f.records)
})
