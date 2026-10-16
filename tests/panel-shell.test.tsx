// @vitest-environment jsdom
/**
 * L2 semantic attributes of the SSH panel (issue #506): the mounted panel
 * container and the tab bar opt into the semantic-attrs/v1 enum
 * (data-dsh-plugin / data-dsh-part) so skins can target them without
 * hash-class selectors.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountPanel } from '../src/client/mount.tsx'
import { SshPanel } from '../src/client/panel/SshPanel.tsx'
import type { SshApi, TerminalConnection } from '../src/client/api.ts'
import { PanelController } from '../src/client/panel/controller.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
window.matchMedia ??= () => ({ matches: false, addListener() {}, removeListener() {},
  addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
}) as unknown as MediaQueryList

const roots: Root[] = []
let disposeMount: (() => void) | undefined

afterEach(() => {
  act(() => { disposeMount?.() })
  disposeMount = undefined
  for (const root of roots.splice(0)) {
    act(() => { root.unmount() })
  }
  document.body.replaceChildren()
  document.documentElement.removeAttribute('data-dsh-ssh-active')
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function fakeApi(): SshApi {
  return {
    listTerminals: vi.fn(async () => []),
    removeTerminal: vi.fn(async () => undefined),
    listHosts: vi.fn(async () => []),
  } as unknown as SshApi
}

function fakeController(): PanelController {
  return {
    getSnapshot: () => ({ panelOpen: true }),
    subscribe: () => () => {},
    close: () => {},
  } as unknown as PanelController
}

describe('SshPanel L2 semantic attributes (#506)', () => {
  it('reveals the selected tab after shrinking, scrolls only its tab strip and leaves focus alone', async () => {
    const callbacks: Array<() => void> = [], disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { callbacks.push(callback) } observe() {} disconnect = disconnect })
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container); roots.push(root)
    await act(async () => root.render(<SshPanel controller={fakeController()} api={fakeApi()} />))
    const bar = container.querySelector<HTMLElement>('[role="tablist"]')!, tabs = bar.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    let width = 500
    Object.defineProperty(bar, 'clientWidth', { get: () => width })
    vi.spyOn(bar, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, width }) as DOMRect)
    for (let index = 0; index < tabs.length; index++) vi.spyOn(tabs[index]!, 'getBoundingClientRect').mockImplementation(() => ({ left: index * 100 - bar.scrollLeft, width: 100 }) as DOMRect)
    await act(async () => tabs[4]!.click()); expect(bar.scrollLeft).toBe(0)
    const elsewhere = document.createElement('button'); document.body.append(elsewhere); elsewhere.focus()
    width = 200; await act(async () => callbacks.at(-1)!())
    expect(bar.scrollLeft).toBe(300); expect(document.activeElement).toBe(elsewhere); expect(container.scrollTop).toBe(0)
    await act(async () => tabs[0]!.click()); expect(bar.scrollLeft).toBe(0)
    await act(async () => root.unmount()); expect(disconnect).toHaveBeenCalled()
  })
  it('refreshes choices when returning to a visited tab without resetting its draft', async () => {
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container); roots.push(root)
    let aliases = ['first']
    const api = { listTerminals: vi.fn(async () => []), removeTerminal: vi.fn(async () => undefined), listHosts: vi.fn(async () => aliases.map(alias => ({ alias, host: '127.0.0.1', port: 22, user: 'me', auth: 'key', tags: [] }))),
      listTunnels: vi.fn(async () => []) } as unknown as SshApi
    await act(async () => root.render(<SshPanel controller={fakeController()} api={api} />))
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    for (const index of [1, 2, 3]) await act(async () => tabs[index]!.click())
    await act(async () => tabs[0]!.click())
    aliases = ['first', 'newly-added']
    for (const [index, pane] of [[1, 'terminal'], [2, 'transfer'], [3, 'tunnels']] as const) {
      await act(async () => tabs[index]!.click())
      expect([...container.querySelectorAll<HTMLOptionElement>(`#ssh-pane-${pane} option`)].some(option => option.value === 'newly-added')).toBe(true)
    }
    await act(async () => tabs[0]!.click())
    expect(container.querySelector('#ssh-pane-hosts')?.textContent).toContain('newly-added')
  })

  it('keeps a connected terminal and command drafts across tab navigation, closing only on disposal', async () => {
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container); roots.push(root)
    const close = vi.fn()
    const connection = { close, resize: vi.fn(), send: vi.fn() } as unknown as TerminalConnection
    const openTerminal = vi.fn(() => connection)
    const api = { listTerminals: vi.fn(async () => []), removeTerminal: vi.fn(async () => undefined), listHosts: vi.fn(async () => [{ alias: 'fixture', host: '127.0.0.1', port: 22, user: 'me', auth: 'key', tags: [] }]), openTerminal } as unknown as SshApi
    await act(async () => root.render(<SshPanel controller={fakeController()} api={api} />))
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    await act(async () => tabs[1]!.click())
    const host = container.querySelector<HTMLSelectElement>('#ssh-pane-terminal select')!
    await act(async () => { host.value = 'fixture'; host.dispatchEvent(new Event('change', { bubbles: true })) })
    const connect = container.querySelector<HTMLButtonElement>('#ssh-pane-terminal button')!
    await act(async () => connect.click())
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    await act(async () => connection.onReady?.())
    expect(host.disabled).toBe(false)
    expect(container.querySelectorAll('#ssh-pane-terminal [role="tab"]')).toHaveLength(1)
    await act(async () => tabs[4]!.click())
    const draft = container.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(draft, 'echo keep-draft')
      draft.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => tabs[1]!.click())
    expect(container.querySelector('#ssh-pane-terminal')?.hasAttribute('hidden')).toBe(false)
    expect(close).not.toHaveBeenCalled()
    expect(openTerminal).toHaveBeenCalledTimes(1)
    await act(async () => tabs[4]!.click())
    expect(container.querySelector('textarea')?.value).toBe('echo keep-draft')
    await act(async () => root.unmount())
    roots.splice(roots.indexOf(root), 1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('tags the tab bar as the tab-bar part', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<SshPanel controller={fakeController()} api={fakeApi()} />) })

    const tabBar = container.querySelector('[role="tablist"]')
    expect(tabBar).not.toBeNull()
    expect(tabBar!.getAttribute('data-dsh-part')).toBe('tab-bar')
  })

  it('tags the panel root with the ssh plugin marker', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<SshPanel controller={fakeController()} api={fakeApi()} />) })

    const panel = container.querySelector('[data-dsh-plugin="ssh"]')
    expect(panel).not.toBeNull()
  })

  it('tags every tab button as the tab part', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<SshPanel controller={fakeController()} api={fakeApi()} />) })

    const tabs = container.querySelectorAll('[role="tab"]')
    expect(tabs.length).toBe(5)
    for (const tab of tabs) {
      expect(tab.getAttribute('data-dsh-part')).toBe('tab')
    }
  })

  it('tags the back-to-conversation button with a stable center-view hook', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<SshPanel controller={fakeController()} api={fakeApi()} />) })

    const back = container.querySelector('[data-dsh-center-view-back=""]')
    expect(back).not.toBeNull()
    expect(back?.tagName).toBe('BUTTON')
  })
})

describe('mountPanel L2 semantic attributes (#506)', () => {
  it('tags the injected panel container with data-dsh-plugin', async () => {
    const column = document.createElement('div')
    column.setAttribute('data-pane', 'conversation')
    document.body.appendChild(column)

    await act(async () => { disposeMount = mountPanel(fakeController(), fakeApi()) })

    const view = column.querySelector('[data-dsh-ssh-view]')
    expect(view).not.toBeNull()
    expect(view!.getAttribute('data-dsh-plugin')).toBe('ssh')
  })

  it('defers initial host reads and pauses tunnel polling without losing the selected tab', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<main data-pane="conversation"></main>'
    const controller = new PanelController()
    const listHosts = vi.fn(async () => [])
    const listTunnels = vi.fn(async () => [])
    const api = { listHosts, listTunnels } as unknown as SshApi
    await act(async () => { disposeMount = mountPanel(controller, api) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(listHosts).not.toHaveBeenCalled()
    expect(document.querySelector('[role="tablist"]')).toBeNull()

    await act(async () => { controller.open() })
    expect(listHosts).toHaveBeenCalled()
    const tunnels = document.querySelectorAll<HTMLButtonElement>('[role="tab"]')[3]
    await act(async () => { tunnels.click() })
    expect(listTunnels).toHaveBeenCalledOnce()
    await act(async () => { controller.close() })
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(listTunnels).toHaveBeenCalledOnce()
    await act(async () => { controller.open() })
    expect(document.querySelectorAll('[role="tab"]')[3]).toBe(tunnels)
    expect(tunnels.getAttribute('aria-selected')).toBe('true')
    expect(listTunnels).toHaveBeenCalledTimes(2)
  })
})
