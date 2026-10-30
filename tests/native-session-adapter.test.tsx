// @vitest-environment jsdom
import { act, createElement, Fragment, type ComponentType, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SlotCore, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { NativeSessionAdapter, mountNativeSessionOverlays } from '../src/client/native-session-adapter.tsx'
import { remoteNavigation, remoteSessionKey } from '../src/client/remote-navigation.ts'
import { registerRemotePresentation, selectRemoteView } from '../src/client/remote-presentation.ts'
import type { RemoteWorkspace } from '../src/remote/types.ts'

type Props = Record<string, any>
const menuSlot = 'sidebar.workspaces.session.menu.item'
let root: Root | undefined, host: HTMLElement | undefined, release: (() => void) | undefined
const reply = (value: object, ok = true) => ({ ok, json: async () => value }) as Response
const workspace = (id: string, hostId: string): RemoteWorkspace => ({ id, hostId, workspaceId: 'project', alias: id, remotePath: `/remote/${id}`, title: id })
const catalog = (value: RemoteWorkspace) => ({ workspaceId: value.workspaceId, stale: false, sessions: [{ sessionId: 'same', title: 'Saved', running: false, blank: false, updatedAt: 1 }], archivedSessions: [] })
const entry = (id: string, component: ComponentType<Props>, priority = 0) => ({ options: { name: menuSlot, id, priority }, component }) as unknown as StoredEntry
const owner = (sessionId: string) => ({ sessionId, displayTitle: 'Saved', t: (key: string) => key, useMenuOpenState: (select: (value: readonly unknown[]) => unknown) => select([]) })

async function render(children: ReactNode) {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(children) })
}
async function flush() { await Promise.resolve(); await Promise.resolve(); await new Promise<void>(resolve => setTimeout(resolve, 0)) }
async function ready(workspaces: readonly RemoteWorkspace[], onPost: (init: RequestInit) => Response | Promise<Response> = () => reply({ ok: true })) {
  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') return onPost(init)
    const id = new URL(String(url), 'http://localhost').searchParams.get('id')
    return reply(catalog(workspaces.find(value => value.id === id)!))
  })
  vi.stubGlobal('fetch', fetch); vi.stubGlobal('navigator', { onLine: true })
  remoteNavigation.update(workspaces, workspaces.map(value => ({ hostId: value.hostId, phase: 'ready' as const })))
  await Promise.all(workspaces.map(value => remoteNavigation.refresh(value)))
  return fetch
}
function nativeOverlays(adapter: NativeSessionAdapter, rename: ComponentType<Props>, archive: ComponentType<Props>) {
  const core = new SlotCore(), slots = core as unknown as Parameters<typeof mountNativeSessionOverlays>[0], register = slots.register.bind(core)
  register({ name: 'root', children: { 'shell.overlay': { kind: 'list', scope: 'root' } } }, () => null)
  register({ name: 'shell.overlay', id: 'workspace.session-rename' }, rename)
  register({ name: 'shell.overlay', id: 'workspace.session-archive' }, archive)
  register({ name: 'shell.overlay', id: 'workspace.row-toast' }, () => null)
  release = mountNativeSessionOverlays(slots, adapter)
  return slots.entries('shell.overlay').filter(value => String(value.options.id).startsWith('dsh-ssh.remote.'))
}
const overlayOwner = { t: (key: string) => key, useRenameRequest: (select: (value: null) => unknown) => select(null), useArchiveRequest: (select: (value: null) => unknown) => select(null), useToast: (select: (value: null) => unknown) => select(null) }
afterEach(() => { act(() => root?.unmount()); root = undefined; host?.remove(); host = undefined; release?.(); release = undefined; remoteNavigation.clear(); selectRemoteView(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })

it('keeps a local component and props by identity, but fails unknown remote entries closed and leaves only copy safe offline', async () => {
  const remote = workspace('a'.repeat(24), 'b'.repeat(24)), key = remoteSessionKey(remote, 'same')
  await ready([remote]); const adapter = new NativeSessionAdapter()
  const local = vi.fn(() => null), localProps = { sessionId: 'local', nested: { preserved: true } }
  const localElement = adapter.renderChild(menuSlot, entry('pin', local), localProps)
  expect(localElement?.type).toBe(local); expect(localElement?.props).toMatchObject(localProps); expect(localElement?.props.nested).toBe(localProps.nested)
  const unknown = vi.fn(() => null), pin = vi.fn(() => null), copy = vi.fn((_props: Props) => null), remoteProps = { ...owner(key), copySessionId: vi.fn(), localPin: vi.fn() }
  await act(async () => { remoteNavigation.stale() }); vi.stubGlobal('navigator', { onLine: false })
  await render(<><Fragment key="unknown">{adapter.renderChild(menuSlot, entry('future-native-action', unknown), remoteProps)}</Fragment><Fragment key="pin">{adapter.renderChild(menuSlot, entry('pin', pin), remoteProps)}</Fragment><Fragment key="copy">{adapter.renderChild(menuSlot, entry('session-id', copy), remoteProps)}</Fragment></>)
  expect(unknown).not.toHaveBeenCalled(); expect(pin).not.toHaveBeenCalled(); expect(copy).toHaveBeenCalledOnce()
  expect(copy.mock.calls[0]![0]).toMatchObject({ sessionId: 'same', copySessionId: remoteProps.copySessionId })
  expect(copy.mock.calls[0]![0].localPin).toBeUndefined()
})

it('uses the five native components in source order and sends an equal Session id only to its selected Host', async () => {
  const first = workspace('a'.repeat(24), 'c'.repeat(24)), second = workspace('b'.repeat(24), 'd'.repeat(24)), fetch = await ready([first, second])
  const adapter = new NativeSessionAdapter(); adapter.overlay('rename', true)
  const key = remoteSessionKey(second, 'same'), remoteProps = { ...owner(key), copySessionId: vi.fn(), localPin: vi.fn() }, controls: Record<string, Props> = {}
  const native = (id: string) => (props: Props) => { controls[id] = props; return <output data-native={id} /> }
  const entries = ['pin', 'rename', 'fork', 'archive', 'session-id'].map((id, index) => entry(id, native(id), 100 - index))
  await render(<>{entries.map(value => <Fragment key={String(value.options.id)}>{adapter.renderChild(menuSlot, value, remoteProps)}</Fragment>)}</>)
  expect([...document.querySelectorAll('output')].map(value => value.getAttribute('data-native'))).toEqual(['pin', 'rename', 'fork', 'archive', 'session-id'])
  for (const id of ['pin', 'rename', 'fork', 'archive']) expect(controls[id]!.sessionId).toBe(key)
  expect(controls['session-id']!.sessionId).toBe('same'); expect(controls['session-id']!.copySessionId).toBe(remoteProps.copySessionId); expect(controls.pin!.localPin).toBeUndefined()
  await act(async () => { controls.pin!.pinSession(key); await flush() })
  const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!
  expect(JSON.parse(String(post[1]!.body))).toMatchObject({ id: second.id, expectedHostId: second.hostId, sessionId: 'same', action: 'pin' })
})

it('lets native rename cancel without a POST, then confirms one remote rename through the official callback', async () => {
  const remote = workspace('a'.repeat(24), 'b'.repeat(24)), key = remoteSessionKey(remote, 'same'), fetch = await ready([remote]), adapter = new NativeSessionAdapter()
  let menu: Props = {}, dialog: Props = {}
  const menuRename = (props: Props) => { menu = props; return null }
  const nativeRename = (props: Props) => { dialog = { ...props, request: props.useRenameRequest((value: unknown) => value) }; return null }
  const copies = nativeOverlays(adapter, nativeRename, () => null)
  await render(<>{adapter.renderChild(menuSlot, entry('rename', menuRename), owner(key))}{copies.map(value => <Fragment key={String(value.options.id)}>{createElement(value.component as ComponentType<Props>, overlayOwner)}</Fragment>)}</>)
  await act(async () => { menu.requestSessionRename(key, 'Saved') }); expect(dialog.request).toMatchObject({ sessionId: key, currentTitle: 'Saved' })
  await act(async () => { dialog.settleSessionRename() }); expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  await act(async () => { menu.requestSessionRename(key, 'Saved') })
  await act(async () => { await dialog.renameSession(dialog.request.sessionId, 'Renamed'); dialog.settleSessionRename(); await flush() })
  const writes = fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
  expect(writes).toHaveLength(1); expect(JSON.parse(String(writes[0]![1]!.body))).toMatchObject({ id: remote.id, expectedHostId: remote.hostId, sessionId: 'same', action: 'rename', title: 'Renamed' })
})

it('keeps active archive cancellable and makes exactly one confirmed stop-and-archive POST without retry', async () => {
  const remote = workspace('a'.repeat(24), 'b'.repeat(24)), key = remoteSessionKey(remote, 'same'); let attempts = 0
  const fetch = await ready([remote], () => ++attempts <= 2 ? reply({ errorCode: 'workspace/session-active', activity: [{ kind: 'turn', items: [{ id: 'active' }] }] }, false) : reply({ ok: true }))
  const adapter = new NativeSessionAdapter(); let menu: Props = {}, dialog: Props = {}
  const menuArchive = (props: Props) => { menu = props; return null }
  const nativeArchive = (props: Props) => { dialog = { ...props, request: props.useArchiveRequest((value: unknown) => value) }; return null }
  const copies = nativeOverlays(adapter, () => null, nativeArchive)
  await render(<>{adapter.renderChild(menuSlot, entry('archive', menuArchive), owner(key))}{copies.map(value => <Fragment key={String(value.options.id)}>{createElement(value.component as ComponentType<Props>, overlayOwner)}</Fragment>)}</>)
  await act(async () => { menu.archiveSession(key); await flush() }); expect(dialog.request).toMatchObject({ sessionId: key, activity: [{ kind: 'turn' }] })
  await act(async () => { dialog.settleSessionArchive() }); expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  await act(async () => { menu.archiveSession(key); await flush() })
  await act(async () => { await dialog.stopAndArchiveSession(dialog.request.sessionId); dialog.settleSessionArchive(); await flush() })
  const writes = fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
  expect(writes).toHaveLength(3); expect(JSON.parse(String(writes[2]![1]!.body))).toMatchObject({ id: remote.id, expectedHostId: remote.hostId, sessionId: 'same', action: 'archive', stopActivity: true })
})

it('clears a confirmed archived selection without closing its Host view or replaying a successful write', async () => {
  const remote = workspace('a'.repeat(24), 'b'.repeat(24)), key = remoteSessionKey(remote, 'same'), fetch = await ready([remote])
  const archived = vi.fn(async () => { throw new Error('view cleanup failed') }), close = vi.fn()
  const unregister = registerRemotePresentation({ resume: () => false, open: async () => {}, archived, close })
  try {
    selectRemoteView({ workspaceId: remote.id, sessionId: 'same' })
    const adapter = new NativeSessionAdapter()
    await adapter.archive(key)
    expect(archived).toHaveBeenCalledExactlyOnceWith(remote, 'same'); expect(close).not.toHaveBeenCalled()
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(adapter.getSnapshot().issue).not.toBe('')
  } finally { unregister() }
})

it('reports a blocked draft save accurately and retains the original Host context after navigation changes', async () => {
  document.documentElement.lang = 'en'
  const remote = workspace('a'.repeat(24), 'b'.repeat(24)), key = remoteSessionKey(remote, 'same'), fetch = await ready([remote])
  let fail!: (reason: unknown) => void
  const unregister = registerRemotePresentation({ resume: () => false, open: async () => {}, beforeLeave: () => new Promise<void>((_resolve, reject) => { fail = reject }) })
  try {
    const adapter = new NativeSessionAdapter()
    adapter.run(() => adapter.fork(key), key)
    remoteNavigation.update([])
    fail(Object.assign(new Error('save failed'), { name: 'DraftSaveError' })); await flush()
    expect(adapter.getSnapshot().issue).toContain(remote.alias)
    expect(adapter.getSnapshot().issue).toContain('draft')
    expect(adapter.getSnapshot().issue).not.toContain('result is unconfirmed')
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  } finally { unregister() }
})

it('uses the official Toast factory and undoes only its bound remote archive once', async () => {
  const remote = workspace('a'.repeat(24), 'b'.repeat(24)), key = remoteSessionKey(remote, 'same'); let archived = false
  const fetch = await ready([remote], init => { archived = JSON.parse(String(init.body)).action === 'archive'; return reply({ ok: true }) })
  fetch.mockImplementation(async (url, init) => init?.method === 'POST'
    ? (archived = JSON.parse(String(init.body)).action === 'archive', reply({ ok: true }))
    : reply({ ...catalog(remote), sessions: archived ? [] : catalog(remote).sessions, archivedSessions: archived ? catalog(remote).sessions : [] }))
  const adapter = new NativeSessionAdapter(), copies = nativeOverlays(adapter, () => null, () => null)
  let fields: Props = {}, local: unknown = { kind: 'sessionIdCopied' }
  const dismissToast = vi.fn(() => { local = null }), renderFactorySlot = vi.fn((_slot: string, props: Props) => { fields = props; return <output>Native notice</output> })
  const props = { ...overlayOwner, useToast: (select: (value: unknown) => unknown) => select(local), dismissToast, renderFactorySlot }
  await render(<>{copies.map(value => <Fragment key={String(value.options.id)}>{createElement(value.component as ComponentType<Props>, props)}</Fragment>)}</>)
  await act(async () => { await adapter.archive(key) })
  expect(dismissToast).toHaveBeenCalledOnce()
  expect(renderFactorySlot).toHaveBeenLastCalledWith('workspace.toast.content', expect.objectContaining({ tone: 'success', holdMs: 6000 }))
  expect(fields.actions).toHaveLength(1)
  await act(async () => { fields.actions[0].onClick(); await flush() })
  const writes = fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
  expect(writes.map(([, init]) => JSON.parse(String(init!.body)).action)).toEqual(['archive', 'unarchive'])
  expect(JSON.parse(String(writes[1]![1]!.body))).toMatchObject({ expectedHostId: remote.hostId, sessionId: 'same' })
  expect(adapter.getSnapshot().notice).toBeNull()
})

it('fences a settled nonce and Host replacement before stale native callbacks can write', async () => {
  const original = workspace('a'.repeat(24), 'b'.repeat(24)), replacement = { ...original, hostId: 'c'.repeat(24) }, key = remoteSessionKey(original, 'same'), fetch = await ready([original]), adapter = new NativeSessionAdapter()
  let menu: Props = {}, dialog: Props = {}
  const menuRename = (props: Props) => { menu = props; return null }
  const nativeRename = (props: Props) => { dialog = { ...props, request: props.useRenameRequest((value: unknown) => value) }; return null }
  const copies = nativeOverlays(adapter, nativeRename, () => null)
  await render(<>{adapter.renderChild(menuSlot, entry('rename', menuRename), owner(key))}{copies.map(value => <Fragment key={String(value.options.id)}>{createElement(value.component as ComponentType<Props>, overlayOwner)}</Fragment>)}</>)
  await act(async () => { menu.requestSessionRename(key, 'Saved') }); const stale = dialog
  await act(async () => { stale.settleSessionRename() }); await expect(stale.renameSession(stale.request.sessionId, 'old')).rejects.toThrow()
  await act(async () => { menu.requestSessionRename(key, 'Saved') }); await act(async () => { remoteNavigation.update([replacement], [{ hostId: replacement.hostId, phase: 'ready' }]); await flush() })
  await expect(dialog.renameSession(dialog.request.sessionId, 'host changed')).rejects.toThrow()
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
})
