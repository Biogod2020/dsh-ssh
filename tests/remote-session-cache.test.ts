import { afterEach, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RemoteSessionCache } from '../src/remote/session-catalog.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const id = 'a'.repeat(24), entry = { workspaceId: 'remote-project', stale: false, checkedAt: 123,
  sessions: [{ sessionId: 'original', title: 'Private title', running: true, blank: false, updatedAt: 100 }] }
function fixture() { const root = mkdtempSync(join(tmpdir(), 'ssh-session-cache-')); roots.push(root); return join(root, 'catalog.json') }
it('persists private navigation metadata and restores it as unconfirmed without changing session identity', () => {
  const path = fixture(), cache = new RemoteSessionCache(path)
  cache.save(id, entry)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  const next = new RemoteSessionCache(path)
  expect(next.get(id, entry.workspaceId)).toEqual({ ...entry, stale: true })
  const copy = next.get(id, entry.workspaceId); copy.sessions[0]!.title = 'changed'
  expect(next.get(id, entry.workspaceId).sessions[0]!.title).toBe('Private title')
  expect(next.get(id, 'different-project').sessions).toEqual([])
})
it.each(['malformed', 'public', 'symlink', 'dangling'] as const)('preserves an unsafe %s cache and never overwrites its source', kind => {
  const path = fixture(), target = path + '.target'
  if (kind === 'symlink' || kind === 'dangling') {
    if (kind === 'symlink') writeFileSync(target, 'original', { mode: 0o600 })
    symlinkSync(target, path)
  } else { writeFileSync(path, kind === 'malformed' ? '{bad' : JSON.stringify({ version: 1, entries: { [id]: entry } }), { mode: 0o600 }); if (kind === 'public') chmodSync(path, 0o644) }
  const before = kind === 'dangling' ? undefined : readFileSync(path, 'utf8')
  const cache = new RemoteSessionCache(path)
  expect(cache.get(id, entry.workspaceId).warning).toContain('preserved')
  cache.save(id, entry)
  if (before !== undefined) expect(readFileSync(path, 'utf8')).toBe(before)
})
