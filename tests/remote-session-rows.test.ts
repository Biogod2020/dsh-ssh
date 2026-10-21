// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { remoteSessionRows } from '../src/client/remote-session-rows.ts'
import { selectRemoteView } from '../src/client/remote-presentation.ts'
const workspace = { id: 'a'.repeat(24), hostId: 'b'.repeat(24), alias: 'fixture', remotePath: '/remote/project', title: 'project', workspaceId: 'remote-work' }
let view: ReturnType<typeof remoteSessionRows> | undefined
afterEach(() => { view?.dispose(); view = undefined; selectRemoteView(); vi.unstubAllGlobals(); document.body.replaceChildren() })
it('switches exact remote sessions, keeps keyed focus, reflects running state and creates only after an explicit click', async () => {
  document.documentElement.lang = 'en'
  let stale = false
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ workspaceId: workspace.workspaceId, stale,
    sessions: [{ sessionId: 'one', title: 'First conversation', running: true, blank: false, updatedAt: 12 },
      { sessionId: 'two', title: 'Second conversation', running: false, blank: false, updatedAt: 10 }] }) }))
  vi.stubGlobal('fetch', fetch)
  const open = vi.fn(); view = remoteSessionRows(workspace, open); document.body.append(view.node)
  await vi.waitFor(() => expect(view!.node.querySelectorAll('[data-remote-session-id]')).toHaveLength(2))
  expect(open).not.toHaveBeenCalled()
  const first = view.node.querySelector<HTMLButtonElement>('[data-remote-session-id="one"]')!; first.focus(); first.click()
  expect(open).toHaveBeenCalledExactlyOnceWith('one')
  selectRemoteView({ workspaceId: workspace.id, sessionId: 'one' }); expect(first.getAttribute('aria-current')).toBe('page')
  expect(first.getAttribute('aria-label')).toContain('Running')
  stale = true; await view.refresh()
  expect(document.activeElement).toBe(first); expect(first.dataset.running).toBe('false')
  expect(first.getAttribute('aria-label')).toContain('unconfirmed')
  ;[...view.node.querySelectorAll('button')].find(x => x.textContent === '+ New remote conversation')!.click()
  expect(open).toHaveBeenLastCalledWith(undefined, true)
  view.update(true, false); expect(first.disabled).toBe(true)
})
it('aborts a pending read on disposal and cannot render or launch a late response', async () => {
  let finish!: (value: unknown) => void, signal!: AbortSignal
  vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => { signal = options.signal!; return new Promise(resolve => { finish = resolve }) }))
  const open = vi.fn(); view = remoteSessionRows(workspace, open); document.body.append(view.node)
  view.dispose(); expect(signal.aborted).toBe(true)
  finish({ ok: true, json: async () => ({ workspaceId: workspace.workspaceId, sessions: [], stale: false }) })
  await Promise.resolve(); await Promise.resolve()
  expect(view.node.isConnected).toBe(false); expect(open).not.toHaveBeenCalled()
})
it('rejects a late catalog after going offline instead of reviving a running status', async () => {
  let finish!: (value: unknown) => void, signal!: AbortSignal
  vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => { signal = options.signal!; return new Promise(resolve => { finish = resolve }) }))
  view = remoteSessionRows(workspace, vi.fn()); document.body.append(view.node)
  view.update(false, true); expect(signal.aborted).toBe(true)
  finish({ ok: true, json: async () => ({ workspaceId: workspace.workspaceId, stale: false,
    sessions: [{ sessionId: 'late', title: 'Late result', running: true, blank: false, updatedAt: 12 }] }) })
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(view.node.querySelector('[data-remote-session-id]')).toBeNull()
  expect(view.node.textContent).toContain('offline')
})
it('does not label an unread remote archive as an empty archive', async () => {
  document.documentElement.lang = 'en'
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ workspaceId: workspace.workspaceId, sessions: [], stale: true }) })))
  view = remoteSessionRows(workspace, vi.fn()); document.body.append(view.node)
  await vi.waitFor(() => expect(view!.node.textContent).toContain('Open this project to load'))
  expect(view.node.querySelector('button')!.textContent).not.toContain('(0)')
  expect(view.node.textContent).not.toContain('No conversations yet')
})
