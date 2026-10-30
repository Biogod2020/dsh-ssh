// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { connectRemoteWorkspace, mountRemoteWorkspaces } from '../src/client/remote-workspaces.ts'
import { registerRemotePresentation } from '../src/client/remote-presentation.ts'
import { remoteNavigation } from '../src/client/remote-navigation.ts'
import { warmHistoryCopy } from '../src/client/history-cache.ts'
vi.mock('../src/client/history-cache.ts', () => ({ mountHistoryCache: () => () => {}, warmHistoryCopy:vi.fn(), markHistoryRequested() {} }))

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

it('connects an archived-only workspace without opening a Session, changing drafts or creating a blank one', async () => {
  vi.useFakeTimers(); sidebar(); remoteNavigation.native(true)
  let connected = false
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path.endsWith('/connect')) { connected = true; return response({ operation: { id: 'connect-only', phase: 'ready', workspace } }) }
    if (path.includes('/sessions?')) return response({ workspaceId: workspace.workspaceId, stale: !connected, sessions: [], archivedSessions: [{ sessionId: 'archived', title: 'Archived', running: false, blank: false, updatedAt: 1 }] })
    if (path.endsWith('/workspaces')) return response({ workspaces: [workspace], hosts: connected ? [{ hostId: workspace.hostId, phase: 'ready' }] : [] })
    throw new Error('Unexpected side effect: ' + path)
  })
  vi.stubGlobal('fetch', fetchMock)
  const open = vi.fn(), beforeLeave = vi.fn(), unregister = registerRemotePresentation({ resume: () => false, open, beforeLeave }), dispose = mountRemoteWorkspaces()
  try {
    await vi.advanceTimersByTimeAsync(0)
    remoteNavigation.reconnect(workspace); await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/connect'))).toHaveLength(1)
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/open') || String(url).endsWith('/session/create'))).toBe(false)
    expect(open).not.toHaveBeenCalled(); expect(beforeLeave).not.toHaveBeenCalled()
    expect(remoteNavigation.getSnapshot().catalogs.get(workspace.id)?.archivedSessions).toHaveLength(1)
    expect(remoteNavigation.getSnapshot().hosts?.get(workspace.hostId)).toBe('ready')
  } finally { dispose(); unregister() }
})

it.each([true,false])('does not pull a cold native Session into the offscreen setup footer (native=%s)',async native=>{
  vi.useFakeTimers();sidebar();remoteNavigation.native(native)
  const setup={id:'cold',alias:workspace.alias,hostId:workspace.hostId,remotePath:workspace.remotePath,phase:'checking',message:'Checking'}
  vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>String(input).endsWith('/connect')?response({operation:setup}):response({workspaces:[workspace],hosts:[]})))
  const focus=vi.spyOn(HTMLElement.prototype,'focus'),dispose=mountRemoteWorkspaces()
  try{
    await vi.advanceTimersByTimeAsync(0)
    expect(document.activeElement).toBe(document.body)
    remoteNavigation.open(workspace,'saved');await vi.advanceTimersByTimeAsync(0)
    const background=[...document.querySelectorAll('button')].find(button=>button.textContent==='Continue in background')!
    expect(background.hidden).toBe(false)
    if(native){expect(document.activeElement).toBe(document.body);expect(focus).not.toHaveBeenCalled()}
    else{expect(document.activeElement).toBe(background);expect(focus).toHaveBeenCalledWith({preventScroll:true})}
  }finally{dispose();focus.mockRestore()}
})

it('accepts a newer cached choice while a previous choice is waiting and ignores the late completion',async()=>{
  vi.useFakeTimers();sidebar();vi.mocked(warmHistoryCopy).mockClear()
  const fetchMock=vi.fn(async()=>response({workspaces:[workspace],hosts:[{hostId:workspace.hostId,phase:'ready'}]}))
  vi.stubGlobal('fetch',fetchMock)
  let finish!:(value:boolean)=>void
  const previewFailed=vi.fn(),resume=vi.fn((_workspace:unknown,id?:string)=>id==='old'?new Promise<boolean>(resolve=>{finish=resolve}):true)
  const unregister=registerRemotePresentation({resume,previewFailed,open:vi.fn()}),dispose=mountRemoteWorkspaces()
  try{
    await vi.advanceTimersByTimeAsync(0)
    const reads=fetchMock.mock.calls.length
    remoteNavigation.open(workspace,'old');await vi.advanceTimersByTimeAsync(0)
    remoteNavigation.open(workspace,'new');await vi.advanceTimersByTimeAsync(0)
    expect(resume.mock.calls.map(call=>call[1])).toEqual(['old','new'])
    finish(true);await vi.advanceTimersByTimeAsync(0)
    expect(warmHistoryCopy).toHaveBeenCalledExactlyOnceWith(workspace,'new')
    expect(previewFailed).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(reads)
  }finally{dispose();unregister()}
})

it('switches an already connected remote conversation without setup or a leftover connecting notice', async () => {
  vi.useFakeTimers(); sidebar()
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/sessions?')
    ? response({ workspaceId: workspace.workspaceId, stale: false, sessions: [{ sessionId: 'original', title: 'Original remote conversation', running: false, blank: false, updatedAt: 1 }] })
    : response({ workspaces: [workspace], hosts: [{ hostId: workspace.hostId, phase: 'ready' }] }))
  vi.stubGlobal('fetch', fetchMock)
  const resume = vi.fn(() => true), unregister = registerRemotePresentation({ resume, open: vi.fn() })
  const dispose = mountRemoteWorkspaces()
  try {
    await vi.advanceTimersByTimeAsync(0)
    const reads = fetchMock.mock.calls.length
    document.querySelector<HTMLButtonElement>('[data-remote-session-id="original"]')!.click()
    await vi.advanceTimersByTimeAsync(0)
    expect(resume).toHaveBeenCalledExactlyOnceWith(workspace, 'original',expect.any(AbortSignal))
    expect(fetchMock).toHaveBeenCalledTimes(reads)
    expect(fetchMock.mock.calls.every(([url]) => !String(url).endsWith('/connect') && !String(url).endsWith('/open'))).toBe(true)
    expect(document.querySelector('[data-dsh-remote-workspaces] [aria-live="polite"]')?.textContent).not.toContain('Connecting')
  } finally { dispose(); unregister() }
})

it.each([false,true])('switches a retained conversation before connection preparation when browser offline=%s',async offline=>{
  vi.useFakeTimers();sidebar()
  const fetchMock=vi.fn(async(input:RequestInfo|URL)=>String(input).includes('/sessions?')
    ?response({workspaceId:workspace.workspaceId,stale:true,sessions:[{sessionId:'saved',title:'Saved',running:false,blank:false,updatedAt:1}]})
    :response({workspaces:[workspace],hosts:[{hostId:workspace.hostId,phase:'disconnected'}]}))
  vi.stubGlobal('fetch',fetchMock)
  const resume=vi.fn(()=>true),unregister=registerRemotePresentation({resume,open:vi.fn()})
  const dispose=mountRemoteWorkspaces()
  try{
    await vi.advanceTimersByTimeAsync(0);if(offline)window.dispatchEvent(new Event('offline'))
    const reads=fetchMock.mock.calls.length
    const row=document.querySelector<HTMLButtonElement>('[data-remote-session-id="saved"]')!
    expect(row.disabled).toBe(false);row.click();await vi.advanceTimersByTimeAsync(0)
    expect(resume).toHaveBeenCalledOnce();expect(fetchMock).toHaveBeenCalledTimes(reads)
  }finally{dispose();unregister()}
})

it('opens a saved local preview while offline without dispatching remote setup or opening',async()=>{
  vi.useFakeTimers();sidebar()
  const fetchMock=vi.fn(async(input:RequestInfo|URL)=>String(input).includes('/sessions?')
    ?response({workspaceId:workspace.workspaceId,stale:true,sessions:[{sessionId:'saved',title:'Saved',running:false,blank:false,updatedAt:1}]})
    :response({workspaces:[workspace],hosts:[]}))
  vi.stubGlobal('fetch',fetchMock)
  const preview=vi.fn(async()=>{}),open=vi.fn(),unregister=registerRemotePresentation({resume:()=>false,preview,open})
  const dispose=mountRemoteWorkspaces()
  try{
    await vi.advanceTimersByTimeAsync(0);window.dispatchEvent(new Event('offline'));const reads=fetchMock.mock.calls.length
    document.querySelector<HTMLButtonElement>('[data-remote-session-id="saved"]')!.click();await vi.advanceTimersByTimeAsync(0)
    expect(preview).toHaveBeenCalledExactlyOnceWith(workspace,'saved',expect.any(AbortSignal));expect(open).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(reads)
    expect(document.querySelector<HTMLButtonElement>('[data-remote-session-id="saved"]')!.disabled).toBe(false)
  }finally{dispose();unregister()}
})

it('observes a short reattachment promptly and slows long-setup polling without repeating connect', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  let finished = false
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => response({ operation: { id: 'setup', alias: 'fixture',
    phase: finished ? 'ready' : 'checking', message: 'Checking', ...(finished ? { workspace } : {}) } }))
  vi.stubGlobal('fetch', fetchMock)
  const progress = vi.fn()
  const connecting = connectRemoteWorkspace('fixture', '/remote/project', progress)
  await vi.advanceTimersByTimeAsync(250)
  finished = true
  await vi.advanceTimersByTimeAsync(50)
  expect(await connecting).toEqual(workspace)
  expect(progress).toHaveBeenCalledTimes(2)
  expect(Date.now()).toBe(300)
  finished = false; fetchMock.mockClear()
  const slow = connectRemoteWorkspace('fixture', '/remote/project', vi.fn())
  await vi.advanceTimersByTimeAsync(6000)
  const before = fetchMock.mock.calls.length
  await vi.advanceTimersByTimeAsync(3000)
  expect(fetchMock.mock.calls.length - before).toBe(3)
  finished = true; await vi.advanceTimersByTimeAsync(1000); await slow
  expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/connect'))).toHaveLength(1)
})

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
  const health = vi.fn().mockResolvedValueOnce(response({ workspaces: [workspace], hosts: [{ hostId: workspace.hostId, phase: 'ready' }] }))
    .mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    .mockResolvedValue(response({ workspaces: [workspace], hosts: [{ hostId: workspace.hostId, phase: 'disconnected' }] }))
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input).includes('/sessions?')
    ? Promise.resolve(response({ workspaceId: workspace.workspaceId, sessions: [], stale: true })) : health(input, init))
  vi.stubGlobal('fetch', fetchMock)
  const dispose = mountRemoteWorkspaces(); await vi.advanceTimersByTimeAsync(5000)
  window.dispatchEvent(new Event('offline'))
  expect(document.querySelector('[data-remote-workspace-id]')?.textContent).toContain('Browser offline')
  const signal = health.mock.calls[1]![1].signal as AbortSignal
  expect(signal.aborted).toBe(true)
  release(response({ workspaces: [workspace], hosts: [{ hostId: workspace.hostId, phase: 'ready' }] }))
  await vi.advanceTimersByTimeAsync(15000)
  expect(health).toHaveBeenCalledTimes(2)
  expect(document.querySelector('[data-remote-workspace-id]')?.textContent).toContain('Browser offline')
  window.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(0)
  expect(health).toHaveBeenCalledTimes(3)
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
  document.querySelector<HTMLDetailsElement>('[data-dsh-previous-failures]')!.open = true
  const details = document.querySelector<HTMLDetailsElement>('[data-remote-operation-id] details')!, summary = details.querySelector('summary')!
  details.open = true; summary.focus()
  await vi.advanceTimersByTimeAsync(5000)
  expect(document.querySelector('[data-remote-operation-id] details')).toBe(details); expect(details.open).toBe(true); expect(document.activeElement).toBe(summary)
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
  document.querySelector<HTMLDetailsElement>('[data-dsh-previous-failures]')!.open = true
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
  document.querySelector<HTMLDetailsElement>('[data-dsh-previous-failures]')!.open = true
  const dismiss = document.querySelector<HTMLButtonElement>('[data-remote-operation-id] button')!; dismiss.focus(); dismiss.click()
  const row = document.querySelector<HTMLButtonElement>('[data-remote-workspace-id]')!; row.focus()
  dismissed = true; resolveDismiss(response({ ok: true })); await vi.advanceTimersByTimeAsync(0)
  expect(document.activeElement).toBe(row)
  dispose()
})

it('folds earlier failed attempts separately from live preparation and unconfirmed dispatches without retrying', async () => {
  vi.useFakeTimers(); sidebar()
  const old = { id: 'old-timeout', alias: workspace.alias, phase: 'failed', lastPhase: 'checking', message: 'SSH handshake timed out', createdAt: 1000, updatedAt: 2000 }
  const other = { ...old, id: 'old-other', message: 'Connection refused' }
  const preparing = { ...old, id: 'preparing-now', phase: 'installing-dsh', message: 'Installing' }
  const unconfirmed = { ...old, id: 'unconfirmed', lastPhase: 'installing-dsh', errorCode: 'ssh/setup-interrupted', message: 'Remote work may still be running' }
  const legacy = { ...old, id: 'legacy-unknown', lastPhase: 'installing-dsh', message: 'Remote setup timed out; inspect its state before trying again. Not replayed.' }
  const receipts = [old, other, preparing, unconfirmed, legacy]
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ workspaces: [workspace], hosts: [{ hostId: workspace.hostId, phase: 'ready' }], operations: receipts, history: receipts }))
  vi.stubGlobal('fetch', fetchMock)
  const dispose = mountRemoteWorkspaces(); await vi.advanceTimersByTimeAsync(0)
  const previous = document.querySelector<HTMLDetailsElement>('[data-dsh-previous-failures]')!
  expect(previous.open).toBe(false); expect(previous.hidden).toBe(false)
  expect(previous.querySelector('summary')!.textContent).toBe('Previous failed attempts (2)')
  const oldCard = document.querySelector('[data-remote-operation-id="old-timeout"]')!
  expect(previous.contains(oldCard)).toBe(true)
  for (const id of ['preparing-now', 'unconfirmed', 'legacy-unknown']) expect(previous.contains(document.querySelector(`[data-remote-operation-id="${id}"]`))).toBe(false)
  previous.open = true; previous.querySelector('summary')!.focus()
  await vi.advanceTimersByTimeAsync(5000)
  expect(document.querySelector('[data-dsh-previous-failures]')).toBe(previous)
  expect(previous.open).toBe(true); expect(document.activeElement).toBe(previous.querySelector('summary'))
  expect(document.querySelector('[data-remote-operation-id="old-timeout"]')).toBe(oldCard)
  expect(previous.textContent).toContain('not current host status')
  const history = [...document.querySelectorAll<HTMLButtonElement>('button')].find(x => x.textContent === 'Recent setup activity')!
  history.click()
  expect(previous.hidden).toBe(true); expect(previous.contains(oldCard)).toBe(false)
  expect(document.querySelector('[data-remote-operation-id="old-timeout"]')).toBe(oldCard)
  expect(fetchMock.mock.calls.every(([, init]) => !init || (init as RequestInit).method !== 'POST')).toBe(true)
  dispose()
})

it.each([true, false])('keeps focus visible when a background attempt becomes a folded failure (sidebar focus: %s)', async inside => {
  vi.useFakeTimers(); sidebar()
  const editor = document.createElement('input'); document.body.append(editor)
  let failed = false
  vi.stubGlobal('fetch', vi.fn(async () => response({ workspaces: [], hosts: [], operations: [{ id: 'changing', alias: workspace.alias,
    phase: failed ? 'failed' : 'checking', lastPhase: 'checking', message: failed ? 'SSH handshake timed out' : 'Checking' }] })))
  const dispose = mountRemoteWorkspaces(); await vi.advanceTimersByTimeAsync(0)
  if (inside) document.querySelector<HTMLButtonElement>('[data-remote-operation-id] button')!.focus(); else editor.focus()
  failed = true; await vi.advanceTimersByTimeAsync(5000)
  const previous = document.querySelector<HTMLDetailsElement>('[data-dsh-previous-failures]')!
  expect(previous.open).toBe(false)
  expect(document.activeElement).toBe(inside ? previous.querySelector('summary') : editor)
  dispose()
})

it('uses a separate accessible remote-host badge in fallback workspace rows without changing stored titles', async () => {
  vi.useFakeTimers(); sidebar()
  vi.stubGlobal('fetch', vi.fn(async () => response({ workspaces: [workspace], hosts: [{ hostId: workspace.hostId, phase: 'ready' }] })))
  const dispose = mountRemoteWorkspaces(); await vi.advanceTimersByTimeAsync(0)
  const row = document.querySelector('[data-remote-workspace-id]')!, badge = row.querySelector('[data-dsh-remote-host]')!
  expect(badge.getAttribute('aria-label')).toBe('Remote host: fixture')
  expect(badge.textContent).toBe('fixture'); expect(badge.getAttribute('title')).toContain(workspace.remotePath)
  expect(row.textContent).not.toContain('[SSH:fixture]')
  expect(workspace.title).toBe('project [SSH:fixture]')
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
