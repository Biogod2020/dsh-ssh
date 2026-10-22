import { afterEach, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteActivityStore } from '../src/remote/activity-store.ts'
import { RemoteWorkspaces } from '../src/remote/manager.ts'
import type { SshEngine } from '../src/engine.ts'
import type { RemoteOperation } from '../src/remote/types.ts'

const roots: string[] = []
const managers: RemoteWorkspaces[] = []
afterEach(async () => {
  const owned = managers.splice(0)
  owned.forEach(x => x.dispose()); vi.restoreAllMocks()
  // Initialization may still create the cache directory even when this
  // receipt-only fixture never reads history. Settle it before removing root.
  await Promise.all(owned.map(x => x.historyCopies()))
  roots.splice(0).forEach(x => rmSync(x, { recursive: true, force: true }))
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-activity-test-')); roots.push(root); chmodSync(root, 0o700)
  const store = new RemoteActivityStore(root)
  const operation: RemoteOperation = { id: 'setup', alias: 'fixture', hostId: 'a'.repeat(24), remotePath: '/remote/project',
    phase: 'installing-dsh', message: 'Installing', createdAt: 1000, updatedAt: 2000 }
  const acquire = vi.fn()
  const engine = { find: vi.fn(() => ({ host: '127.0.0.1', port: 2222, user: 'fixture', updatedAt: 1 })),
    startWorkspaceTunnel: vi.fn(), stopWorkspaceTunnel: vi.fn(), pool: { get: acquire } } as unknown as SshEngine
  const manager = () => {
    const value = new RemoteWorkspaces(engine, { root, installer: 'must not dispatch', bootstrap: 'must not dispatch', returnUrl: () => 'http://127.0.0.1/' })
    managers.push(value); return value
  }
  return { root, store, operation, engine, acquire, manager, path: join(root, 'activity.json') }
}

it('persists only public fields in an atomic private receipt, retaining the previous file on failed replacement', () => {
  const f = fixture()
  const workspace = { id: 'workspace', hostId: f.operation.hostId!, alias: 'fixture', remotePath: '/remote/project', title: 'project', workspaceId: 'native' }
  f.store.save([{ operation: { ...f.operation, phase: 'ready', workspace, receipt: { url: 'http://127.0.0.1/?token=private' },
    auth: 'private', cookie: 'private' } as RemoteOperation, dismissed: true }])
  expect(statSync(f.path).mode & 0o777).toBe(0o600)
  expect(statSync(f.root).mode & 0o777).toBe(0o700)
  expect(new RemoteActivityStore(f.root).load()).toEqual([{ operation: { ...f.operation, phase: 'ready', workspace }, dismissed: true }])
  expect(readFileSync(f.path, 'utf8')).not.toContain('private')
  const previous = readFileSync(f.path, 'utf8')
  expect(() => f.store.save([{ operation: { ...f.operation, updatedAt: 1 } }])).toThrow('Invalid')
  expect(readFileSync(f.path, 'utf8')).toBe(previous)
  // Force rename failure without mocking filesystem behavior; our temporary file is cleaned.
  const other = fixture(); mkdirSync(other.path)
  expect(() => other.store.save([{ operation: other.operation }])).toThrow()
  expect(readdirSync(other.root)).toEqual(['activity.json'])
})

it.each(['symlink', 'dangling', 'permissive', 'corrupt', 'duplicate', 'oversized', 'date', 'ready-without-workspace'])('rejects %s history without rewriting it', kind => {
  const f = fixture(), body = { version: 1, entries: [{ operation: f.operation }] }
  if (kind === 'symlink' || kind === 'dangling') {
    const target = join(f.root, 'other.json')
    if (kind === 'symlink') writeFileSync(target, JSON.stringify(body), { mode: 0o600 })
    symlinkSync(target, f.path)
  } else {
    if (kind === 'duplicate') body.entries.push(body.entries[0]!)
    if (kind === 'date') body.entries[0]!.operation.updatedAt = Number.MAX_SAFE_INTEGER
    if (kind === 'ready-without-workspace') body.entries[0]!.operation.phase = 'ready'
    writeFileSync(f.path, kind === 'corrupt' ? '{broken' : kind === 'oversized' ? 'x'.repeat(8 * 1024 * 1024 + 1) : JSON.stringify(body), { mode: 0o600 })
    if (kind === 'permissive') chmodSync(f.path, 0o644)
  }
  const original = kind === 'dangling' ? undefined : readFileSync(f.path, 'utf8')
  expect(() => f.store.load()).toThrow()
  if (original !== undefined) expect(readFileSync(f.path, 'utf8')).toBe(original)
  expect(readdirSync(f.root).some(x => x.endsWith('.tmp'))).toBe(false)
})

it('recovers interrupted work as unconfirmed exactly once, persists dismissal and never acquires SSH', async () => {
  const f = fixture(); f.store.save([{ operation: f.operation }])
  const first = f.manager(), receipt = first.operation('setup')!
  expect(receipt).toMatchObject({ phase: 'failed', errorCode: 'ssh/setup-interrupted', lastPhase: 'installing-dsh' })
  expect(receipt.updatedAt).toBeGreaterThan(2000)
  expect(receipt.message).toContain('may still be running')
  expect(first.activity()).toHaveLength(1); first.dismiss('setup')
  const second = f.manager()
  expect(second.operation('setup')).toEqual(receipt)
  expect(second.activity()).toEqual([])
  expect(second.history()).toEqual([{ ...receipt, dismissed: true }])
  await second.repairConnections(); await second.status()
  expect(f.engine.find).not.toHaveBeenCalled()
  expect(f.acquire).not.toHaveBeenCalled()
  expect(f.engine.startWorkspaceTunnel).not.toHaveBeenCalled()
})

it('blocks setup on corrupt history, preserves its source and exposes a public warning without private paths', () => {
  const f = fixture(); writeFileSync(f.path, '{broken', { mode: 0o600 })
  const manager = f.manager()
  expect(manager.activityWarning()).toContain('No new setup')
  expect(manager.activityWarning()).not.toContain(f.root)
  expect(() => manager.connect('fixture', '/remote/project')).toThrow('No new setup')
  expect(readFileSync(f.path, 'utf8')).toBe('{broken')
  expect(f.engine.find).not.toHaveBeenCalled()
  expect(f.acquire).not.toHaveBeenCalled()
})

it('does not acknowledge or dispatch a new operation when its initial durable write fails', () => {
  const f = fixture(), manager = f.manager()
  vi.spyOn(RemoteActivityStore.prototype, 'save').mockImplementation(() => { throw new Error('disk full') })
  expect(() => manager.connect('fixture', '/remote/project')).toThrow('could not be saved')
  expect(manager.history()).toEqual([])
  expect(existsSync(f.path)).toBe(false)
  expect(f.acquire).not.toHaveBeenCalled()
  expect(f.engine.startWorkspaceTunnel).not.toHaveBeenCalled()
})

it('refuses a saved workspace owner that differs from the currently configured alias before any dispatch', () => {
  const f = fixture(), manager = f.manager()
  try { manager.connect('fixture', '/remote/project', f.operation.hostId) } catch (error) {
    expect(error).toMatchObject({ errorCode: 'ssh/host-changed' })
  }
  expect(manager.history()).toEqual([])
  expect(existsSync(f.path)).toBe(false)
  expect(f.acquire).not.toHaveBeenCalled()
})
