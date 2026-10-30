// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeWorkspaces } from '../src/client/native-workspaces.tsx'
import { remoteNavigation, remoteWorkspaceKey } from '../src/client/remote-navigation.ts'
import { WorkspaceOrder } from '../src/client/workspace-order.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ MenuItemButton: () => null }))
let root: Root | undefined
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => { act(() => root?.unmount()); root = undefined; remoteNavigation.clear(); document.body.replaceChildren(); vi.restoreAllMocks() })

async function fixture(storage?: () => Pick<Storage, 'getItem' | 'setItem'>) {
  document.documentElement.lang = 'en'
  const values = new Map<string, string>()
  const order = new WorkspaceOrder(storage ?? (() => ({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } })))
  const remote = { id: 'a'.repeat(24), hostId: 'b'.repeat(24), alias: 'fixture', title: 'SSH fixture', remotePath: '/generated', workspaceId: 'remote' }
  remoteNavigation.update([remote])
  const native = vi.fn(), originalRows = { items: [{ workspaceId: 'local', path: '/local', title: 'Local', sessionIds: [] }] }
  let current: any
  function Original(props: any) { current = props; return <ol>{props.useWorkspaces((state: any) => state.items).map((row: any) => <li key={row.workspaceId}>{row.title}</li>)}</ol> }
  const parent = document.createElement('div'); document.body.append(parent); root = createRoot(parent)
  await act(async () => root!.render(createElement(NativeWorkspaces, {
    original: Original, workspaceOrder: order, useSessions: (select: any) => select({ ids: [], byId: {} }),
    useWorkspaces: (select: any) => select(originalRows), useSessionStatus: (select: any) => select(new Map()),
    usePanelInfo: (select: any) => select({ activePanelId: null }), renderSlot: native,
    insertWorkspaceBefore: native, renameWorkspace: native, deleteWorkspace: native,
  })))
  return { order, native, originalRows, remoteKey: remoteWorkspaceKey(remote), props: () => current }
}
it('routes native drag gestures into a saved mixed layout without sending synthetic ids to local controllers', async () => {
  const f = await fixture(), before = JSON.stringify(f.originalRows)
  await act(async () => { await f.props().insertWorkspaceBefore(f.remoteKey, 'local') })
  expect([...document.querySelectorAll('li')].map(el => el.textContent)).toEqual(['SSH fixture', 'Local'])
  await act(async () => { await f.props().insertWorkspaceBefore('local', f.remoteKey) })
  expect([...document.querySelectorAll('li')].map(el => el.textContent)).toEqual(['Local', 'SSH fixture'])
  expect(f.native).not.toHaveBeenCalled(); expect(JSON.stringify(f.originalRows)).toBe(before)
  expect(() => f.props().renameWorkspace(f.remoteKey, 'unsafe')).toThrow()
  expect(() => f.props().deleteWorkspace(f.remoteKey)).toThrow()
})
it('makes an unavailable preference store visible while keeping a temporary drag layout', async () => {
  const f = await fixture(() => { throw Error('blocked') })
  await act(async () => { await f.props().insertWorkspaceBefore(f.remoteKey, 'local') })
  expect(document.querySelector('li')?.textContent).toBe('SSH fixture')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('could not save')
  expect(f.native).not.toHaveBeenCalled()
})
