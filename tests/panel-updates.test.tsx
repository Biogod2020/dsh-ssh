// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { UpdatesTab } from '../src/client/panel/UpdatesTab.tsx'
import type { SshApi } from '../src/client/api.ts'
import type { PluginUpdateView } from '../src/update-types.ts'

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
afterEach(() => { act(() => root?.unmount()); document.body.replaceChildren(); vi.useRealTimers() })

it('persists one explicit opt-in and only observes later state without repeating the write', async () => {
  vi.useFakeTimers()
  let view: PluginUpdateView = { enabled: false, supported: true, runningVersion: '0.3.24-jay.69', phase: 'disabled' }
  const api = { pluginUpdate: vi.fn(async () => ({ ...view })), setPluginUpdate: vi.fn(async (enabled: boolean) => {
    view = { ...view, enabled, phase: 'waiting', availableVersion: '0.3.24-jay.70' }; return view
  }) }
  const node = document.createElement('div'); document.body.append(node); root = createRoot(node)
  await act(async () => root.render(<UpdatesTab api={api as unknown as SshApi} active />))
  expect(node.querySelector('input')!.checked).toBe(false)
  await act(async () => node.querySelector('input')!.click())
  expect(api.setPluginUpdate).toHaveBeenCalledExactlyOnceWith(true)
  expect(node.querySelector('input')!.checked).toBe(true)
  expect(node.textContent).toContain('0.3.24-jay.70')
  await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
  expect(api.setPluginUpdate).toHaveBeenCalledTimes(1)
  expect(api.pluginUpdate.mock.calls.length).toBeGreaterThan(1)
})
