// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { installShortcutTargetRouter, mountRemoteShortcutRouting } from '../src/client/shortcut-routing.ts'
import { NativeSessionAdapter } from '../src/client/native-session-adapter.tsx'
import { remoteNavigation } from '../src/client/remote-navigation.ts'
import { registerRemotePresentation, remotePresentation, remoteSelection, selectRemoteView } from '../src/client/remote-presentation.ts'
import { nativeShortcuts } from './helpers/native-shortcuts.ts'

let sdk: any
beforeAll(() => { sdk = nativeShortcuts() })
afterEach(() => { remoteNavigation.clear(); selectRemoteView(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })
const context = { source: 'keyboard', region: 'page', modal: null, target: null }
const workspace = { id: 'project-a', hostId: 'a'.repeat(24), workspaceId: 'native-project', alias: 'Host A', title: 'Project', remotePath: '/project' }
function fixture(runtime = 'web') {
  vi.stubGlobal('__DSH_BOOT__', { release: { version: '0.2.1-rc.3' } }); vi.stubGlobal('navigator', { onLine: true })
  const registry = new sdk.ShortcutRegistry(runtime, 'macos'), locals = { new: vi.fn(), rename: vi.fn(), fork: vi.fn(async () => {}), archive: vi.fn() }
  const service = { registry, catalog: registry.catalog }
  sdk.install({ locale: { bind: () => (key: string) => key }, effect: (fn: () => void) => fn(), shortcuts: { register: (value: unknown) => registry.register(value) },
    slots: { entries: () => [{}] }, sessions: { list: { getSnapshot: () => ({ byId: { local: { id: 'local', title: 'Local', blank: false, retainedBy: { mainView: 1 } } } }) } },
    layout: { panelInfo: { getSnapshot: () => ({ activePanelId: null }) } },
  }, { startSession: locals.new, forkSession: locals.fork }, { state: { getSnapshot: () => ({}) }, search: vi.fn(), add: vi.fn(), rename: locals.rename }, locals.archive, vi.fn())
  const adapter = new NativeSessionAdapter(), rename = vi.spyOn(adapter, 'requestRename').mockImplementation(() => {}), fork = vi.spyOn(adapter, 'fork').mockResolvedValue(), archive = vi.spyOn(adapter, 'archive').mockResolvedValue()
  const opened = vi.fn(), unbind = remoteNavigation.bind(opened)
  remoteNavigation.update([workspace], [{ hostId: workspace.hostId, phase: 'ready' }])
  const originals = new Map([...registry.commands].map(([id, cmd]: any) => [id, cmd.resolve]))
  const routing = mountRemoteShortcutRouting({ get: () => service } as any, adapter)
  const key = (id: string, repeat = false) => {
    const binding = registry.catalog.getSnapshot().find((row: any) => row.id === id).binding
    return { code: binding.code, meta: binding.modifiers.includes('meta'), control: binding.modifiers.includes('control'), alt: binding.modifiers.includes('alt'), shift: binding.modifiers.includes('shift'), repeat, composing: false, defaultPrevented: false }
  }
  return { registry, service, originals, locals, adapter, rename, fork, archive, opened, routing, key, dispose: () => { routing.dispose(); unbind() } }
}

it.each(['web', 'desktop'])('routes all four native %s keyboard commands to the remote target and preserves local commands', async runtime => {
  const f = fixture(runtime)
  try {
    expect(f.routing.supported).toBe(true)
    for (const id of ['session.new', 'session.rename', 'session.fork', 'session.archive']) f.registry.invoke(id, context)
    Object.values(f.locals).forEach(fn => expect(fn).toHaveBeenCalledOnce())
    selectRemoteView({ workspaceId: workspace.id, sessionId: 'saved' })
    for (const id of ['session.new', 'session.rename', 'session.fork', 'session.archive']) expect(f.registry.dispatch(f.key(id), context, vi.fn()).status).toBe('handled')
    await Promise.resolve()
    expect(f.opened).toHaveBeenCalledExactlyOnceWith(workspace, undefined, true)
    expect(f.rename).toHaveBeenCalledOnce(); expect(f.fork).toHaveBeenCalledOnce(); expect(f.archive).toHaveBeenCalledOnce()
    Object.values(f.locals).forEach(fn => expect(fn).toHaveBeenCalledOnce())
    f.routing.dispose()
    for (const [id, original] of f.originals) expect(f.registry.commands.get(id).resolve).toBe(original)
  } finally { f.dispose() }
})

it('covers the actual Desktop native menu bridge, not just DOM keydown', async () => {
  const f = fixture('desktop'); let input!: (value: any) => void
  const off = sdk.installNativeKeyboard(window, { subscribe: (fn: typeof input) => { input = fn; return vi.fn() } }, f.registry, () => f.registry.config.getSnapshot())
  try {
    selectRemoteView({ workspaceId: workspace.id, sessionId: 'saved' })
    for (const commandId of ['session.new', 'session.rename', 'session.fork', 'session.archive']) input({ kind: 'menu', revision: f.registry.config.getSnapshot().revision, commandId })
    await Promise.resolve()
    expect(f.opened).toHaveBeenCalledOnce(); expect(f.rename).toHaveBeenCalledOnce(); expect(f.fork).toHaveBeenCalledOnce(); expect(f.archive).toHaveBeenCalledOnce()
    input({ kind: 'keyboard', revision: f.registry.config.getSnapshot().revision, ...f.key('session.archive') })
    await Promise.resolve(); expect(f.archive).toHaveBeenCalledTimes(2)
    Object.values(f.locals).forEach(fn => expect(fn).not.toHaveBeenCalled())
  } finally { off(); f.dispose() }
})

it('blocks offline/modal input and ignores repeats or a changed target without falling back to local actions', async () => {
  const f = fixture('desktop')
  try {
    selectRemoteView({ workspaceId: workspace.id, sessionId: 'saved' })
    vi.stubGlobal('navigator', { onLine: false })
    expect(f.registry.commands.get('session.archive').resolve(context).status).toBe('blocked')
    vi.stubGlobal('navigator', { onLine: true })
    expect(f.registry.commands.get('session.archive').resolve({ ...context, modal: 'rename' }).status).toBe('blocked')
    f.registry.dispatch(f.key('session.archive', true), context, vi.fn())
    const captured = f.registry.commands.get('session.archive').resolve(context)
    selectRemoteView(); captured.run(); await Promise.resolve()
    expect(f.archive).not.toHaveBeenCalled(); Object.values(f.locals).forEach(fn => expect(fn).not.toHaveBeenCalled())
  } finally { f.dispose() }
})

it('rejects unknown versions or changed functions without partially modifying native commands', () => {
  const f = fixture(); f.routing.dispose()
  try {
    expect(installShortcutTargetRouter(f.service, 'future', () => undefined).supported).toBe(false)
    f.registry.commands.get('session.archive').resolve = () => ({ status: 'pass' })
    expect(installShortcutTargetRouter(f.service, '0.2.1-rc.3', () => undefined).supported).toBe(false)
    for (const id of ['session.new', 'session.rename', 'session.fork']) expect(f.registry.commands.get(id).resolve).toBe(f.originals.get(id))
  } finally { f.dispose() }
})

it('suspends the embedded view synchronously when commands are re-registered, without overwriting the new owner', () => {
  const f = fixture(), suspend = vi.fn()
  const unregister = registerRemotePresentation({ resume: () => false, open: async () => {}, suspend })
  try {
    selectRemoteView({ workspaceId: workspace.id, sessionId: 'saved' })
    const old = f.registry.commands.get('session.archive'), replacement = { ...old, resolve: vi.fn(() => ({ status: 'pass' })) }
    f.registry.commands.set('session.archive', replacement); f.registry.refreshLabels()
    expect(suspend).toHaveBeenCalledOnce(); expect(remoteSelection()).toBeUndefined(); expect(f.routing.supported).toBe(false)
    expect(f.registry.commands.get('session.archive')).toBe(replacement)
    f.routing.dispose(); expect(replacement.resolve).not.toHaveBeenCalled()
  } finally { unregister(); f.dispose() }
})

it('leaves an outer wrapper intact while making a captured inner wrapper inert after disposal', () => {
  const f = fixture(), cmd = f.registry.commands.get('session.new'), wrapped = cmd.resolve
  const outer = vi.fn((ctx: any) => wrapped.call(cmd, ctx)); cmd.resolve = outer
  try {
    f.routing.dispose(); selectRemoteView({ workspaceId: workspace.id, sessionId: 'saved' })
    cmd.resolve(context).run()
    expect(cmd.resolve).toBe(outer); expect(f.opened).not.toHaveBeenCalled(); expect(f.locals.new).toHaveBeenCalledOnce()
  } finally { f.dispose() }
})

it('rolls back all prior assignments if one guarded resolver rejects installation', () => {
  const f = fixture(); f.routing.dispose()
  const command = f.registry.commands.get('session.archive')
  f.registry.commands.set(command.id, new Proxy(command, { set: () => { throw new Error('immutable owner') } }))
  try {
    expect(installShortcutTargetRouter(f.service, '0.2.1-rc.3', () => undefined).supported).toBe(false)
    for (const id of ['session.new', 'session.rename', 'session.fork']) expect(f.registry.commands.get(id).resolve).toBe(f.originals.get(id))
  } finally { f.dispose() }
})

it('contains a remote resolver exception without executing the local fallback', () => {
  const f = fixture(); f.routing.dispose()
  const routing = installShortcutTargetRouter(f.service, '0.2.1-rc.3', () => { throw new Error('unexpected adapter failure') })
  try {
    expect(f.registry.commands.get('session.archive').resolve(context).status).toBe('blocked')
    expect(f.locals.archive).not.toHaveBeenCalled()
  } finally { routing.dispose(); f.dispose() }
})
