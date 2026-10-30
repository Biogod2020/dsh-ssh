// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ServerPluginsTab } from '../src/client/panel/ServerPluginsTab.tsx'
import type { SshApi } from '../src/client/api.ts'
import type { ServerPluginComparison } from '../src/remote/plugin-types.ts'
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
afterEach(() => { act(() => root?.unmount()); document.body.replaceChildren(); vi.restoreAllMocks() })
const plan: ServerPluginComparison = { planId: 'plan-one', alias: 'fixture', hostId: 'a'.repeat(24), hostUpdatedAt: 42,
  dshVersion: '0.2.1-rc.3', checkedAt: Date.now(), expiresAt: Date.now() + 300000,
  rows: [{ name: 'paper-review', local: { name: 'paper-review', version: '1.2.0', enabled: true, official: false }, status: 'missing', spec: 'paper-review@1.2.0' },
    { name: 'private-tools', local: { name: 'private-tools', version: '1.0.0', enabled: true, official: false }, status: 'missing', block: 'development' }] }
async function fixture() {
  const api = { listHosts: vi.fn(async () => [{ alias: 'fixture', host: '127.0.0.1', user: 'tester', port: 22, updatedAt: 42 }]),
    compareServerPlugins: vi.fn(async () => structuredClone(plan)), syncServerPlugins: vi.fn(async () => ({ id: 'job-one', alias: 'fixture', state: 'complete', items: [{ name: 'paper-review', version: '1.2.0', state: 'installed' }] })),
    serverPluginJob: vi.fn() }
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(<ServerPluginsTab api={api as unknown as SshApi} />))
  const host = container.querySelector('select')!
  await act(async () => { host.value = 'fixture'; host.dispatchEvent(new Event('change', { bubbles: true })) })
  return { api, container }
}
it('waits for explicit comparison and selection, blocks development packages, and submits only once', async () => {
  const { api, container } = await fixture()
  expect(api.compareServerPlugins).not.toHaveBeenCalled()
  await act(async () => (container.querySelector('button') as HTMLButtonElement).click())
  expect(api.compareServerPlugins).toHaveBeenCalledWith('fixture', 42)
  const boxes = container.querySelectorAll<HTMLInputElement>('tbody input[type=checkbox]')
  expect(boxes[0]!.checked).toBe(false); expect(boxes[1]!.disabled).toBe(true)
  await act(async () => boxes[0]!.click())
  const sync = [...container.querySelectorAll<HTMLButtonElement>('button')].at(-1)!
  await act(async () => { sync.click(); sync.click() })
  expect(api.syncServerPlugins).toHaveBeenCalledOnce()
  expect(api.syncServerPlugins.mock.calls[0]?.slice(0, 2)).toEqual(['plan-one', ['paper-review']])
  expect(container.textContent).toContain('paper-review@1.2.0')
})
it('ignores an old comparison after the user changes the selected host', async () => {
  const { api, container } = await fixture()
  let resolve!: (value: ServerPluginComparison) => void
  api.compareServerPlugins.mockImplementation(() => new Promise(done => { resolve = done }))
  await act(async () => (container.querySelector('button') as HTMLButtonElement).click())
  await act(async () => { const select = container.querySelector('select')!; select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => resolve(plan))
  expect(container.querySelector('table')).toBeNull()
  expect(api.syncServerPlugins).not.toHaveBeenCalled()
})
