import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, stat, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalDraftStore, DraftConflictError, type DraftWrite } from '../src/remote/draft-store.ts'

const fixtures: Array<{ root: string; stores: LocalDraftStore[] }> = []
const host = 'a'.repeat(24), other = 'b'.repeat(24)
const input = (text: string, revision: string | null = null): DraftWrite => ({ text, expectedRevision: revision, operationId: randomUUID(), hadReferences: false, hadAttachments: false })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-draft-test-')), stores: LocalDraftStore[] = []
  const open = () => { const value = new LocalDraftStore(root); stores.push(value); return value }
  fixtures.push({ root, stores }); return { root, open, store: open() }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const fixture of fixtures.splice(0)) {
    for (const store of fixture.stores) await store.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
it('persists exact text across reopen while equal session ids on different Hosts remain separate', async () => {
  const f = await fixture(), text = '未发送草稿\n生成夹具 🧪\n@remote/file'
  const first = await f.store.write(host, 'same', input(text))
  await f.store.write(other, 'same', input('Other host'))
  expect((await stat(f.root)).mode & 0o077).toBe(0)
  for (const name of (await readdir(f.root)).filter(name => name.endsWith('.json'))) expect((await stat(join(f.root, name))).mode & 0o077).toBe(0)
  await f.store.close()
  const reopened = f.open()
  expect(await reopened.read(host, 'same')).toEqual(first)
  expect((await reopened.read(other, 'same'))?.text).toBe('Other host')
})
it('fences stale writes after an explicit clear, including across restart', async () => {
  const f = await fixture(), oldWrite = input('old'), original = await f.store.write(host, 's', oldWrite)
  const cleared = await f.store.write(host, 's', input('', original.revision))
  await expect(f.store.write(host, 's', oldWrite)).rejects.toBeInstanceOf(DraftConflictError)
  await expect(f.store.write(host, 's', input('late old draft', original.revision))).rejects.toBeInstanceOf(DraftConflictError)
  await f.store.close(); const reopened = f.open()
  await expect(reopened.write(host, 's', input('stale origin', original.revision))).rejects.toBeInstanceOf(DraftConflictError)
  expect(await reopened.read(host, 's')).toEqual(cleared)
  expect((await reopened.write(host, 's', input('Explicit new edit', cleared.revision))).text).toBe('Explicit new edit')
})
it('owns queued input and rejects overlapping edits rather than overwriting a newer draft', async () => {
  const f = await fixture(), pending = input('first')
  const a = f.store.write(host, 's', pending), b = f.store.write(host, 's', input('second'))
  pending.text = 'caller changed later'
  await expect(b).rejects.toBeInstanceOf(DraftConflictError)
  const saved = await a
  expect(saved.text).toBe('first')
  expect(await f.store.write(host, 's', { ...input('first'), operationId: saved.operationId })).toEqual(saved)
  await expect(f.store.write(host, 's', { ...input('different'), operationId: saved.operationId })).rejects.toBeInstanceOf(DraftConflictError)
})
it('keeps reads available when another live writer owns writing, and permits writing after release', async () => {
  const f = await fixture(), first = await f.store.write(host, 's', input('one')), second = f.open()
  expect(await second.read(host, 's')).toEqual(first)
  await expect(second.write(host, 's', input('two', first.revision))).rejects.toThrow('Another draft writer')
  await f.store.close()
  expect((await second.write(host, 's', input('two', first.revision))).text).toBe('two')
})
it('recovers only a proven exited writer and refuses malformed saved data', async () => {
  const f = await fixture(); await f.store.read(host, 's')
  const child = spawn(process.execPath, ['-e', '']); await once(child, 'exit')
  await writeFile(join(f.root, 'writer.lock'), JSON.stringify({ pid: child.pid, owner: randomUUID() }), { mode: 0o600 })
  await f.store.write(host, 's', input('recovered'))
  const name = (await readdir(f.root)).find(name => name.endsWith('.json'))!
  await writeFile(join(f.root, name), '{damaged', { mode: 0o600 })
  await expect(f.store.read(host, 's')).rejects.toThrow()
  await expect(f.store.write(host, 's', input('must not replace damaged data'))).rejects.toThrow()
})
it('lets exactly one contender own a stale writer lock without replacing the winner', async () => {
  const f = await fixture(); await f.store.read(host, 's')
  const child = spawn(process.execPath, ['-e', '']); await once(child, 'exit')
  await writeFile(join(f.root, 'writer.lock'), JSON.stringify({ pid: child.pid, owner: randomUUID() }), { mode: 0o600 })
  const contenders = [f.store, f.open(), f.open()]
  const results = await Promise.allSettled(contenders.map((store, index) => store.write(host, 's', input('candidate ' + index))))
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const winner = results.findIndex(result => result.status === 'fulfilled')
  expect((await f.store.read(host, 's'))?.text).toBe('candidate ' + winner)
})
it('requires inspection of an interrupted recovery guard instead of stealing it', async () => {
  const f = await fixture(), saved = await f.store.write(host, 's', input('preserve'))
  await f.store.close(); const fresh = f.open()
  const child = spawn(process.execPath, ['-e', '']); await once(child, 'exit')
  const owner = JSON.stringify({ pid: child.pid, owner: randomUUID() })
  for (const name of ['writer.lock', 'recovery.lock']) await writeFile(join(f.root, name), owner, { mode: 0o600 })
  await expect(fresh.write(host, 's', input('must not steal', saved.revision))).rejects.toThrow('needs inspection')
  expect(await fresh.read(host, 's')).toEqual(saved)
})
it('stops writes after a published rename with unconfirmed directory fsync and recovers on reopen', async () => {
  const f = await fixture(), first = await f.store.write(host, 's', input('before'))
  const fault = vi.spyOn(f.store as any, 'syncDirectory').mockRejectedValue(new Error('Injected directory EIO'))
  await expect(f.store.write(host, 's', input('published', first.revision))).rejects.toThrow('Injected')
  expect(f.store.writeIssue).toContain('could not be confirmed')
  const published = await f.store.read(host, 's')
  expect(published?.text).toBe('published')
  fault.mockRestore()
  await expect(f.store.write(host, 's', input('cannot follow', published!.revision))).rejects.toThrow('could not be confirmed')
  await f.store.close(); const reopened = f.open()
  expect((await reopened.write(host, 's', input('after reopen', published!.revision))).text).toBe('after reopen')
})
