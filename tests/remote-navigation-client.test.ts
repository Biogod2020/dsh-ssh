// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { navigationClient, navigationManifest } from '../src/remote/navigation-client.ts'
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear() })

it('adds a page-local boot contribution without changing original manifest rows', () => {
  const original = { entries: [{ id: 'native', url: '/native.js', rev: 'one' }], batches: [{ phase: 'application', url: '/native.js', rev: 'one', entries: ['native'] }] }
  vi.stubGlobal('__DSH_BOOT__', original)
  navigationManifest(); navigationManifest()
  const result = (window as any).__DSH_BOOT__
  expect(original.entries).toHaveLength(1); expect(original.batches).toHaveLength(1)
  expect(result.entries).toHaveLength(2); expect(result.batches).toHaveLength(2)
})

it('retains only three visited Session clients, reuses them, and releases archives, expiry and page ownership', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100000)
  let registration: any, current = 'one'
  const archivedSessionIds: string[] = [], cleanup: Array<() => void> = [], references = new Map<string, { release: ReturnType<typeof vi.fn> }>()
  vi.stubGlobal('__ModuleLoader__', { load: (value: unknown) => { registration = value } })
  navigationClient()
  const retain = vi.fn((id: string) => { const reference = { release: vi.fn() }; references.set(id, reference); return reference })
  const ctx: any = { uiWorkspace: { openSession: vi.fn((id: string) => { current = id }) },
    sessions: { retain, list: { getSnapshot: () => ({ byId: { [current]: { id: current, retainedBy: { mainView: 1 } } } }) } },
    workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'project', sessionIds: ['one', 'two', 'three', 'four', 'unvisited'] }], archivedSessionIds }) } },
    effect: (fn: () => () => void) => cleanup.push(fn()) }
  ctx.root = { inject: (_deps: string[], apply: (ctx: unknown) => void) => { apply(ctx); return { dispose: () => cleanup.forEach(fn => fn()) } } }
  registration.factory().apply(ctx)
  try {
    const bridge = (window as any).__dshSshView
    bridge.select('project', 'two'); bridge.select('project', 'one'); bridge.select('project', 'two')
    expect(retain.mock.calls.map(x => x[0])).toEqual(['one', 'two'])
    bridge.select('project', 'three'); bridge.select('project', 'four')
    expect(references.get('one')!.release).toHaveBeenCalledOnce()
    expect(references.get('two')!.release).not.toHaveBeenCalled()
    archivedSessionIds.push('two')
    await vi.advanceTimersByTimeAsync(30000)
    expect(references.get('two')!.release).toHaveBeenCalledOnce()
    expect(retain.mock.calls.some(x => x[0] === 'unvisited')).toBe(false)
    await vi.advanceTimersByTimeAsync(270000)
    expect(references.get('three')!.release).toHaveBeenCalledOnce()
    expect(references.get('four')!.release).toHaveBeenCalledOnce()
    bridge.select('project', 'three')
  } finally { cleanup.forEach(fn => fn()); delete (window as any).__dshSshNavigationOwner }
  for (const reference of references.values()) expect(reference.release).toHaveBeenCalledOnce()
})

it('selects through the remote public UI service without creating, submitting or reloading a Session', () => {
  let registration: any
  vi.stubGlobal('__ModuleLoader__', { load: (value: unknown) => { registration = value } })
  navigationClient()
  const openSession = vi.fn(), dispose: Array<() => void> = []
  const ctx: any = { uiWorkspace: { openSession }, sessions: { list: { getSnapshot: () => ({ byId: { one: { id: 'one', retainedBy: { mainView: 1 } } } }) } },
    workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'project', sessionIds: ['one'] }] }) } }, effect: (fn: () => () => void) => dispose.push(fn()) }
  ctx.root = { inject: (_deps: string[], apply: (ctx: unknown) => void) => { apply(ctx); return { dispose: () => dispose.forEach(fn => fn()) } } }
  registration.factory().apply(ctx)
  const bridge = (window as any).__dshSshView
  expect(bridge.state()).toEqual({ sessionId: 'one', workspaceId: 'project' })
  bridge.open('two'); expect(openSession).toHaveBeenCalledExactlyOnceWith('two')
  expect(() => bridge.open('bad\nidentity')).toThrow('Invalid remote Session')
  openSession.mockClear()
  expect(bridge.select('project', 'one')).toBe(true)
  expect(openSession).toHaveBeenCalledExactlyOnceWith('one')
  expect(bridge.select('different-project', 'one')).toBe(false)
  expect(bridge.select('project', 'unknown')).toBe(false)
  expect(bridge.select('project', 'bad\nidentity')).toBe(false)
  ctx.workspaces.list.getSnapshot = () => ({ items: [{ workspaceId: 'project', sessionIds: ['one'] }], archivedSessionIds: ['one'] })
  expect(bridge.select('project', 'one')).toBe(false)
  expect(openSession).toHaveBeenCalledOnce()
  dispose.forEach(fn => fn()); expect((window as any).__dshSshView).toBeUndefined()
  delete (window as any).__dshSshNavigationOwner
})
