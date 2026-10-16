// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ClusterNotStartedError, SshApi } from '../src/client/api.ts'
import { ClusterTab } from '../src/client/panel/ClusterTab.tsx'
import type { ClusterStreamFrame } from '../src/protocol.ts'
import { decodeClusterHistory, encodeClusterHistory, type ClusterHistory, type ClusterRecord } from '../src/client/cluster-history.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
afterEach(() => { act(() => roots.splice(0).forEach(root => root.unmount())); document.body.replaceChildren(); document.documentElement.removeAttribute('lang'); sessionStorage.clear(); vi.unstubAllGlobals() })
const hosts = [
  { alias: 'first', host: '127.0.0.1', port: 22, user: 'me', auth: 'key', tags: ['web', 'safe'], environment: 'test', updatedAt: 1 },
  { alias: 'second', host: '127.0.0.1', port: 23, user: 'me', auth: 'key', tags: ['web'], environment: 'test', updatedAt: 2 },
]
function button(element: Element, name: string) { return [...element.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === name)! }
async function fill(element: Element, label: string, value: string) {
  const field = [...element.querySelectorAll('label')].find(row => row.querySelector('span')?.textContent === label)!.querySelector('input, textarea')! as HTMLInputElement | HTMLTextAreaElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function fixture(history?: ClusterHistory) {
  document.documentElement.lang = 'en'
  const api = new SshApi(); vi.spyOn(api, 'listHosts').mockResolvedValue(hosts as never)
  const element = document.createElement('div'); document.body.appendChild(element)
  const root = createRoot(element); roots.push(root)
  await act(async () => root.render(<ClusterTab api={api} history={history} />))
  await fill(element, 'Command', 'echo first-run'); await fill(element, 'Target hosts', 'first, second')
  return { api, element, root }
}
async function start(element: Element) {
  await act(async () => button(element, 'Review and run').click())
  await act(async () => button(element, 'Run on 2 hosts').click())
}

it('reviews the concrete intersection, restores focus on Escape and never dispatches on cancellation', async () => {
  const { api, element } = await fixture(), call = vi.spyOn(api, 'clusterStream')
  await fill(element, 'Tag filter (comma-separated)', 'web, safe')
  await act(async () => button(element, 'Review and run').click())
  expect(element.querySelector('[role=alertdialog]')?.textContent).toContain('first')
  expect([...element.querySelectorAll('[role=alertdialog] b')].map(row => row.textContent)).toEqual(['first'])
  await act(async () => element.querySelector('[role=alertdialog]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(element.querySelector('[role=alertdialog]')).toBeNull(); expect(document.activeElement).toBe(button(element, 'Review and run'))
  expect(call).not.toHaveBeenCalled()
  await fill(element, 'Target hosts', 'first, missing')
  expect(element.textContent).toContain('Unconfigured aliases: missing')
  expect(button(element, 'Review and run').disabled).toBe(true)
})

it('keeps live partial output and receives authoritative stopped / not-run results through Stop', async () => {
  const { api, element } = await fixture()
  let event: (frame: ClusterStreamFrame) => void, finish: (value: never[]) => void
  vi.spyOn(api, 'clusterStream').mockImplementation((_options, report) => { event = report; return new Promise(resolve => { finish = resolve }) })
  const stop = vi.spyOn(api, 'cancelCluster').mockResolvedValue()
  await start(element)
  await act(async () => {
    event!({ type: 'plan', runId: 'only-this-run', targets: hosts }); event!({ type: 'state', alias: 'first', state: 'running' })
    event!({ type: 'output', alias: 'first', stream: 'stdout', data: 'before-stop' })
  })
  expect(element.textContent).toContain('before-stop'); expect(element.textContent).toContain('Queued')
  await act(async () => button(element, 'Stop execution').click())
  expect(stop).toHaveBeenCalledExactlyOnceWith('only-this-run')
  await act(async () => {
    event!({ type: 'result', result: { alias: 'first', ok: false, cancelled: true, dispatched: true } })
    event!({ type: 'result', result: { alias: 'second', ok: false, cancelled: true, dispatched: false } })
    event!({ type: 'complete', cancelled: true }); finish!([])
  })
  expect(element.textContent).toContain('Stopped waiting'); expect(element.textContent).toContain('Not run')
  expect(element.textContent).toContain('before-stop'); expect(element.textContent).toMatch(/remote termination is not guaranteed/i)
  expect(api.clusterStream).toHaveBeenCalledOnce()
})

it('waits for the operation handle when Stop is requested before the first frame', async () => {
  const { api, element, root } = await fixture()
  let event: (frame: ClusterStreamFrame) => void
  vi.spyOn(api, 'clusterStream').mockImplementation((_options, report) => { event = report; return new Promise(() => {}) })
  const stop = vi.spyOn(api, 'cancelCluster').mockResolvedValue()
  await start(element); await act(async () => button(element, 'Stop execution').click())
  expect(stop).not.toHaveBeenCalled()
  await act(async () => event!({ type: 'plan', runId: 'late-plan', targets: hosts }))
  expect(stop).toHaveBeenCalledExactlyOnceWith('late-plan')
  await act(async () => root.unmount())
})

it('reports verified cancellation during connection without uncertainty and restores the action focus', async () => {
  const { api, element } = await fixture()
  let event: (frame: ClusterStreamFrame) => void, finish: (value: never[]) => void
  vi.spyOn(api, 'clusterStream').mockImplementation((_options, report) => { event = report; return new Promise(resolve => { finish = resolve }) })
  vi.spyOn(api, 'cancelCluster').mockResolvedValue()
  await start(element)
  await act(async () => {
    event!({ type: 'plan', runId: 'held', targets: hosts })
    event!({ type: 'state', alias: 'first', state: 'connecting' })
  })
  await act(async () => button(element, 'Stop execution').click())
  await act(async () => {
    for (const host of hosts) event!({ type: 'result', result: { alias: host.alias, ok: false, cancelled: true, dispatched: false, error: 'connection cancelled' } })
    event!({ type: 'complete', cancelled: true }); finish!([])
  })
  expect(element.textContent).toContain('Cancelled; no commands were run')
  expect(element.textContent).toContain('2/2 host receipts received · 0 need checking')
  expect(element.textContent).not.toMatch(/outcome unknown|termination is not guaranteed/i)
  expect(document.activeElement).toBe(button(element, 'Review and run'))
  expect(api.clusterStream).toHaveBeenCalledOnce()
})

it.each([{ cause: new ClusterNotStartedError('configuration changed; no command was dispatched'), phase: 'Not run' }, { cause: new Error('connection lost; outcome unknown'), phase: 'Outcome unknown' }])('distinguishes pre-dispatch rejection from uncertain response loss', async ({ cause, phase }) => {
  const { api, element } = await fixture(); vi.spyOn(api, 'clusterStream').mockRejectedValue(cause)
  await start(element)
  expect(element.textContent).toContain(phase); expect(element.textContent).toContain(cause.message)
  expect(api.clusterStream).toHaveBeenCalledOnce()
})

it('aborts only its own run on unmount and ignores late callbacks', async () => {
  const { api, element, root } = await fixture()
  let signal: AbortSignal | undefined, event: (frame: ClusterStreamFrame) => void, finish: (value: never[]) => void
  vi.spyOn(api, 'clusterStream').mockImplementation((_options, report, abort) => { signal = abort; event = report; return new Promise(resolve => { finish = resolve }) })
  await start(element); await act(async () => root.unmount())
  expect(signal?.aborted).toBe(true)
  await act(async () => { event!({ type: 'complete', cancelled: false }); finish!([]) })
  expect(element.textContent).toBe('')
})

it('keeps reviewed commands in page history and retains only the latest three runs', async () => {
  const { api, element } = await fixture()
  vi.spyOn(api, 'clusterStream').mockImplementation(async (_options, report) => {
    report({ type: 'plan', runId: 'history-run', targets: hosts })
    for (const host of hosts) report({ type: 'result', result: { alias: host.alias, ok: true, exitCode: 0 } })
    report({ type: 'complete', cancelled: false }); return []
  })
  await start(element); await fill(element, 'Command', 'echo draft-change')
  expect(element.querySelector('pre')?.textContent).toBe('echo first-run')
  for (let index = 0; index < 3; index++) await start(element)
  expect(element.querySelectorAll('select[aria-label="Run history"] option')).toHaveLength(3)
  expect(element.querySelector('select')?.textContent).not.toContain('#1')
  expect(api.clusterStream).toHaveBeenCalledTimes(4)
})

function memory(initial: string | null = null) {
  let raw = initial
  const history: ClusterHistory = { read: vi.fn(() => raw), write: vi.fn(value => { raw = value }), clear: vi.fn(() => { raw = null }) }
  return { history, value: () => raw }
}
it('writes the original scope before dispatch and restores interrupted output without any replay or late mutation', async () => {
  const m = memory(), first = await fixture(m.history)
  let report!: (frame: ClusterStreamFrame) => void, signal!: AbortSignal
  vi.spyOn(first.api, 'clusterStream').mockImplementation((_request, event, stop) => {
    const checkpoint = decodeClusterHistory(m.value()!)
    expect(checkpoint.runs[0]?.request.command).toBe('echo first-run'); expect(checkpoint.runs[0]?.rows).toHaveLength(2)
    report = event; signal = stop!; return new Promise(() => {})
  })
  await start(first.element)
  await act(async () => { report({ type: 'state', alias: 'first', state: 'running' }); report({ type: 'output', alias: 'first', stream: 'stdout', data: 'checkpoint-output\n' }) })
  await act(async () => first.root.unmount()); expect(signal.aborted).toBe(true)
  const saved = m.value(), second = await fixture(m.history), replay = vi.spyOn(second.api, 'clusterStream')
  expect(second.element.textContent).toContain('checkpoint-output'); expect(second.element.textContent).toContain('Original run record restored')
  expect(second.element.querySelectorAll('[data-status="unknown"]')).toHaveLength(2)
  expect(second.element.textContent).toContain('0/2 host receipts received')
  expect(second.element.textContent).not.toContain('Stop execution'); expect(second.element.querySelector('pre')?.textContent).toBe('echo first-run')
  expect(second.element.textContent).toContain('me@127.0.0.1:22'); expect(replay).not.toHaveBeenCalled()
  await act(async () => { report({ type: 'result', result: { alias: 'first', ok: true } }); report({ type: 'complete', cancelled: false }) })
  expect(m.value()).toBe(saved); expect(second.element.querySelectorAll('[data-status="unknown"]')).toHaveLength(2); expect(replay).not.toHaveBeenCalled()
})
it('refuses dispatch when the initial checkpoint fails, and explicit saving never starts a command', async () => {
  const m = memory(), f = await fixture(m.history), call = vi.spyOn(f.api, 'clusterStream'), original = m.history.write
  m.history.write = vi.fn(() => { throw Error('quota denied') })
  await start(f.element)
  expect(call).not.toHaveBeenCalled(); expect(m.value()).toBeNull(); expect(f.element.textContent).toContain('quota denied')
  expect(button(f.element, 'Review and run').disabled).toBe(true)
  m.history.write = original
  await act(async () => button(f.element, 'Retry saving records').click())
  expect(call).not.toHaveBeenCalled(); expect(decodeClusterHistory(m.value()!).runs).toHaveLength(0); expect(button(f.element, 'Review and run').disabled).toBe(false)
})
it('continues observation after a persistence failure, blocks later runs and explicitly saves final output without rerunning', async () => {
  const m = memory(), f = await fixture(m.history)
  let report!: (frame: ClusterStreamFrame) => void, finish!: (value: never[]) => void
  const call = vi.spyOn(f.api, 'clusterStream').mockImplementation((_request, event) => { report = event; return new Promise(resolve => { finish = resolve }) })
  await start(f.element); const saved = m.value(), original = m.history.write
  m.history.write = vi.fn(() => { throw Error('storage unavailable') })
  await act(async () => {
    report({ type: 'state', alias: 'first', state: 'running' }); report({ type: 'output', alias: 'first', stream: 'stdout', data: 'still observed' })
    for (const host of hosts) report({ type: 'result', result: { alias: host.alias, ok: true, exitCode: 0 } })
    report({ type: 'complete', cancelled: false }); finish([])
  })
  expect(f.element.textContent).toContain('Run finished'); expect(f.element.textContent).toContain('still observed'); expect(m.value()).toBe(saved)
  expect(button(f.element, 'Review and run').disabled).toBe(true); expect(call).toHaveBeenCalledOnce()
  m.history.write = original
  await act(async () => button(f.element, 'Retry saving records').click())
  expect(decodeClusterHistory(m.value()!).runs[0]?.rows[0]?.stdout).toBe('still observed'); expect(button(f.element, 'Review and run').disabled).toBe(false); expect(call).toHaveBeenCalledOnce()
})
it('preserves malformed records, cancels clearing on Escape and clears only its own key after confirmation', async () => {
  sessionStorage.setItem('dsh-ssh:cluster:v1', 'broken record'); sessionStorage.setItem('dsh-ssh:transfers:v1', 'other-transfer-record'); sessionStorage.setItem('unrelated', 'keep')
  const f = await fixture(), call = vi.spyOn(f.api, 'clusterStream')
  expect(button(f.element, 'Review and run').disabled).toBe(true); expect(sessionStorage.getItem('dsh-ssh:cluster:v1')).toBe('broken record')
  await act(async () => button(f.element, 'Clear run history').click())
  await act(async () => f.element.querySelector('[role=alertdialog]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(sessionStorage.getItem('dsh-ssh:cluster:v1')).toBe('broken record'); expect(document.activeElement).toBe(button(f.element, 'Clear run history'))
  await act(async () => button(f.element, 'Clear run history').click()); await act(async () => button(f.element, 'Confirm').click())
  expect(decodeClusterHistory(sessionStorage.getItem('dsh-ssh:cluster:v1')!).runs).toEqual([])
  expect(sessionStorage.getItem('dsh-ssh:transfers:v1')).toBe('other-transfer-record'); expect(sessionStorage.getItem('unrelated')).toBe('keep')
  expect(call).not.toHaveBeenCalled(); expect(document.activeElement).toBe(button(f.element, 'Review and run'))
})
it('returns focus to the empty command field when clearing restored receipts with a disabled run button', async () => {
  const m = memory(), f = await fixture(m.history)
  vi.spyOn(f.api, 'clusterStream').mockImplementation(async (_request, report) => {
    for (const host of hosts) report({ type: 'result', result: { alias: host.alias, ok: true } })
    report({ type: 'complete', cancelled: false }); return []
  })
  await start(f.element); await act(async () => f.root.unmount())
  const restored = await fixture(m.history), call = vi.spyOn(restored.api, 'clusterStream')
  await fill(restored.element, 'Command', ''); await fill(restored.element, 'Target hosts', '')
  expect(button(restored.element, 'Review and run').disabled).toBe(true)
  await act(async () => button(restored.element, 'Clear run history').click())
  await act(async () => button(restored.element, 'Confirm').click())
  expect(document.activeElement).toBe(restored.element.querySelector('textarea'))
  expect(restored.element.querySelector('details')?.open).toBe(true)
  expect(decodeClusterHistory(m.value()!).runs).toEqual([]); expect(call).not.toHaveBeenCalled()
})
it('retains completed receipts and selected history through a remount, with continuing unique IDs', async () => {
  const m = memory(), f = await fixture(m.history)
  vi.spyOn(f.api, 'clusterStream').mockImplementation(async (_request, report) => {
    for (const host of hosts) report({ type: 'result', result: { alias: host.alias, ok: true, exitCode: 0 } })
    report({ type: 'complete', cancelled: false }); return []
  })
  await start(f.element); await fill(f.element, 'Command', 'echo second-run'); await start(f.element)
  await act(async () => { const select = f.element.querySelector('select')!; select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => f.root.unmount())
  const restored = await fixture(m.history), call = vi.spyOn(restored.api, 'clusterStream').mockImplementation(async (_request, report) => {
    for (const host of hosts) report({ type: 'result', result: { alias: host.alias, ok: true } }); report({ type: 'complete', cancelled: false }); return []
  })
  expect(restored.element.querySelector('select')?.value).toBe('1'); expect(restored.element.querySelector('pre')?.textContent).toBe('echo first-run')
  expect(restored.element.textContent).toContain('Run finished'); expect(restored.element.textContent).not.toContain('Original run record restored'); expect(call).not.toHaveBeenCalled()
  await start(restored.element); expect(decodeClusterHistory(m.value()!).runs.map(run => run.id)).toEqual([1, 2, 3]); expect(call).toHaveBeenCalledOnce()
})
it('throttles output checkpoints but flushes the latest observed text on unmount', async () => {
  const m = memory(), f = await fixture(m.history); let report!: (frame: ClusterStreamFrame) => void
  vi.spyOn(f.api, 'clusterStream').mockImplementation((_request, event) => { report = event; return new Promise(() => {}) })
  await start(f.element); const writes = vi.mocked(m.history.write).mock.calls.length
  await act(async () => { for (let index = 0; index < 1000; index++) report({ type: 'output', alias: 'first', stream: 'stdout', data: 'x' }) })
  expect(vi.mocked(m.history.write).mock.calls.length).toBe(writes)
  await act(async () => f.root.unmount()); expect(decodeClusterHistory(m.value()!).runs[0]?.rows[0]?.stdout).toBe('x'.repeat(1000))
})
it('flushes the latest output on pagehide before a reload, without dispatching or stopping another operation', async () => {
  const m = memory(), f = await fixture(m.history); let report!: (frame: ClusterStreamFrame) => void, signal!: AbortSignal
  const call = vi.spyOn(f.api, 'clusterStream').mockImplementation((_request, event, stop) => { report = event; signal = stop!; return new Promise(() => {}) })
  const cancel = vi.spyOn(f.api, 'cancelCluster')
  await start(f.element)
  await act(async () => report({ type: 'output', alias: 'first', stream: 'stdout', data: 'last-frame-before-reload' }))
  await act(async () => window.dispatchEvent(new Event('pagehide')))
  expect(decodeClusterHistory(m.value()!).runs[0]?.rows[0]?.stdout).toBe('last-frame-before-reload')
  expect(signal.aborted).toBe(false); expect(call).toHaveBeenCalledOnce(); expect(cancel).not.toHaveBeenCalled()
})
it('exposes saved-output omissions and includes the exact saved prefix and flags in copy/export', async () => {
  const saved: ClusterRecord = { sequence: 1, selected: 1, runs: [{ id: 1, startedAt: 100, phase: 'running', request: { command: 'original large output' },
    rows: [{ alias: 'first', host: 'original.host', user: 'old-user', port: 2222, updatedAt: 1, phase: 'running', stdout: 'large-output\n'.repeat(50000), stderr: '' }] }] }
  const m = memory(encodeClusterHistory(saved)), f = await fixture(m.history), prefix = decodeClusterHistory(m.value()!).runs[0]!.rows[0]!.stdout
  const write = vi.fn(async () => {}); vi.stubGlobal('navigator', { clipboard: { writeText: write } })
  await act(async () => button(f.element, 'Copy').click())
  expect(write).toHaveBeenCalledExactlyOnceWith(`first (old-user@original.host:2222)\n${prefix}`); expect(f.element.textContent).toContain('Some output was not saved')
  let exported = ''
  vi.stubGlobal('Blob', class { constructor(parts: string[]) { exported = parts[0]! } })
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:test-receipt', revokeObjectURL: () => {} }); vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  await act(async () => button(f.element, 'Export JSON').click())
  expect(JSON.parse(exported)).toMatchObject({ command: 'original large output', recovered: true, phase: 'interrupted', results: [{ host: 'original.host', stdout: prefix, outputTruncated: { stdout: true } }] })
})
it('filters restored results without writing or dispatching and exports all original host receipts', async () => {
  const rows = hosts.map((host, index) => ({ alias: host.alias, host: host.host, port: host.port, user: host.user, updatedAt: host.updatedAt,
    phase: index ? 'unknown' as const : 'ok' as const, stdout: `${host.alias}-original-output`, stderr: '',
    ...(index ? {} : { result: { alias: host.alias, ok: true, exitCode: 0 } }) }))
  const saved: ClusterRecord = { sequence: 2, selected: 1, runs: [1, 2].map(id => ({ id, startedAt: 100, finishedAt: 150, phase: 'interrupted', request: { command: `original-command-${id}` }, rows })) }
  const m = memory(encodeClusterHistory(saved)), f = await fixture(m.history), call = vi.spyOn(f.api, 'clusterStream'), before = m.value()
  const status = f.element.querySelector<HTMLSelectElement>('select[aria-label="Result status"]')!
  await act(async () => { status.value = 'attention'; status.dispatchEvent(new Event('change', { bubbles: true })) })
  expect([...f.element.querySelectorAll('article')].map(row => row.getAttribute('aria-label'))).toEqual(['second'])
  let exported = ''
  vi.stubGlobal('Blob', class { constructor(parts: string[]) { exported = parts[0]! } })
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:test-filtered-receipt', revokeObjectURL: () => {} }); vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  await act(async () => button(f.element, 'Export JSON').click())
  expect(JSON.parse(exported).results.map((row: { alias: string; stdout: string }) => [row.alias, row.stdout])).toEqual([['first', 'first-original-output'], ['second', 'second-original-output']])
  expect(call).not.toHaveBeenCalled(); expect(m.value()).toBe(before); expect(m.history.write).not.toHaveBeenCalled()
  const history = f.element.querySelector<HTMLSelectElement>('select[aria-label="Run history"]')!
  await act(async () => { history.value = '2'; history.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(f.element.querySelector<HTMLSelectElement>('select[aria-label="Result status"]')?.value).toBe('all'); expect(f.element.querySelectorAll('article')).toHaveLength(2)
  expect(call).not.toHaveBeenCalled(); expect(JSON.parse(m.value()!).selected).toBe(2)
})
