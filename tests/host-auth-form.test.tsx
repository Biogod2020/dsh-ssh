// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostFormDialog } from '../src/client/panel/HostFormDialog.tsx'
import { setRuntimeTranslate } from '../src/client/panel/helpers.ts'
import type { SshApi } from '../src/client/api.ts'
import type { SshHostSummary } from '../src/protocol.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: ReturnType<typeof createRoot>[] = []
const host: SshHostSummary = { alias: 'fixture', host: 'fixture.test', port: 22, user: 'tester', auth: 'key', keyReady: true,
  passwordAvailable: false, passwordRemembered: false, proxyJump: [], tags: [], createdAt: 1, updatedAt: 1 }
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren(); document.documentElement.lang = ''; setRuntimeTranslate(undefined)
})
function input(label: string): HTMLInputElement {
  const element = [...document.querySelectorAll('label')].find(item => item.querySelector('span')?.textContent === label)?.querySelector('input')
  if (!element) throw new Error(`missing field: ${label}`)
  return element
}
async function fill(field: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const button = (text: string) => [...document.querySelectorAll('button')].find(item => item.textContent === text)!
async function mount(editing: SshHostSummary = host) {
  document.documentElement.lang = 'en'; setRuntimeTranslate(undefined)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  const updateHost = vi.fn(async () => ({ ...editing, updatedAt: 2 })), onSaved = vi.fn()
  await act(async () => root.render(<HostFormDialog api={{ updateHost } as unknown as SshApi} editing={editing} onClose={vi.fn()} onSaved={onSaved} />))
  return { updateHost, onSaved }
}

describe('host authentication editor', () => {
  it('adds a session fallback without resending the saved key, and keeps the password input masked', async () => {
    const api = await mount()
    const password = input('Fallback password (optional)')
    expect(document.activeElement).toBe(input('Host'))
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Edit host fixture')
    expect(password.type).toBe('password')
    expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false)
    await fill(password, 'fixture-fallback')
    await act(async () => button('Save').click())
    expect(api.updateHost).toHaveBeenCalledWith('fixture', expect.objectContaining({ auth: {
      kind: 'key', keyPath: undefined, passphrase: undefined, password: 'fixture-fallback', rememberPassword: false,
    } }))
    expect(api.onSaved).toHaveBeenCalledOnce()
  })

  it('does not send an auth change when existing credentials are left blank', async () => {
    const api = await mount({ ...host, passwordAvailable: true, passwordRemembered: true })
    expect(input('Fallback password (optional)').value).toBe('')
    await act(async () => button('Save').click())
    expect(api.updateHost).toHaveBeenCalledWith('fixture', expect.objectContaining({ auth: undefined }))
  })

  it('can move a remembered password to the current process without reentering it', async () => {
    const api = await mount({ ...host, passwordAvailable: true, passwordRemembered: true })
    await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    await act(async () => button('Save').click())
    expect(api.updateHost).toHaveBeenCalledWith('fixture', expect.objectContaining({ auth: expect.objectContaining({
      kind: 'key', password: undefined, rememberPassword: false,
    }) }))
  })

  it('explicitly clears a stored password', async () => {
    const api = await mount({ ...host, passwordAvailable: true, passwordRemembered: true })
    await act(async () => button('Clear password').click())
    await act(async () => button('Save').click())
    expect(api.updateHost).toHaveBeenCalledWith('fixture', expect.objectContaining({ auth: expect.objectContaining({ password: '' }) }))
  })

  it('switches a host to the default agent even with an empty agent path', async () => {
    const api = await mount()
    const agent = [...document.querySelectorAll('label')].find(item => item.textContent === 'SSH Agent')!.querySelector('input')!
    await act(async () => agent.click())
    await act(async () => button('Save').click())
    expect(api.updateHost).toHaveBeenCalledWith('fixture', expect.objectContaining({ auth: expect.objectContaining({ kind: 'agent', agentPath: undefined }) }))
  })
})
