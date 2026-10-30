// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceOrder, WORKSPACE_ORDER_KEY, moveWorkspaceBefore, orderedWorkspaces } from '../src/client/workspace-order.ts'

afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })
const a = 'local-a', b = 'local-b', x = 'dsh-ssh-nav:w:remote-x', y = 'dsh-ssh-nav:w:remote-y'
const visible = [a, b, x, y]

it('moves SSH projects, mixed projects, and the final row without mutating project identities', () => {
  const remoteFirst = moveWorkspaceBefore([], visible, y, x)
  expect(remoteFirst).toEqual([a, b, y, x])
  const mixed = moveWorkspaceBefore(remoteFirst, visible, x, a)
  expect(mixed).toEqual([x, a, b, y])
  expect(moveWorkspaceBefore(mixed, visible, a, undefined)).toEqual([x, b, y, a])
  expect(visible).toEqual([a, b, x, y])
})
it('persists the complete mixed order through a new client instance', () => {
  const first = new WorkspaceOrder()
  expect(first.move(x, a, visible)).toBe(true)
  expect(first.move(y, b, visible)).toBe(true)
  expect(new WorkspaceOrder().getSnapshot()).toEqual([x, a, y, b])
})
it('retains temporarily absent Hosts and places newly discovered projects after saved projects', () => {
  const first = new WorkspaceOrder()
  first.move(x, a, visible)
  first.move(b, a, [a, b]) // Remote catalogs have not arrived in this view yet.
  const saved = new WorkspaceOrder().getSnapshot()
  expect(saved).toEqual([x, b, a, y])
  const rows = [...visible, 'new-project'].map(workspaceId => ({ workspaceId, sessionIds: [workspaceId] }))
  const before = JSON.stringify(rows)
  expect(orderedWorkspaces(rows, saved).map(row => row.workspaceId)).toEqual([x, b, a, y, 'new-project'])
  expect(orderedWorkspaces(rows.filter(row => row.workspaceId !== x), saved).map(row => row.workspaceId)).toEqual([b, a, y, 'new-project'])
  expect(JSON.stringify(rows)).toBe(before)
})
it.each(['{bad', JSON.stringify({ version: 2, order: visible }), JSON.stringify({ version: 1, order: [a, a] }), JSON.stringify({ version: 1, order: ['bad\u0000id'] })])('keeps malformed preference bytes and uses an explicitly temporary layout', raw => {
  localStorage.setItem(WORKSPACE_ORDER_KEY, raw)
  const order = new WorkspaceOrder()
  expect(order.move(x, a, visible)).toBe(false)
  expect(order.getSnapshot()).toEqual([x, a, b, y])
  expect(localStorage.getItem(WORKSPACE_ORDER_KEY)).toBe(raw)
})
it('keeps gestures usable when browser storage is blocked or full', () => {
  const inaccessible = new WorkspaceOrder(() => { throw Error('blocked') })
  expect(inaccessible.move(x, a, visible)).toBe(false)
  expect(inaccessible.getSnapshot()).toEqual([x, a, b, y])
  const full = new WorkspaceOrder(() => ({ getItem: () => null, setItem: () => { throw Error('full') } }))
  full.move(x, a, visible); full.move(y, b, visible)
  expect(full.getSnapshot()).toEqual([x, a, y, b])
})
it('observes another window, reads its newest order before a gesture, and releases its listener', () => {
  const first = new WorkspaceOrder(), listener = vi.fn(), stop = first.subscribe(listener)
  localStorage.setItem(WORKSPACE_ORDER_KEY, JSON.stringify({ version: 1, order: [y, x, a, b] }))
  window.dispatchEvent(new StorageEvent('storage', { key: WORKSPACE_ORDER_KEY }))
  expect(first.getSnapshot()).toEqual([y, x, a, b]); expect(listener).toHaveBeenCalledTimes(1)
  // A newer write can arrive before the asynchronous storage event.
  localStorage.setItem(WORKSPACE_ORDER_KEY, JSON.stringify({ version: 1, order: [x, b, y, a] }))
  first.move(b, x, visible)
  expect(first.getSnapshot()).toEqual([b, x, y, a])
  stop(); listener.mockClear()
  localStorage.removeItem(WORKSPACE_ORDER_KEY)
  window.dispatchEvent(new StorageEvent('storage', { key: WORKSPACE_ORDER_KEY }))
  expect(listener).not.toHaveBeenCalled()
})
it('rejects stale drag identities without replacing the last saved layout', () => {
  const order = new WorkspaceOrder(); order.move(x, a, visible)
  const saved = localStorage.getItem(WORKSPACE_ORDER_KEY)
  expect(() => order.move('removed', a, visible)).toThrow('no longer visible')
  expect(() => order.move(a, 'removed', visible)).toThrow('no longer visible')
  expect(localStorage.getItem(WORKSPACE_ORDER_KEY)).toBe(saved)
})
