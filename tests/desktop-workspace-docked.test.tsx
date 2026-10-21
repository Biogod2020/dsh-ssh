// @vitest-environment jsdom
import { act, createElement, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { mountDesktopWorkspaces } from '../src/client/desktop-workspace.ts'
import { openRemoteWorkspace } from '../src/client/remote-workspaces.ts'
import { remoteSelection } from '../src/client/remote-presentation.ts'
import type { DesktopShellContext } from '../src/client/desktop-workspace-seat.tsx'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined, dispose: (() => void) | undefined
afterEach(async () => { await act(async () => { dispose?.(); root?.unmount() }); dispose = undefined; root = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })
const workspace = { id: 'one', hostId: 'a'.repeat(24), alias: 'fixture', remotePath: '/remote/project', title: 'project', workspaceId: 'remote-one' }
function fixture(initialPanel: string | null = null) {
  document.documentElement.lang = 'en'
  const sidebar = document.createElement('aside'), local = document.createElement('button'), main = document.createElement('main'), frame = document.createElement('section'), right = document.createElement('aside')
  main.className = 'fixture_centerCol'; right.className = 'fixture_rightbarCol'
  local.textContent = 'Local project'; sidebar.append(local); frame.append(sidebar, main, right); document.body.append(frame); root = createRoot(main)
  let Page: ComponentType | undefined, selected: string | null = initialPanel
  const listeners = new Set<() => void>()
  const layout = {
    panelInfo: { getSnapshot: () => ({ activePanelId: selected }), subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } } },
    selectPanel: (id: string | null) => {
      selected = id; for (const fn of listeners) fn()
      root!.render(id === 'ssh-remote-workspace' && Page ? createElement(Page) : <textarea aria-label="Local draft" defaultValue="saved local draft" />)
    },
  }
  local.onclick = () => layout.selectPanel(null)
  const ctx = { get: () => layout, slots: {
    inject: (_name: string, callback: () => () => void) => callback(),
    register: (_options: object, component: ComponentType) => { Page = component; return () => { Page = undefined } },
  } } as unknown as DesktopShellContext
  const guests: Array<HTMLElement & { loadURL: ReturnType<typeof vi.fn> }> = [], create = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((name: string, options?: ElementCreationOptions) => {
    const node = create(name, options)
    if (name === 'webview') guests.push(Object.assign(node, { loadURL: vi.fn(async () => {}), executeJavaScript: vi.fn(async () => true) }))
    return node
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this === frame ? new DOMRect(0, 0, 1280, 748) : new DOMRect(280, 48, 900, 700)
  })
  const bridge = { acquire: vi.fn(async () => ({ lease: `lease-${guests.length}`, partition: `partition-${guests.length}` })), release: vi.fn(async () => {}), onOpenRequested: () => () => {} }
  vi.stubGlobal('dshDesktop', { browser: bridge })
  const fetch = vi.fn(async (_input: unknown, options: RequestInit) => ({ ok: true, json: async () => ({
    url: 'http://127.0.0.1:40200/?dsh-remote-ticket=fixture', sessionId: JSON.parse(options.body as string).sessionId ?? 'first',
  }) }))
  vi.stubGlobal('fetch', fetch)
  dispose = mountDesktopWorkspaces(undefined, ctx)
  const open = async (sessionId: string) => {
    await act(async () => {
      const promise = openRemoteWorkspace(workspace, sessionId)
      for (let n = 0; n < 8; n++) await Promise.resolve()
      guests.at(-1)!.dispatchEvent(new Event('dom-ready')); await promise
    })
  }
  return { sidebar, local, main, right, guests, bridge, fetch, open, layout }
}
it('keeps local sidebar usable while docking the remote guest to the native main panel', async () => {
  const f = fixture(); await f.open('first')
  const surface = document.querySelector<HTMLElement>('[data-dsh-remote-desktop]')!
  expect(surface.hidden).toBe(false); expect(surface.dataset.docked).toBe('true')
  expect(surface.style.left).toBe('280px'); expect(surface.style.width).toBe('1000px')
  expect(f.sidebar.inert).not.toBe(true); expect(f.local.disabled).toBe(false)
  expect(f.right.inert).toBe(true)
  expect(remoteSelection()).toEqual({ workspaceId: workspace.id, sessionId: 'first' })
  await act(async () => f.local.click())
  expect(surface.hidden).toBe(true); expect(remoteSelection()).toBeUndefined()
  expect(f.right.inert).not.toBe(true)
  expect(f.guests[0]!.isConnected).toBe(true)
  expect(f.main.querySelector('textarea')!.value).toBe('saved local draft')
  await act(async () => openRemoteWorkspace(workspace, 'first'))
  expect(surface.hidden).toBe(false); expect(f.fetch).toHaveBeenCalledOnce(); expect(f.guests[0]!.loadURL).toHaveBeenCalledOnce()
})
it('reuses one attached client for a Host across conversation and local navigation', async () => {
  const f = fixture(); await f.open('first'); const first = f.guests[0]!
  first.dataset.unsentDraft = 'first unsent draft'
  await f.open('second')
  expect(f.guests).toHaveLength(1)
  await act(async () => f.local.click())
  await act(async () => openRemoteWorkspace(workspace, 'first'))
  expect(first.hidden).toBe(false)
  expect(first.dataset.unsentDraft).toBe('first unsent draft')
  expect(first.loadURL).toHaveBeenCalledOnce()
  expect(f.guests.every(x => x.isConnected)).toBe(true); expect(f.bridge.release).not.toHaveBeenCalled()
  await act(async () => dispose!()); dispose = undefined
  expect(f.bridge.release).toHaveBeenCalledOnce()
})
it('restores local navigation after restarting with an obsolete remote-panel selection', async () => {
  let f!: ReturnType<typeof fixture>
  await act(async () => { f = fixture('ssh-remote-workspace') })
  expect(f.layout.panelInfo.getSnapshot().activePanelId).toBeNull()
  expect(f.main.querySelector('textarea')!.value).toBe('saved local draft')
  expect(f.bridge.acquire).not.toHaveBeenCalled()
  expect(f.sidebar.inert).not.toBe(true); expect(f.right.inert).not.toBe(true)
})
