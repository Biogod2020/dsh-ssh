// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { HostPicker } from '../src/client/HostPicker.tsx'
import { hostHistoryId, readRecentHostIds, rememberWorkspaceHost } from '../src/client/host-picker-history.ts'
import type { SshHostSummary } from '../src/protocol.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const base: SshHostSummary = { alias: 'head', host: '192.0.2.10', port: 22, user: 'analyst', auth: 'key', keyReady: true,
  tags: ['analysis'], proxyJump: [], createdAt: 1, updatedAt: 1 }
let dispose: (() => void) | undefined
afterEach(() => { act(() => dispose?.()); dispose = undefined; document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks() })

async function mount(hosts: SshHostSummary[], loading = false) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); dispose = () => root.unmount()
  const changed = vi.fn(), choosing = vi.fn()
  function Harness() {
    const [value, setValue] = useState('')
    return <HostPicker hosts={hosts} value={value} disabled={false} loading={loading} onChoosingChange={choosing}
      onChange={alias => { changed(alias); setValue(alias) }} />
  }
  await act(async () => root.render(<Harness />))
  return { changed, choosing }
}
const input = () => document.querySelector<HTMLInputElement>('[role="combobox"]')!
async function search(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('bounds the initial list and finds hosts beyond it by alias, address, account and tags', async () => {
  const hosts = Array.from({ length: 30 }, (_, index) => ({ ...base, alias: `node${index}`, host: `192.0.2.${index + 1}`, tags: index === 29 ? ['GPU', 'training'] : [] }))
  const { changed } = await mount(hosts)
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(3)
  expect(document.activeElement).toBe(input())
  await search('GPU ANALYST')
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(1)
  expect(document.querySelector('[role="option"]')?.textContent).toContain('node29')
  await search('192.0.2.30')
  expect(document.querySelector('[data-host-alias="node29"]')).not.toBeNull()
  await search('node29')
  expect(changed).not.toHaveBeenCalled()
  expect(readRecentHostIds()).toEqual([])
  await act(async () => document.querySelector<HTMLButtonElement>('[role="option"]')!.click())
  expect(changed).toHaveBeenCalledExactlyOnceWith('node29')
  expect(input()).toBeNull()
  expect(document.querySelector('[data-selected-host="node29"]')?.textContent).toContain('analyst@192.0.2.30:22')
  expect(readRecentHostIds()).toEqual([])
})

it('supports arrow keys, an active option, and explicit Enter selection', async () => {
  const { changed } = await mount([base, { ...base, alias: 'second' }])
  await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  expect(document.getElementById(input().getAttribute('aria-activedescendant')!)).toBe(document.querySelector('[data-host-alias="head"]'))
  expect(changed).not.toHaveBeenCalled()
  await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(changed).toHaveBeenCalledExactlyOnceWith('second')
})

it('shows empty matches and clears a query on Escape without selecting anything', async () => {
  const { changed } = await mount([base])
  await search('missing')
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(0)
  expect(document.querySelector('[role="status"]')?.textContent).toContain('没有匹配')
  await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(changed).not.toHaveBeenCalled()
  await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(input().value).toBe('')
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(1)
})

it('promotes successful recent targets but does not transfer history to a reused alias', async () => {
  const second = { ...base, alias: 'second' }
  rememberWorkspaceHost(second)
  await mount([base, second])
  expect(document.querySelector('[role="option"]')?.getAttribute('data-host-alias')).toBe('second')
  expect(document.body.textContent).toContain('最近使用')
  act(() => dispose?.()); dispose = undefined
  await mount([base, { ...second, createdAt: 2 }])
  expect(document.querySelector('[role="option"]')?.getAttribute('data-host-alias')).toBe('head')
})

it('keeps unavailable storage optional and stores only bounded target identities', () => {
  const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  expect(readRecentHostIds(blocked)).toEqual([])
  expect(() => rememberWorkspaceHost(base, blocked)).not.toThrow()
  for (let index = 0; index < 12; index++) rememberWorkspaceHost({ ...base, alias: `host${index}`, proxyCommand: 'secret-command' })
  expect(readRecentHostIds()).toHaveLength(8)
  expect(readRecentHostIds()[0]).toBe(hostHistoryId({ ...base, alias: 'host11' }))
  expect(Object.values(localStorage).join(' ')).not.toContain('secret-command')
})

it('distinguishes loading from having no configured hosts', async () => {
  await mount([], true)
  expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
  expect(document.querySelector('[role="status"]')?.textContent).toContain('加载')
})
