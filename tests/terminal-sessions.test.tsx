// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshApi, TerminalConnection } from '../src/client/api.ts'

const { terminals, renderer } = vi.hoisted(() => ({ renderer: { deferred: false, callbacks: [] as Array<() => void>, size: { cols: 80, rows: 24 } }, terminals: [] as Array<{
  options: Record<string, unknown>; output: string[]; dispose: ReturnType<typeof vi.fn>
  input?: (value: string) => void; inputDispose: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>
  cols: number; rows: number
}> }))
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  options: Record<string, unknown>; output: string[] = []; cols = 80; rows = 24
  dispose = vi.fn(); inputDispose = vi.fn(); focus = vi.fn(); input?: (value: string) => void
  constructor(options: Record<string, unknown>) { this.options = { ...options }; terminals.push(this) }
  loadAddon() {} open() {} resize(cols: number, rows: number) { this.cols = cols; this.rows = rows }
  write(value: string, callback?: () => void) { this.output.push(value); if (callback) { if (renderer.deferred) renderer.callbacks.push(callback); else callback() } }
  onData(callback: (value: string) => void) { this.input = callback; return { dispose: this.inputDispose } }
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} proposeDimensions() { return renderer.size } } }))
import { TerminalCatalogUnsupportedError } from '../src/client/api.ts'
import { TerminalSessions } from '../src/client/panel/TerminalSessions.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
beforeEach(() => { document.documentElement.lang = 'en'; sessionStorage.clear(); renderer.deferred = false; renderer.callbacks = []; renderer.size = { cols: 80, rows: 24 } })
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount() })
  terminals.length = 0; document.body.replaceChildren(); document.documentElement.removeAttribute('lang')
})

function fixture() {
  const connections: Array<TerminalConnection & { alias: string; close: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> }> = []
  const openTerminal = vi.fn((alias: string, _cols?: number, _rows?: number, _cwd?: string, _version?: number, _persistent?: { owner: string; id: string; attach: boolean }) => {
    const connection = { alias, onReady: undefined, onOutput: undefined, onExit: undefined, onAuthPrompt: undefined,
      close: vi.fn(), resize: vi.fn(), send: vi.fn(), sendAuthResponse: vi.fn() }
    connections.push(connection)
    return connection
  })
  const api = { openTerminal, listTerminals: vi.fn(async () => []), removeTerminal: vi.fn(async () => undefined), listHosts: vi.fn(async () => ['alpha', 'beta'].map(alias => ({
    alias, host: '127.0.0.1', port: 22, user: 'fixture', auth: 'key', tags: [],
  }))) } as unknown as SshApi
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); roots.push(root)
  return { root, element, api, connections, openTerminal }
}
const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
function button(element: Element, label: string): HTMLButtonElement {
  const found = [...element.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)
  if (!found) throw new Error(`Button absent: ${label}`)
  return found
}
async function create(element: Element, alias: string) {
  if (!element.querySelector('select')) await act(async () => button(element, 'New terminal').click())
  const picker = element.querySelector('select')!
  await act(async () => { picker.value = alias; picker.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => element.querySelector<HTMLFormElement>('form[aria-label="New terminal"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await settle()
}

describe('independent terminal sessions', () => {
  it('opens a creation form without dispatch and restores focus when cancelled', async () => {
    const f = fixture()
    await act(async () => f.root.render(<TerminalSessions api={f.api} />)); await create(f.element, 'alpha')
    expect(f.element.querySelector('select')).toBeNull()
    const add = button(f.element, 'New terminal')
    await act(async () => add.click())
    const picker = f.element.querySelector<HTMLSelectElement>('select')!
    expect(picker.value).toBe('alpha'); expect(document.activeElement).toBe(picker)
    expect(f.openTerminal).toHaveBeenCalledOnce()
    await act(async () => f.connections[0]!.onReady?.())
    expect(document.activeElement).toBe(picker); expect(terminals[0]!.focus).not.toHaveBeenCalled()
    await act(async () => picker.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(f.element.querySelector('select')).toBeNull(); expect(document.activeElement).toBe(add)
    await act(async () => add.click())
    await act(async () => button(f.element, 'Cancel new terminal').click())
    expect(f.element.querySelector('select')).toBeNull(); expect(document.activeElement).toBe(add)
    await create(f.element, 'beta')
    expect(f.openTerminal).toHaveBeenCalledTimes(2); expect(f.connections[0]!.close).not.toHaveBeenCalled()
  })

  it('focuses the host picker after the last terminal has been closed', async () => {
    const f = fixture()
    await act(async () => f.root.render(<TerminalSessions api={f.api} />)); await create(f.element, 'alpha')
    await act(async () => f.connections[0]!.onReady?.())
    await act(async () => button(f.element, 'Close alpha terminal #1').click())
    await act(async () => { const confirm = button(f.element, 'Close terminal'); confirm.focus(); confirm.click() })
    expect(f.element.querySelectorAll('[role="tab"]')).toHaveLength(0)
    expect(document.activeElement).toBe(f.element.querySelector('select'))
    expect(f.api.removeTerminal).toHaveBeenCalledOnce(); expect(f.connections[0]!.close).toHaveBeenCalledOnce()
  })

  it('returns owned authentication focus to the terminal on readiness', async () => {
    const f = fixture()
    await act(async () => f.root.render(<TerminalSessions api={f.api} />)); await create(f.element, 'alpha')
    await act(async () => f.connections[0]!.onAuthPrompt?.('Verify alpha', 'Enter code', [{ prompt: 'Code', echo: false }]))
    expect(document.activeElement).toBe(f.element.querySelector('input[type="password"]'))
    await act(async () => f.connections[0]!.onReady?.())
    expect(terminals[0]!.focus).toHaveBeenCalledOnce(); expect(terminals[0]!.options.disableStdin).toBe(false)
    expect(f.element.querySelector('[role="dialog"]')).toBeNull()
  })

  it('preserves outputs, resizes only the visible shell and closes only the confirmed terminal', async () => {
    const { root, element, api, connections, openTerminal } = fixture()
    await act(async () => root.render(<TerminalSessions api={api} />))
    await create(element, 'alpha'); await act(async () => connections[0]!.onReady?.())
    await act(async () => connections[0]!.onOutput?.('ALPHA retained'))
    await create(element, 'beta'); await act(async () => connections[1]!.onReady?.())
    await act(async () => connections[1]!.onOutput?.('BETA retained'))
    expect(connections[0]!.close).not.toHaveBeenCalled()
    const [alpha, beta] = element.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    const firstResizes = connections[0]!.resize.mock.calls.length
    const secondResizes = connections[1]!.resize.mock.calls.length
    await act(async () => window.dispatchEvent(new Event('resize')))
    expect(connections[0]!.resize).toHaveBeenCalledTimes(firstResizes)
    expect(connections[1]!.resize.mock.calls.length).toBeGreaterThan(secondResizes)
    await act(async () => alpha!.click())
    expect(terminals[0]!.output).toEqual(['ALPHA retained'])
    await act(async () => beta!.click())
    expect(terminals[1]!.output).toEqual(['BETA retained'])
    expect(openTerminal).toHaveBeenCalledTimes(2)
    await act(async () => button(element, 'Close beta terminal #2').click())
    expect(element.querySelector('[role="alertdialog"]')).not.toBeNull()
    expect(connections[1]!.close).not.toHaveBeenCalled()
    await act(async () => button(element, 'Close terminal').click())
    expect(connections[1]!.close).toHaveBeenCalledOnce()
    expect(connections[0]!.close).not.toHaveBeenCalled()
    expect(terminals[1]!.dispose).toHaveBeenCalledOnce()
    await act(async () => button(element, 'Disconnect').click())
    expect(connections[0]!.close).toHaveBeenCalledOnce()
    expect(terminals[0]!.dispose).not.toHaveBeenCalled()
    expect(terminals[0]!.output).toEqual(['ALPHA retained'])
    expect(terminals[0]!.options.disableStdin).toBe(true)
    expect(element.textContent).toContain('Disconnected; output kept')
    terminals[0]!.input?.('echo stale-input')
    expect(connections[0]!.send).not.toHaveBeenCalled()
  })

  it('handles host requests once, reuses live shells and creates fresh shells after exit without replay', async () => {
    const { root, element, api, connections, openTerminal } = fixture()
    await act(async () => root.render(<TerminalSessions api={api} presetAlias="alpha" requestId={1} />)); await settle()
    await act(async () => connections[0]!.onReady?.())
    await act(async () => root.render(<TerminalSessions api={api} presetAlias="alpha" requestId={2} />)); await settle()
    expect(openTerminal).toHaveBeenCalledTimes(1)
    await act(async () => root.render(<TerminalSessions api={api} presetAlias="beta" requestId={3} />)); await settle()
    expect(openTerminal).toHaveBeenCalledTimes(2)
    expect(element.querySelectorAll('[role="tab"]')).toHaveLength(2)
    await act(async () => connections[0]!.onExit?.(0))
    await act(async () => root.render(<TerminalSessions api={api} presetAlias="alpha" requestId={4} />)); await settle()
    expect(openTerminal).toHaveBeenCalledTimes(3)
    expect(element.querySelectorAll('[role="tab"]')).toHaveLength(3)
    expect(connections[0]!.send).not.toHaveBeenCalled()
    expect(connections[1]!.close).not.toHaveBeenCalled()
  })

  it('does not dispatch twice under StrictMode or reconnect after an error', async () => {
    const { root, element, api, connections, openTerminal } = fixture()
    const tree = <StrictMode><TerminalSessions api={api} presetAlias="alpha" requestId={1} /></StrictMode>
    await act(async () => root.render(tree)); await settle()
    expect(openTerminal).toHaveBeenCalledOnce()
    await act(async () => connections[0]!.onExit?.(null, 'Connection refused'))
    await act(async () => root.render(tree)); await settle()
    expect(element.textContent).toContain('Failed')
    expect(element.textContent).toContain('Connection refused')
    expect(openTerminal).toHaveBeenCalledOnce()
  })

  it('supports roving keyboard selection and cancellation of closing an active shell', async () => {
    const { root, element, api, connections } = fixture()
    await act(async () => root.render(<TerminalSessions api={api} />))
    await create(element, 'alpha'); await create(element, 'beta')
    await act(async () => { connections[0]!.onReady?.(); connections[1]!.onReady?.() })
    const [alpha, beta] = element.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    await act(async () => { beta!.focus(); beta!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
    expect(document.activeElement).toBe(alpha)
    expect(alpha!.getAttribute('aria-selected')).toBe('true')
    expect(beta!.tabIndex).toBe(-1)
    await act(async () => button(element, 'Close alpha terminal #1').click())
    await act(async () => element.querySelector('[role="alertdialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(element.querySelector('[role="alertdialog"]')).toBeNull()
    expect(document.activeElement).toBe(alpha)
    expect(connections[0]!.close).not.toHaveBeenCalled()
    expect(connections[1]!.close).not.toHaveBeenCalled()
  })

  it('does not steal focus for a background authentication challenge or shell readiness', async () => {
    const { root, element, api, connections } = fixture()
    await act(async () => root.render(<TerminalSessions api={api} />))
    await create(element, 'alpha'); await create(element, 'beta')
    const [alpha, beta] = element.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    await act(async () => beta!.focus())
    await act(async () => connections[0]!.onAuthPrompt?.('Verify alpha', 'Enter token', [{ prompt: 'Code', echo: false }]))
    expect(document.activeElement).toBe(beta)
    expect(alpha!.textContent).toContain('Verification needed')
    await act(async () => alpha!.click())
    expect(document.activeElement?.tagName).toBe('INPUT')
    await act(async () => beta!.click())
    await act(async () => connections[0]!.onReady?.())
    expect(terminals[0]!.focus).not.toHaveBeenCalled()
  })

  it('contains a synchronous connection error and disposes the failed renderer', async () => {
    const { root, element, api, openTerminal } = fixture()
    openTerminal.mockImplementationOnce(() => { throw new Error('WebSocket unavailable') })
    await act(async () => root.render(<TerminalSessions api={api} />))
    await create(element, 'alpha')
    expect(element.textContent).toContain('WebSocket unavailable')
    expect(element.textContent).toContain('Failed')
    expect(terminals[0]!.dispose).toHaveBeenCalledOnce()
    await create(element, 'beta')
    expect(openTerminal).toHaveBeenCalledTimes(2)
  })

  it('retains the server identity after a config edit and opens a new shell for the changed host', async () => {
    const f = fixture()
    let version = 1
    vi.mocked(f.api.listHosts).mockImplementation(async () => [{ alias: 'alpha', user: 'original-user', host: '127.0.0.1', port: version === 1 ? 22 : 2222, updatedAt: version } as never])
    await act(async () => f.root.render(<TerminalSessions api={f.api} presetAlias="alpha" requestId={1} />)); await settle()
    await act(async () => { f.connections[0]!.onTarget?.({ alias: 'alpha', user: 'original-user', host: '127.0.0.1', port: 22, updatedAt: 1 }); f.connections[0]!.onReady?.() })
    version = 2
    await act(async () => f.root.render(<TerminalSessions api={f.api} visible={false} presetAlias="alpha" requestId={1} />))
    await act(async () => f.root.render(<TerminalSessions api={f.api} presetAlias="alpha" requestId={1} />)); await settle()
    expect(f.element.textContent).toContain('original-user@127.0.0.1:22')
    expect(f.element.textContent).toContain('Host configuration changed')
    expect(f.openTerminal).toHaveBeenCalledTimes(1); expect(f.connections[0]!.close).not.toHaveBeenCalled()
    await act(async () => f.root.render(<TerminalSessions api={f.api} presetAlias="alpha" requestId={2} />)); await settle()
    expect(f.openTerminal).toHaveBeenCalledTimes(2)
    expect(f.openTerminal.mock.calls[1]).toEqual(['alpha', 80, 24, undefined, 2, expect.objectContaining({ attach: false })])
    expect(f.element.querySelectorAll('[role="tab"]')).toHaveLength(2)
    expect(f.connections[0]!.close).not.toHaveBeenCalled()
  })

  it('focuses a reused host request without stealing focus on ordinary keyboard tab selection', async () => {
    const f = fixture()
    await act(async () => f.root.render(<TerminalSessions api={f.api} presetAlias="alpha" requestId={1} />)); await settle()
    await act(async () => f.connections[0]!.onReady?.())
    terminals[0]!.focus.mockClear()
    await act(async () => f.root.render(<TerminalSessions api={f.api} presetAlias="alpha" requestId={2} />)); await settle()
    expect(terminals[0]!.focus).toHaveBeenCalledOnce()
    await create(f.element, 'beta'); await act(async () => f.connections[1]!.onReady?.())
    const tabs = f.element.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    terminals[0]!.focus.mockClear()
    await act(async () => { tabs[1]!.focus(); tabs[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
    expect(document.activeElement).toBe(tabs[0]); expect(terminals[0]!.focus).not.toHaveBeenCalled()
  })

  it('traps auth focus and Escape cancels only that connecting session', async () => {
    const f = fixture()
    await act(async () => f.root.render(<TerminalSessions api={f.api} />)); await create(f.element, 'alpha')
    expect(terminals[0]!.options.disableStdin).toBe(true)
    await act(async () => f.connections[0]!.onAuthPrompt?.('Verify fixture', 'Enter response', [{ prompt: 'Password:', echo: false }], { alias: 'jump', host: 'jump.test', user: 'jump-user', port: 2222, updatedAt: 1 }))
    const input = f.element.querySelector<HTMLInputElement>('input[type="password"]')!, form = f.element.querySelector('form')!
    expect(f.element.textContent).toContain('jump-user@jump.test:2222')
    await act(async () => { input.focus(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })) })
    expect(document.activeElement?.textContent).toBe('Continue verification')
    await act(async () => form.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(f.connections[0]!.close).toHaveBeenCalledOnce()
    expect(f.element.querySelector('form')).toBeNull()
    expect(document.activeElement?.textContent).toBe('New terminal')
    expect(f.connections[0]!.sendAuthResponse).not.toHaveBeenCalled()
    expect(terminals[0]!.options.disableStdin).toBe(true)
  })

  it('never opens a removed alias from a host request', async () => {
    const f = fixture()
    await act(async () => f.root.render(<TerminalSessions api={f.api} presetAlias="removed" requestId={1} />)); await settle()
    expect(f.openTerminal).not.toHaveBeenCalled()
    expect(f.element.textContent).toContain('not configured or was removed')
  })
})


describe('browser terminal restoration', () => {
  const target = { alias: 'alpha', user: 'fixture', host: '127.0.0.1', port: 22, updatedAt: 1 }
  const receipt = { id: 'restored-session-123456', number: 7, target, phase: 'connected' as const, cols: 80, rows: 24, createdAt: 1, truncated: false }
  it('keeps input disabled and only detaches on incompatible continuation data, even with ready already queued', async () => {
    const f = fixture(); vi.mocked(f.api.listTerminals).mockResolvedValue([receipt])
    await act(async () => f.root.render(<TerminalSessions api={f.api} />)); await settle()
    const connection = f.connections[0]!, terminal = terminals[0]!
    connection.stop = vi.fn()
    renderer.deferred = true
    const invalid = { version: 99 } as unknown as import('../src/terminal-continuity.ts').TerminalContinuityState
    await act(async () => { connection.onSnapshot?.(receipt, 'retained grid', 'state-v1', invalid); connection.onReady?.() })
    terminal.input?.('during restore'); expect(connection.send).not.toHaveBeenCalled()
    await act(async () => renderer.callbacks.shift()!())
    expect(connection.close).toHaveBeenCalledOnce(); expect(connection.stop).not.toHaveBeenCalled()
    expect(terminal.options.disableStdin).toBe(true); expect(terminal.dispose).not.toHaveBeenCalled()
    expect(f.element.textContent).toContain('display restoration failed')
    expect(f.element.textContent).not.toContain('Original shell and output restored.')
    terminal.input?.('blind input'); expect(connection.send).not.toHaveBeenCalled(); expect(f.openTerminal).toHaveBeenCalledOnce()
    await act(async () => button(f.element, 'Resume terminal').click())
    expect(f.openTerminal).toHaveBeenCalledTimes(2)
    expect(f.openTerminal.mock.calls[1]?.[5]).toMatchObject({ id: receipt.id, attach: true })
  })
  it('keeps a restored grid and rejects input when the viewport is too small, then resumes without replay', async () => {
    const f = fixture(); vi.mocked(f.api.listTerminals).mockResolvedValue([receipt])
    renderer.size = { cols: 5, rows: 1 }
    await act(async () => f.root.render(<TerminalSessions api={f.api} />)); await settle()
    const connection = f.connections[0]!, terminal = terminals[0]!
    expect(f.openTerminal.mock.calls[0]!.slice(1, 3)).toEqual([80, 24])
    renderer.deferred = true
    await act(async () => { connection.onSnapshot?.(receipt, 'original grid', 'state-v1'); connection.onReady?.() })
    terminal.input?.('during restore')
    await act(async () => renderer.callbacks.shift()!())
    expect([terminal.cols, terminal.rows]).toEqual([80, 24]); expect(connection.resize).not.toHaveBeenCalled()
    expect(terminal.options.disableStdin).toBe(true); expect(terminal.focus).not.toHaveBeenCalled()
    expect(f.element.textContent).toContain('input is paused')
    terminal.input?.('blind command'); expect(connection.send).not.toHaveBeenCalled()
    renderer.size = { cols: 34, rows: 21 }
    await act(async () => window.dispatchEvent(new Event('resize')))
    expect(connection.resize).toHaveBeenCalledExactlyOnceWith(34, 21)
    await act(async () => connection.onResized?.(34, 21))
    expect([terminal.cols, terminal.rows]).toEqual([34, 21]); expect(terminal.options.disableStdin).toBe(false)
    expect(f.element.textContent).not.toContain('input is paused')
    terminal.input?.('deliberate command'); expect(connection.send).toHaveBeenCalledExactlyOnceWith('deliberate command')
    expect(f.openTerminal).toHaveBeenCalledOnce(); expect(connection.close).not.toHaveBeenCalled()
  })

  it.each([{ cols: 23, rows: 24 }, { cols: 80, rows: 7 }])('never sends an unusable resize after readiness: %j', async size => {
    const f = fixture(); vi.mocked(f.api.listTerminals).mockResolvedValue([receipt])
    await act(async () => f.root.render(<TerminalSessions api={f.api} />)); await settle()
    const connection = f.connections[0]!, terminal = terminals[0]!
    await act(async () => { connection.onSnapshot?.(receipt, 'original', 'state-v1'); connection.onReady?.() })
    renderer.size = size
    await act(async () => window.dispatchEvent(new Event('resize')))
    expect(connection.resize).not.toHaveBeenCalled(); expect([terminal.cols, terminal.rows]).toEqual([80, 24])
    terminal.input?.('discard me'); expect(connection.send).not.toHaveBeenCalled()
    renderer.size = { cols: 24, rows: 8 }
    await act(async () => window.dispatchEvent(new Event('resize')))
    await act(async () => connection.onResized?.(24, 8))
    expect(connection.resize).toHaveBeenCalledExactlyOnceWith(24, 8); expect(terminal.options.disableStdin).toBe(false)
    terminal.input?.('keep me'); expect(connection.send).toHaveBeenCalledExactlyOnceWith('keep me')
  })

  it('restores at the recorded width and waits for applied output before acknowledged resize and redraw', async () => {
    const f = fixture(); vi.mocked(f.api.listTerminals).mockResolvedValue([receipt])
    await act(async () => f.root.render(<TerminalSessions api={f.api} />)); await settle()
    renderer.deferred = true; renderer.size = { cols: 32, rows: 20 }
    const connection = f.connections[0]!, terminal = terminals[0]!
    await act(async () => { connection.onSnapshot?.(receipt, 'recorded screen', 'state-v1'); connection.onReady?.() })
    expect(terminal.cols).toBe(80); expect(terminal.output).toEqual(['recorded screen'])
    expect(connection.resize).not.toHaveBeenCalled(); expect(terminal.options.disableStdin).toBe(true)
    await act(async () => renderer.callbacks.shift()!())
    expect(connection.resize).toHaveBeenCalledExactlyOnceWith(32, 20); expect(terminal.cols).toBe(80)
    expect(terminal.options.disableStdin).toBe(false)
    await act(async () => { connection.onOutput?.('old-width output'); connection.onResized?.(32, 20); connection.onOutput?.('new-width redraw') })
    expect(terminal.cols).toBe(80); expect(terminal.output).toEqual(['recorded screen', 'old-width output'])
    await act(async () => renderer.callbacks.shift()!())
    expect(terminal.cols).toBe(32); expect(terminal.rows).toBe(20)
    expect(terminal.output).toEqual(['recorded screen', 'old-width output', 'new-width redraw'])
    await act(async () => { window.dispatchEvent(new Event('resize')); connection.onExit?.(0) })
    expect(connection.resize).toHaveBeenCalledOnce(); expect(terminal.options.disableStdin).toBe(false)
    await act(async () => renderer.callbacks.shift()!())
    expect(terminal.options.disableStdin).toBe(true); expect(f.openTerminal).toHaveBeenCalledOnce()
    expect(connection.send).not.toHaveBeenCalled()
  })
  it('restores the active pane and snapshot without creating another shell or sending prior input', async () => {
    const f = fixture()
    vi.mocked(f.api.listTerminals).mockResolvedValue([receipt, { ...receipt, id: 'other-session-1234567', number: 8, target: { ...target, alias: 'beta' } }])
    sessionStorage.setItem('dsh-ssh:terminal-active:v1', 'other-session-1234567')
    await act(async () => f.root.render(<TerminalSessions api={f.api} />)); await settle()
    expect(f.element.querySelector('[aria-selected="true"]')!.textContent).toContain('beta')
    for (const call of f.openTerminal.mock.calls) expect(call[5]).toMatchObject({ attach: true })
    await act(async () => { f.connections[0]!.onSnapshot?.(receipt, 'retained output'); f.connections[0]!.onReady?.() })
    expect(terminals[0]!.output).toEqual(['retained output'])
    expect(f.connections[0]!.send).not.toHaveBeenCalled()
    await act(async () => f.root.unmount())
    roots.splice(roots.indexOf(f.root), 1)
    expect(f.api.removeTerminal).not.toHaveBeenCalled()
    expect(f.connections[0]!.close).toHaveBeenCalledOnce()
  })
  it('lets a removed host resume its original shell, but never starts a fresh connection for it', async () => {
    const f = fixture(); vi.mocked(f.api.listTerminals).mockResolvedValue([receipt]); vi.mocked(f.api.listHosts).mockResolvedValue([])
    await act(async () => f.root.render(<TerminalSessions api={f.api} />)); await settle()
    await act(async () => { f.connections[0]!.onSnapshot?.(receipt, 'original'); f.connections[0]!.onReady?.(); f.connections[0]!.onDetached?.('connection closed') })
    expect(button(f.element, 'Resume terminal').disabled).toBe(false)
    expect(f.element.textContent).toContain('Host removed')
    await act(async () => button(f.element, 'Resume terminal').click())
    expect(f.openTerminal.mock.calls[1]![5]).toMatchObject({ id: receipt.id, attach: true })
    await act(async () => f.connections[1]!.onExit?.(null, 'session unavailable'))
    expect([...f.element.querySelectorAll<HTMLButtonElement>('button')].filter(item => item.textContent === 'New terminal').every(item => item.disabled)).toBe(true)
    expect(f.openTerminal).toHaveBeenCalledTimes(2)
  })
  it('does not retry a missing restored session, and keeps a pane when its explicit close fails', async () => {
    const f = fixture(); vi.mocked(f.api.listTerminals).mockResolvedValue([receipt])
    await act(async () => f.root.render(<TerminalSessions api={f.api} />)); await settle()
    await act(async () => f.connections[0]!.onExit?.(null, 'session unavailable'))
    await settle(); expect(f.openTerminal).toHaveBeenCalledOnce()
    vi.mocked(f.api.removeTerminal).mockRejectedValue(new Error('close not confirmed'))
    await act(async () => button(f.element, 'Close alpha terminal #7').click())
    expect(f.element.textContent).toContain('close not confirmed')
    expect(f.element.querySelectorAll('[role="tab"]')).toHaveLength(1)
  })
  it('confirms closing a disconnected view because its remote shell may still be live', async () => {
    const f = fixture(); vi.mocked(f.api.listTerminals).mockResolvedValue([receipt])
    await act(async () => f.root.render(<TerminalSessions api={f.api} />)); await settle()
    await act(async () => { f.connections[0]!.onSnapshot?.(receipt, 'original'); f.connections[0]!.onReady?.(); f.connections[0]!.onDetached?.('replaced') })
    await act(async () => button(f.element, 'Close alpha terminal #7').click())
    expect(f.element.querySelector('[role="alertdialog"]')).not.toBeNull()
    expect(f.api.removeTerminal).not.toHaveBeenCalled()
  })
})

it('keeps old host behavior explicit when only the client has hot-reloaded', async () => {
  const f = fixture(); vi.mocked(f.api.listTerminals).mockRejectedValue(new TerminalCatalogUnsupportedError())
  await act(async () => f.root.render(<TerminalSessions api={f.api} />)); await create(f.element, 'alpha')
  expect(f.element.textContent).toContain('page only')
  expect(f.openTerminal.mock.calls[0]![5]).toBeUndefined()
  await act(async () => f.connections[0]!.onReady?.())
  await act(async () => button(f.element, 'Close alpha terminal #1').click())
  await act(async () => button(f.element, 'Close terminal').click())
  expect(f.api.removeTerminal).not.toHaveBeenCalled(); expect(f.connections[0]!.close).toHaveBeenCalledOnce()
})
it('protects the legacy terminal grid without creating a replacement shell', async () => {
  const f = fixture(); vi.mocked(f.api.listTerminals).mockRejectedValue(new TerminalCatalogUnsupportedError())
  await act(async () => f.root.render(<TerminalSessions api={f.api} />)); await create(f.element, 'alpha')
  await act(async () => f.connections[0]!.onReady?.())
  const terminal = terminals[0]!, connection = f.connections[0]!
  connection.resize.mockClear(); renderer.size = { cols: 5, rows: 1 }
  await act(async () => window.dispatchEvent(new Event('resize')))
  terminal.input?.('blind input')
  expect([terminal.cols, terminal.rows]).toEqual([80, 24]); expect(connection.resize).not.toHaveBeenCalled()
  expect(connection.send).not.toHaveBeenCalled(); expect(terminal.options.disableStdin).toBe(true)
  renderer.size = { cols: 32, rows: 20 }
  await act(async () => window.dispatchEvent(new Event('resize')))
  expect([terminal.cols, terminal.rows]).toEqual([32, 20]); expect(connection.resize).toHaveBeenCalledExactlyOnceWith(32, 20)
  expect(terminal.options.disableStdin).toBe(false); expect(f.openTerminal).toHaveBeenCalledOnce()
})
it('does not dispatch while catalog loading fails; a deliberate read retry restores it', async () => {
  const f = fixture(); vi.mocked(f.api.listTerminals).mockRejectedValueOnce(new Error('catalog unavailable'))
  await act(async () => f.root.render(<TerminalSessions api={f.api} />)); await settle()
  await create(f.element, 'alpha'); expect(f.openTerminal).not.toHaveBeenCalled()
  expect(f.element.textContent).toContain('catalog unavailable')
  await act(async () => button(f.element, 'Read terminal list again').click()); await settle()
  await create(f.element, 'alpha'); expect(f.openTerminal).toHaveBeenCalledOnce()
})

it('distinguishes an interrupted receipt from a restored shell and preserves keyboard focus on restored panes', async () => {
  const f = fixture(), target = { alias: 'alpha', user: 'fixture', host: '127.0.0.1', port: 22, updatedAt: 1 }
  const failed = { id: 'failed-session-123456', number: 1, target, phase: 'error' as const, cols: 80, rows: 24, createdAt: 1, truncated: false }
  const ready = { ...failed, id: 'ready-session-1234567', number: 2, target: { ...target, alias: 'beta' }, phase: 'connected' as const }
  vi.mocked(f.api.listTerminals).mockResolvedValue([failed, ready])
  await act(async () => f.root.render(<TerminalSessions api={f.api} />)); await settle()
  await act(async () => { f.connections[0]!.onSnapshot?.(failed, ''); f.connections[0]!.onExit?.(null, 'authentication interrupted'); f.connections[1]!.onSnapshot?.(ready, 'old output'); f.connections[1]!.onReady?.() })
  expect(f.element.textContent).toContain('Last session state restored.')
  expect(f.element.querySelector('[role="tabpanel"]:not([hidden])')?.textContent).not.toContain('Original shell and output restored.')
  const tabs = f.element.querySelectorAll<HTMLButtonElement>('[role="tab"]')
  await act(async () => { tabs[0]!.focus(); tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
  expect(document.activeElement).toBe(tabs[1]); expect(terminals[1]!.focus).not.toHaveBeenCalled()
})

it('does not steal focus if the user moves to another field while closing waits for the server', async () => {
  const f = fixture()
  await act(async () => f.root.render(<TerminalSessions api={f.api} />)); await create(f.element, 'alpha'); await create(f.element, 'beta')
  let finish!: () => void
  vi.mocked(f.api.removeTerminal).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const close = button(f.element, 'Close beta terminal #2')
  await act(async () => { close.focus(); close.click() })
  await act(async () => { const confirm = button(f.element, 'Close terminal'); confirm.focus(); confirm.click() })
  const other = document.createElement('input'); document.body.append(other)
  await act(async () => other.focus())
  await act(async () => { finish(); await Promise.resolve() })
  expect(document.activeElement).toBe(other)
  expect(f.element.querySelectorAll('[role="tab"]')).toHaveLength(1)
})
