// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ServerModelsTab } from '../src/client/panel/ServerModelsTab.tsx'
import type { SshApi } from '../src/client/api.ts'
import { SshApi as RealSshApi } from '../src/client/api.ts'
import type { ModelFollowView } from '../src/remote/model-types.ts'
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
afterEach(() => { act(() => root?.unmount()); document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const snapshot: ModelFollowView = { alias: 'fixture', mode: 'follow', connected: true, state: 'ready',
  rows: [{ id: 'llm-pi-ai:fixture', provider: 'fixture', label: 'Fixture provider', mode: 'follow', status: 'synced', modelCount: 2 }], default: { mode: 'follow', status: 'synced' } }
async function fixture() {
  const api = { listHosts: vi.fn(async () => [{ alias: 'fixture', host: '203.0.113.20', user: 'tester', port: 22, updatedAt: 42 }]),
    serverModels: vi.fn(async () => structuredClone(snapshot)), setServerModelPolicy: vi.fn(async (_alias, _version, change) => ({ ...structuredClone(snapshot), ...(change.mode ? { mode: change.mode } : {}) })), openServerModels: vi.fn() }
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(<ServerModelsTab api={api as unknown as SshApi} />))
  const host = container.querySelector('select')!
  await act(async () => { host.value = 'fixture'; host.dispatchEvent(new Event('change', { bubbles: true })) })
  return { api, container }
}
it('shows the default follow mode without creating a connection or issuing a sync write', async () => {
  const { api, container } = await fixture()
  expect(api.serverModels).toHaveBeenCalledWith('fixture', 42)
  expect(api.setServerModelPolicy).not.toHaveBeenCalled(); expect(api.openServerModels).not.toHaveBeenCalled()
  expect(container.querySelectorAll('select')[1]!.value).toBe('follow')
  expect(container.textContent).toContain('Fixture provider'); expect(container.querySelector('input[type=password]')).toBeNull()
})
it('lets the host opt out and keeps the identity bound to that reviewed host', async () => {
  const { api, container } = await fixture(), mode = container.querySelectorAll('select')[1]!
  await act(async () => { mode.value = 'independent'; mode.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(api.setServerModelPolicy).toHaveBeenCalledExactlyOnceWith('fixture', 42, { mode: 'independent' })
  expect(mode.value).toBe('independent')
})
it('allows a provider to be configured independently while the host keeps following', async () => {
  const { api, container } = await fixture()
  await act(async () => { (container.querySelector('tbody button') as HTMLButtonElement).click() })
  expect(api.setServerModelPolicy).toHaveBeenCalledExactlyOnceWith('fixture', 42, { provider: 'llm-pi-ai:fixture', providerMode: 'independent' })
})
it('does not render a response that arrives after switching away from its host', async () => {
  const { api, container } = await fixture()
  let resolve!: (value: ModelFollowView) => void
  api.serverModels.mockImplementation(() => new Promise(done => { resolve = done }))
  const host = container.querySelector('select')!
  await act(async () => { host.value = ''; host.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => { host.value = 'fixture'; host.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => { host.value = ''; host.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => { resolve(snapshot) })
  expect(container.querySelector('table')).toBeNull()
})
it('releases the model policy controls after a lost response and observes status without resending the write', async () => {
  vi.useFakeTimers()
  const { api, container } = await fixture()
  const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
  }))
  vi.stubGlobal('fetch', fetch)
  api.setServerModelPolicy.mockImplementation((...args) => new RealSshApi().setServerModelPolicy(...args))
  // The controller can finish the dispatched change even though its HTTP
  // response is lost. Subsequent reads are authoritative, not a retry.
  api.serverModels.mockResolvedValue({ ...structuredClone(snapshot), mode: 'independent' })
  const host = container.querySelector('select')!, mode = container.querySelectorAll('select')[1]!
  await act(async () => { mode.value = 'independent'; mode.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(host.disabled).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(35000) })
  expect(host.disabled).toBe(false)
  expect(mode.value).toBe('independent')
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(api.serverModels.mock.calls.length).toBeGreaterThan(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(container.querySelector('[role=alert]')).toBeNull()
})
it('clears a previous read error after a successful status poll', async () => {
  vi.useFakeTimers()
  const { api, container } = await fixture()
  api.serverModels.mockRejectedValueOnce(new Error('fixture model status failed'))
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(container.textContent).toContain('fixture model status failed')
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(container.textContent).not.toContain('fixture model status failed')
  expect(container.textContent).toContain('Fixture provider')
})
it('keeps the unconfirmed policy warning while the observed synchronization is still pending', async () => {
  vi.useFakeTimers()
  const { api, container } = await fixture(), mode = container.querySelectorAll('select')[1]!
  api.setServerModelPolicy.mockRejectedValue(new Error('lost acknowledgement'))
  api.serverModels.mockResolvedValue({ ...structuredClone(snapshot), state: 'syncing' })
  await act(async () => { mode.value = 'independent'; mode.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(container.querySelector('[role=alert]')?.textContent).toContain('请求结果暂未确认')
  api.serverModels.mockResolvedValue(structuredClone(snapshot))
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(container.querySelector('[role=alert]')).toBeNull()
})
