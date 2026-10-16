// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { mountRemoteWorkspaces } from '../src/client/remote-workspaces.ts'

afterEach(() => {
  vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren()
  window.history.replaceState(null, '', '/')
  document.documentElement.lang = ''
})

it('starts one authenticated recovery from the local page and leaves a failed attempt retryable', async () => {
  vi.useFakeTimers()
  document.documentElement.lang = 'en'
  const proof = 'b'.repeat(64), hostId = 'a'.repeat(24)
  window.location.hash = new URLSearchParams({ 'dsh-ssh-recover': JSON.stringify({ hostId, proof, sessionId: 'session-42' }) }).toString()
  document.body.innerHTML = '<aside data-pane="sidebar"><div role="tree"></div></aside>'
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path.endsWith('/remote/workspaces')) return { ok: true, json: async () => ({ workspaces: [], hosts: [] }) }
    if (path.endsWith('/remote/recover')) return { ok: true, json: async () => ({ operation: {
      id: 'op', alias: 'fixture', phase: 'failed', message: 'Host key not trusted',
    } }) }
    throw new Error('Unexpected request: ' + path + ' ' + init?.method)
  })
  vi.stubGlobal('fetch', fetchMock)
  const dispose = mountRemoteWorkspaces()
  await vi.advanceTimersByTimeAsync(0)
  expect(fetchMock).toHaveBeenCalledWith('/api/dsh-ssh/remote/recover', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ hostId, proof }),
  }))
  expect(window.location.hash).toBe('')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Host key not trusted')
  const retry = [...document.querySelectorAll('button')].find(x => x.textContent === 'Retry SSH recovery')!
  retry.click()
  await vi.advanceTimersByTimeAsync(0)
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/remote/recover'))).toHaveLength(2)
  dispose()
})

const workspace = { id: 'workspace-1', hostId: 'a'.repeat(24), alias: 'fixture', remotePath: '/remote/project', title: 'project [SSH:fixture]', workspaceId: 'remote-1' }
const response = (value: object) => ({ ok: true, json: async () => value })
const sidebar = () => { document.documentElement.lang = 'en'; document.body.innerHTML = '<aside data-pane="sidebar"><div role="tree"></div></aside>' }

it('retains row identity and focus across health changes; failed reads become unknown rather than disconnected', async () => {
  vi.useFakeTimers(); sidebar()
  let phase = 'ready', failed = false
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (failed) throw new Error('Controller unreachable')
    return response({ workspaces: [workspace], hosts: [{ hostId: workspace.hostId, phase }] })
  }))
  const dispose = mountRemoteWorkspaces()
  await vi.advanceTimersByTimeAsync(0)
  const row = document.querySelector<HTMLButtonElement>('[data-remote-workspace-id]')!; row.focus()
  expect(row.textContent).toContain('/remote/project')
  phase = 'installing-dsh'; await vi.advanceTimersByTimeAsync(5000)
  expect(document.querySelector('[data-remote-workspace-id]')).toBe(row)
  expect(document.activeElement).toBe(row)
  expect(row.textContent).toContain('Installing DSH')
  expect(row.querySelector('[data-state]')?.getAttribute('data-state')).toBe('connecting')
  failed = true; await vi.advanceTimersByTimeAsync(5000)
  expect(row.textContent).toContain('status unconfirmed')
  expect(row.querySelector('[data-state]')?.getAttribute('data-state')).toBe('unknown')
  expect(document.activeElement).toBe(row)
  dispose()
})

it('invalidates an in-flight health read on offline and refreshes immediately on online', async () => {
  vi.useFakeTimers(); sidebar()
  let release!: (value: object) => void
  const fetchMock = vi.fn().mockResolvedValueOnce(response({ workspaces: [workspace], hosts: [{ hostId: workspace.hostId, phase: 'ready' }] }))
    .mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    .mockResolvedValue(response({ workspaces: [workspace], hosts: [{ hostId: workspace.hostId, phase: 'disconnected' }] }))
  vi.stubGlobal('fetch', fetchMock)
  const dispose = mountRemoteWorkspaces(); await vi.advanceTimersByTimeAsync(5000)
  window.dispatchEvent(new Event('offline'))
  expect(document.querySelector('[data-remote-workspace-id]')?.textContent).toContain('Browser offline')
  const signal = fetchMock.mock.calls[1]![1].signal as AbortSignal
  expect(signal.aborted).toBe(true)
  release(response({ workspaces: [workspace], hosts: [{ hostId: workspace.hostId, phase: 'ready' }] }))
  await vi.advanceTimersByTimeAsync(15000)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(document.querySelector('[data-remote-workspace-id]')?.textContent).toContain('Browser offline')
  window.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(0)
  expect(fetchMock).toHaveBeenCalledTimes(3)
  expect(document.querySelector('[data-remote-workspace-id]')?.textContent).toContain('DSH disconnected')
  dispose()
})

it('disposal aborts operation observation and never opens or retries a late successful setup', async () => {
  vi.useFakeTimers(); sidebar()
  let complete!: (value: object) => void
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const path = String(input)
    if (path.endsWith('/workspaces')) return response({ workspaces: [workspace], hosts: [] })
    if (path.endsWith('/connect')) return response({ operation: { id: 'setup', alias: 'fixture', phase: 'checking', message: 'Checking' } })
    if (path.includes('/operation?')) return new Promise(resolve => { complete = resolve })
    throw new Error('Must not open: ' + path)
  })
  vi.stubGlobal('fetch', fetchMock)
  const dispose = mountRemoteWorkspaces(); await vi.advanceTimersByTimeAsync(0)
  document.querySelector<HTMLButtonElement>('[data-remote-workspace-id]')!.click()
  await vi.advanceTimersByTimeAsync(1000)
  expect(fetchMock).toHaveBeenCalledWith('/api/dsh-ssh/remote/connect', expect.objectContaining({ body: JSON.stringify({ alias: workspace.alias, remotePath: workspace.remotePath, expectedHostId: workspace.hostId }) }))
  dispose()
  complete(response({ operation: { id: 'setup', alias: 'fixture', phase: 'ready', message: 'Ready', workspace } }))
  await vi.advanceTimersByTimeAsync(10000)
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/connect'))).toHaveLength(1)
  expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/open'))).toBe(false)
  expect(document.querySelector('[data-dsh-remote-workspaces]')).toBeNull()
})

it('disposal during launch prevents navigation and failed user attempts restore the same row focus', async () => {
  vi.useFakeTimers(); sidebar()
  let openSignal: AbortSignal | undefined, finishOpen!: (value: object) => void, failed = true
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path.endsWith('/workspaces')) return response({ workspaces: [workspace], hosts: [] })
    if (path.endsWith('/connect')) return response({ operation: { id: 'setup', alias: 'fixture', phase: failed ? 'failed' : 'ready', message: failed ? 'Host key not trusted' : 'Ready', workspace } })
    if (path.endsWith('/open')) { openSignal = init?.signal as AbortSignal; return new Promise(resolve => { finishOpen = resolve }) }
    throw new Error('Unexpected request')
  })
  vi.stubGlobal('fetch', fetchMock)
  const dispose = mountRemoteWorkspaces(); await vi.advanceTimersByTimeAsync(0)
  const row = document.querySelector<HTMLButtonElement>('[data-remote-workspace-id]')!; row.focus(); row.click()
  await vi.advanceTimersByTimeAsync(0)
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Host key not trusted')
  expect(document.activeElement).toBe(row)
  failed = false; row.click(); await vi.advanceTimersByTimeAsync(0)
  dispose(); expect(openSignal?.aborted).toBe(true)
  finishOpen(response({ url: 'http://127.0.0.1:9090/' })); await vi.advanceTimersByTimeAsync(0)
  expect(window.location.pathname).toBe('/')
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/open'))).toHaveLength(1)
})

it('observes a background receipt with GET only and stopping it cannot launch a late result', async () => {
  vi.useFakeTimers(); sidebar()
  const operation = { id: 'background', alias: 'fixture', hostId: workspace.hostId, remotePath: workspace.remotePath, phase: 'checking', message: 'Checking' }
  let complete!: (value: object) => void, reads = 0
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const path = String(input)
    if (path.endsWith('/workspaces')) return response({ workspaces: [], hosts: [], operations: [operation] })
    if (path.includes('/operation?')) {
      if (++reads === 1) return response({ operation })
      return new Promise(resolve => { complete = resolve })
    }
    throw new Error('No setup or launch should be dispatched: ' + path)
  })
  vi.stubGlobal('fetch', fetchMock)
  const dispose = mountRemoteWorkspaces(); await vi.advanceTimersByTimeAsync(0)
  const card = document.querySelector('[data-remote-operation-id="background"]')!
  expect(card.textContent).toContain(workspace.remotePath)
  ;[...card.querySelectorAll('button')].find(x => x.textContent === 'Open when ready')!.click()
  await vi.advanceTimersByTimeAsync(1000)
  ;[...document.querySelectorAll('button')].find(x => x.textContent === 'Continue in background')!.click()
  await vi.advanceTimersByTimeAsync(0)
  expect(document.activeElement?.textContent).toBe('Open when ready')
  complete(response({ operation: { ...operation, phase: 'ready', workspace } }))
  await vi.advanceTimersByTimeAsync(10000)
  expect(document.querySelector('[data-remote-operation-id="background"]')).not.toBeNull()
  expect(fetchMock.mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true)
  dispose()
})

it('preserves a failure disclosure and focus across catalog refreshes; dismissal never retries it', async () => {
  vi.useFakeTimers(); sidebar()
  let dismissed = false
  const original = 'cannot create a Workspace: EACCES /remote/restricted/folder'
  const operation = { id: 'failure', alias: 'fixture', remotePath: '/remote/restricted/folder', phase: 'failed', message: original, errorCode: 'workspace/invalid-path' }
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/workspaces')) return response({ workspaces: [], hosts: [], operations: dismissed ? [] : [operation] })
    if (String(input).endsWith('/dismiss')) { dismissed = true; return response({ ok: true }) }
    throw new Error('Failure must not retry')
  })
  vi.stubGlobal('fetch', fetchMock)
  const dispose = mountRemoteWorkspaces(); await vi.advanceTimersByTimeAsync(0)
  const details = document.querySelector('details')!, summary = details.querySelector('summary')!
  details.open = true; summary.focus()
  await vi.advanceTimersByTimeAsync(5000)
  expect(document.querySelector('details')).toBe(details); expect(details.open).toBe(true); expect(document.activeElement).toBe(summary)
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Could not open this remote folder.')
  expect(details.querySelector('pre')?.textContent).toBe(original)
  ;[...document.querySelectorAll('button')].find(x => x.textContent === 'Dismiss failure')!.click()
  await vi.advanceTimersByTimeAsync(0)
  expect(document.querySelector('[data-remote-operation-id]')).toBeNull()
  expect(fetchMock.mock.calls.filter(([input]) => !String(input).endsWith('/workspaces')).map(([input]) => String(input))).toEqual(['/api/dsh-ssh/remote/dismiss'])
  dispose()
})

it('does not restart a recovery abandoned to the background when the network returns', async () => {
  vi.useFakeTimers(); sidebar()
  const hostId = workspace.hostId, proof = 'b'.repeat(64)
  window.location.hash = new URLSearchParams({ 'dsh-ssh-recover': JSON.stringify({ hostId, proof }) }).toString()
  const operation = { id: 'recovery', hostId, alias: 'fixture', phase: 'checking', message: 'Checking' }
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path.endsWith('/workspaces')) return response({ workspaces: [workspace], hosts: [], operations: [operation] })
    if (path.endsWith('/recover')) return response({ operation })
    throw new Error('No new recovery or launch is authorized: ' + path)
  })
  vi.stubGlobal('fetch', fetchMock)
  const dispose = mountRemoteWorkspaces(); await vi.advanceTimersByTimeAsync(0)
  ;[...document.querySelectorAll('button')].find(x => x.textContent === 'Continue in background')!.click()
  window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online'))
  await vi.advanceTimersByTimeAsync(10000)
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/recover'))).toHaveLength(1)
  expect(document.querySelector('[data-remote-operation-id="recovery"]')).not.toBeNull()
  dispose()
})

it('returns focus from a completed background card to its workspace without opening or dispatching it', async () => {
  vi.useFakeTimers(); sidebar()
  const pending = { id: 'pending', alias: workspace.alias, hostId: workspace.hostId, remotePath: workspace.remotePath, phase: 'installing-dsh', message: 'Installing', createdAt: 1000, updatedAt: 2000 }
  let completed = false
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ workspaces: completed ? [workspace] : [], hosts: [], operations: completed ? [] : [pending],
    history: [{ ...pending, ...(completed ? { phase: 'ready', workspace } : {}) }] }))
  vi.stubGlobal('fetch', fetchMock)
  const dispose = mountRemoteWorkspaces(); await vi.advanceTimersByTimeAsync(0)
  document.querySelector<HTMLButtonElement>('[data-remote-operation-id] button')!.focus()
  completed = true; await vi.advanceTimersByTimeAsync(5000)
  expect(document.querySelector('[data-remote-operation-id]')).toBeNull()
  expect(document.activeElement).toBe(document.querySelector('[data-remote-workspace-id]'))
  expect(fetchMock.mock.calls.every(([, init]) => !init || (init as RequestInit).method !== 'POST')).toBe(true)
  dispose()
})

it('keeps dismissed failures in history and restores focus to its history control', async () => {
  vi.useFakeTimers(); sidebar()
  const failed = { id: 'failed', alias: workspace.alias, phase: 'failed', message: 'Original failure', createdAt: 1000, updatedAt: 2000 }
  let dismissed = false
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/dismiss')) { dismissed = true; return response({ ok: true }) }
    return response({ workspaces: [], hosts: [], operations: dismissed ? [] : [failed], history: [{ ...failed, dismissed }] })
  })
  vi.stubGlobal('fetch', fetchMock)
  const dispose = mountRemoteWorkspaces(); await vi.advanceTimersByTimeAsync(0)
  const dismiss = document.querySelector<HTMLButtonElement>('[data-remote-operation-id] button')!; dismiss.focus(); dismiss.click()
  await vi.advanceTimersByTimeAsync(0)
  const history = [...document.querySelectorAll<HTMLButtonElement>('button')].find(x => x.textContent === 'Recent setup activity')!
  expect(document.activeElement).toBe(history)
  history.click()
  const card = document.querySelector('[data-remote-operation-id]')!
  expect(card.textContent).toContain('Original failure')
  expect(card.querySelector('button')?.disabled).toBe(true)
  expect(card.querySelector('time')?.dateTime).toBe(new Date(2000).toISOString())
  expect(fetchMock.mock.calls.filter(([input]) => !String(input).endsWith('/workspaces'))).toHaveLength(1)
  dispose()
})

it('distinguishes a completed historical setup from current connection status and retains its disclosure on refresh', async () => {
  vi.useFakeTimers(); sidebar()
  const ready = { id: 'ready', alias: workspace.alias, phase: 'ready', message: 'Ready', workspace, createdAt: 1000, updatedAt: 2000 }
  vi.stubGlobal('fetch', vi.fn(async () => response({ workspaces: [workspace], hosts: [{ hostId: workspace.hostId, phase: 'disconnected' }], operations: [], history: [ready] })))
  const dispose = mountRemoteWorkspaces(); await vi.advanceTimersByTimeAsync(0)
  ;[...document.querySelectorAll<HTMLButtonElement>('button')].find(x => x.textContent === 'Recent setup activity')!.click()
  expect(document.querySelector('[data-remote-operation-id]')?.textContent).toContain('Setup completed')
  expect(document.querySelector('[data-remote-workspace-id]')?.textContent).toContain('DSH disconnected')
  const action = document.querySelector<HTMLButtonElement>('[data-remote-operation-id] button')!; action.focus()
  await vi.advanceTimersByTimeAsync(5000)
  expect(document.querySelector('[data-remote-operation-id] button')).toBe(action)
  expect(document.activeElement).toBe(action)
  dispose()
})

it('shows interrupted setup as unconfirmed and never resumes it on history view, refresh or network recovery', async () => {
  vi.useFakeTimers(); sidebar()
  const interrupted = { id: 'interrupted', alias: workspace.alias, phase: 'failed', lastPhase: 'installing-dsh', message: 'Remote work may still be running',
    errorCode: 'ssh/setup-interrupted', createdAt: 1000, updatedAt: 2000 }
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => response({ workspaces: [], hosts: [], operations: [interrupted], history: [interrupted] }))
  vi.stubGlobal('fetch', fetchMock)
  const dispose = mountRemoteWorkspaces(); await vi.advanceTimersByTimeAsync(0)
  const card = document.querySelector<HTMLElement>('[data-remote-operation-id]')!
  expect(card.dataset.state).toBe('unknown')
  expect(card.querySelector('[role="alert"]')).toBeNull()
  expect(card.textContent).toContain('Installing DSH')
  expect(card.querySelector('pre')?.textContent).toBe(interrupted.message)
  window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online'))
  ;[...document.querySelectorAll<HTMLButtonElement>('button')].find(x => x.textContent === 'Recent setup activity')!.click()
  await vi.advanceTimersByTimeAsync(10000)
  expect(fetchMock.mock.calls.every(([input]) => String(input).endsWith('/workspaces'))).toBe(true)
  dispose()
})

it('does not steal focus outside the sidebar when a background card completes', async () => {
  vi.useFakeTimers(); sidebar()
  const input = document.createElement('input'); document.body.append(input)
  let completed = false
  const pending = { id: 'pending', alias: workspace.alias, phase: 'checking', message: 'Checking' }
  vi.stubGlobal('fetch', vi.fn(async () => response({ workspaces: completed ? [workspace] : [], hosts: [], operations: completed ? [] : [pending], history: [] })))
  const dispose = mountRemoteWorkspaces(); await vi.advanceTimersByTimeAsync(0); input.focus()
  completed = true; await vi.advanceTimersByTimeAsync(5000)
  expect(document.activeElement).toBe(input)
  dispose()
})

it('preserves a workspace focus chosen while a dismissal request is in flight', async () => {
  vi.useFakeTimers(); sidebar()
  const failed = { id: 'failed', alias: workspace.alias, phase: 'failed', message: 'Original failure' }
  let resolveDismiss!: (value: object) => void, dismissed = false
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/dismiss')) return new Promise(resolve => { resolveDismiss = resolve })
    return response({ workspaces: [workspace], hosts: [], operations: dismissed ? [] : [failed], history: [{ ...failed, dismissed }] })
  }))
  const dispose = mountRemoteWorkspaces(); await vi.advanceTimersByTimeAsync(0)
  const dismiss = document.querySelector<HTMLButtonElement>('[data-remote-operation-id] button')!; dismiss.focus(); dismiss.click()
  const row = document.querySelector<HTMLButtonElement>('[data-remote-workspace-id]')!; row.focus()
  dismissed = true; resolveDismiss(response({ ok: true })); await vi.advanceTimersByTimeAsync(0)
  expect(document.activeElement).toBe(row)
  dispose()
})

it('restores its focused task and completed workspace after the native sidebar rebuilds around it', async () => {
  vi.useFakeTimers(); sidebar()
  let completed = false
  const pending = { id: 'pending', alias: workspace.alias, phase: 'checking', message: 'Checking' }
  vi.stubGlobal('fetch', vi.fn(async () => response({ workspaces: completed ? [workspace] : [], hosts: [], operations: completed ? [] : [pending],
    history: [{ ...pending, ...(completed ? { phase: 'ready', workspace } : {}) }] })))
  const dispose = mountRemoteWorkspaces(); await vi.advanceTimersByTimeAsync(0)
  const action = document.querySelector<HTMLButtonElement>('[data-remote-operation-id] button')!; action.focus()
  document.querySelector('aside')!.innerHTML = '<div role="tree"></div>'
  await vi.advanceTimersByTimeAsync(20)
  expect(document.activeElement).toBe(action)
  completed = true; await vi.advanceTimersByTimeAsync(5000)
  const row = document.querySelector<HTMLButtonElement>('[data-remote-workspace-id]')!
  expect(document.activeElement).toBe(row)
  document.querySelector('aside')!.innerHTML = '<div role="tree"></div>'
  await vi.advanceTimersByTimeAsync(20)
  expect(document.activeElement).toBe(row)
  dispose()
})

it('relinquishes remembered sidebar focus when the user moves to the editor before a rebuild', async () => {
  vi.useFakeTimers(); sidebar()
  const input = document.createElement('input'); document.body.append(input)
  vi.stubGlobal('fetch', vi.fn(async () => response({ workspaces: [workspace], hosts: [] })))
  const dispose = mountRemoteWorkspaces(); await vi.advanceTimersByTimeAsync(0)
  document.querySelector<HTMLButtonElement>('[data-remote-workspace-id]')!.focus(); input.focus()
  document.querySelector('aside')!.innerHTML = '<div role="tree"></div>'
  await vi.advanceTimersByTimeAsync(20)
  expect(document.activeElement).toBe(input)
  dispose()
})
