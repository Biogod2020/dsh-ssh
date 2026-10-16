// @vitest-environment jsdom
import { act, createElement, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SshApi } from '../src/client/api.ts'
import { mountNativeSshPanel } from '../src/client/native-panel.tsx'
import { PanelController } from '../src/client/panel/controller.ts'
import type { ClusterStreamFrame } from '../src/protocol.ts'

vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let shell: Root | undefined, release: (() => void) | undefined
afterEach(async () => {
  await act(async () => { release?.(); shell?.unmount() })
  release = undefined; shell = undefined
  document.body.replaceChildren(); sessionStorage.clear()
  document.documentElement.removeAttribute('lang')
})

function fixture() {
  document.documentElement.lang = 'en'
  const entries = new Map<string, { options: Record<string, unknown>; component: ComponentType }>()
  const listeners = new Set<() => void>()
  const localeListeners = new Set<() => void>()
  let selected: string | null = null
  const container = document.createElement('div'); document.body.append(container)
  shell = createRoot(container)
  const layout = {
    panelInfo: { getSnapshot: () => ({ activePanelId: selected }), subscribe: (fn: () => void) => {
      listeners.add(fn); return () => { listeners.delete(fn) }
    } },
    selectPanel: vi.fn((id: string | null) => {
      selected = id
      for (const fn of [...listeners]) fn()
      const Page = entries.get('main')?.component
      shell!.render(id === 'ssh-ops' && Page ? createElement(Page) : <p>Other panel</p>)
    }),
  }
  const slots = {
    inject: (_name: string, callback: () => () => void) => callback(),
    register: (options: Record<string, unknown>, component: ComponentType) => {
      const name = options.name as string; entries.set(name, { options, component })
      return () => { entries.delete(name) }
    },
  }
  const ctx = { get: () => layout, slots } as unknown as Pick<Context, 'get' | 'slots'>
  const controller = new PanelController()
  const api = { listHosts: vi.fn(async () => []), listTerminals: vi.fn(async () => []),
    removeTerminal: vi.fn(async () => undefined) } as unknown as SshApi
  release = mountNativeSshPanel(ctx, controller, api, undefined, {
    subscribe: fn => { localeListeners.add(fn); return () => { localeListeners.delete(fn) } },
  })
  return { container, layout, entries, controller, api, localeListeners }
}

it('keeps the visited panel and unsent command when native navigation unmounts and remounts its seat', async () => {
  const f = fixture()
  await act(async () => f.layout.selectPanel('ssh-ops'))
  const view = f.container.querySelector('[data-dsh-ssh-view]')!
  await act(async () => f.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[4]!.click())
  const command = f.container.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(command, 'printf unsent')
    command.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => f.layout.selectPanel('plugins'))
  expect(f.controller.getSnapshot().panelOpen).toBe(false)
  expect(view.isConnected).toBe(false)
  await act(async () => {
    for (const fn of f.localeListeners) fn()
    f.layout.selectPanel('ssh-ops')
  })
  expect(f.container.querySelector('[data-dsh-ssh-view]')).toBe(view)
  expect(f.container.querySelector('textarea')).toBe(command)
  expect(command.value).toBe('printf unsent')
  expect(f.container.querySelector('[aria-selected="true"]')?.getAttribute('aria-controls')).toBe('ssh-pane-cluster')
  expect(document.documentElement.hasAttribute('data-dsh-ssh-active')).toBe(false)
})

it('routes controller open/close through the native shell and removes only its own registrations on disposal', async () => {
  const f = fixture()
  expect(f.entries.get('sidebar.panellist')?.options.id).toBe('ssh-ops')
  await act(async () => f.controller.open())
  expect(f.layout.panelInfo.getSnapshot().activePanelId).toBe('ssh-ops')
  await act(async () => f.controller.close())
  expect(f.layout.panelInfo.getSnapshot().activePanelId).toBe(null)
  await act(async () => f.controller.open())
  await act(async () => release!())
  expect(f.layout.panelInfo.getSnapshot().activePanelId).toBe(null)
  expect(f.entries.size).toBe(0)
  expect(f.localeListeners.size).toBe(0)
})

it('keeps a dispatched cluster operation alive across native navigation without cancelling or replaying it', async () => {
  const f = fixture()
  let report!: (frame: ClusterStreamFrame) => void, finish!: (value: never[]) => void, signal!: AbortSignal
  const cluster = vi.fn((_options: Parameters<SshApi['clusterStream']>[0], callback: (frame: ClusterStreamFrame) => void, abort: AbortSignal) => {
    report = callback; signal = abort
    return new Promise<never[]>(resolve => { finish = resolve })
  })
  Object.assign(f.api, {
    listHosts: vi.fn(async () => [{ alias: 'fixture', host: '127.0.0.1', port: 22, user: 'me', auth: 'key', tags: [], updatedAt: 1 }]),
    clusterStream: cluster,
  })
  await act(async () => f.layout.selectPanel('ssh-ops'))
  await act(async () => f.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[4]!.click())
  const command = f.container.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(command, 'printf once')
    command.dispatchEvent(new Event('input', { bubbles: true }))
    const aliases = [...f.container.querySelectorAll('label')].find(row => row.querySelector('span')?.textContent === 'Target hosts')!.querySelector('input')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(aliases, 'fixture')
    aliases.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const button = (name: string) => [...f.container.querySelectorAll('button')].find(row => row.textContent === name)!
  await act(async () => button('Review and run').click())
  await act(async () => button('Run on 1 host').click())
  await act(async () => report({ type: 'state', alias: 'fixture', state: 'running' }))
  await act(async () => f.layout.selectPanel('plugins'))
  expect(signal.aborted).toBe(false)
  await act(async () => {
    report({ type: 'output', alias: 'fixture', stream: 'stdout', data: 'while-hidden' })
    f.layout.selectPanel('ssh-ops')
  })
  expect(cluster).toHaveBeenCalledOnce()
  expect(signal.aborted).toBe(false)
  expect(f.container.textContent).toContain('while-hidden')
  await act(async () => { report({ type: 'complete', cancelled: false }); finish([]) })
})

it('leaves old shells to the existing mount without claiming native slots', () => {
  const register = vi.fn()
  const ctx = { get: () => undefined, slots: { register } } as unknown as Pick<Context, 'get' | 'slots'>
  expect(mountNativeSshPanel(ctx, new PanelController(), {} as SshApi)).toBeUndefined()
  expect(register).not.toHaveBeenCalled()
})
