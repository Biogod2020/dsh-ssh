// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { navigationClient, navigationManifest } from '../src/remote/navigation-client.ts'
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

it('adds a page-local boot contribution without changing original manifest rows', () => {
  const original = { entries: [{ id: 'native', url: '/native.js', rev: 'one' }], batches: [{ phase: 'application', url: '/native.js', rev: 'one', entries: ['native'] }] }
  vi.stubGlobal('__DSH_BOOT__', original)
  navigationManifest(); navigationManifest()
  const result = (window as any).__DSH_BOOT__
  expect(original.entries).toHaveLength(1); expect(original.batches).toHaveLength(1)
  expect(result.entries).toHaveLength(2); expect(result.batches).toHaveLength(2)
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
  dispose.forEach(fn => fn()); expect((window as any).__dshSshView).toBeUndefined()
  delete (window as any).__dshSshNavigationOwner
})
