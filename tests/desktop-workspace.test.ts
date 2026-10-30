// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { mountDesktopWorkspaces } from '../src/client/desktop-workspace.ts'
import { openRemoteWorkspace } from '../src/client/remote-workspaces.ts'
import type { RemoteWorkspace } from '../src/remote/types.ts'
import { remotePresentation, remoteSelection } from '../src/client/remote-presentation.ts'
import { remoteNavigation } from '../src/client/remote-navigation.ts'

const workspace: RemoteWorkspace = { id: 'fixture', hostId: 'a'.repeat(24), alias: 'fixture', remotePath: '/work', title: 'work', workspaceId: 'remote-work' }
let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })
function fixture() {
  document.documentElement.lang = 'en'
  const local = document.createElement('button'); local.textContent = 'Local draft'; document.body.append(local); local.focus()
  const guests: Array<HTMLElement & { loadURL: ReturnType<typeof vi.fn>; insertCSS: ReturnType<typeof vi.fn>; executeJavaScript: ReturnType<typeof vi.fn> }> = []
  const create = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((name: string, options?: ElementCreationOptions) => {
    const node = create(name, options)
    if (name === 'webview') {
      const guest = Object.assign(node, { loadURL: vi.fn(async (_url: string) => {}), insertCSS: vi.fn(async () => ''), executeJavaScript: vi.fn(async () => true) })
      guests.push(guest)
    }
    return node
  })
  const links = new Map<string, (url: string) => void>()
  const bridge = {
    acquire: vi.fn(async (_workspace: string) => ({ lease: `lease-${guests.length}`, partition: `partition-${guests.length}` })),
    release: vi.fn(async (_lease: string) => {}),
    onOpenRequested: vi.fn((lease: string, fn: (url: string) => void) => { links.set(lease, fn); return () => links.delete(lease) }),
  }
  vi.stubGlobal('dshDesktop', { browser: bridge })
  const fetch = vi.fn(async (_input?: unknown, options?: RequestInit) => ({ ok: true, json: async () => ({ url: 'http://127.0.0.1:40200/?dsh-remote-ticket=private-fixture-ticket', sessionId: JSON.parse(options?.body as string).sessionId ?? 'first' }) }))
  vi.stubGlobal('fetch', fetch)
  dispose = mountDesktopWorkspaces()
  const start = async (value = workspace, signal?: AbortSignal, sessionId?: string) => {
    const promise = openRemoteWorkspace(value, sessionId, { signal })
    // Resolve the local API and reservation; the guest must attach on blank.
    for (let i = 0; i < 8; i++) await Promise.resolve()
    return { promise, guest: guests.at(-1)! }
  }
  return { bridge, links, fetch, local, guests, start }
}

it('uses an isolated Desktop guest without leaving the app, and returning/reopening retains the same client', async () => {
  const f = fixture(), original = window.location.href, lifetime = new AbortController()
  const { promise, guest } = await f.start(workspace, lifetime.signal)
  expect(guest.getAttribute('src')).toBe('about:blank#lease-0')
  expect(guest.getAttribute('partition')).toBe('partition-0')
  expect(guest.hasAttribute('preload')).toBe(false)
  expect(guest.hasAttribute('allowpopups')).toBe(false)
  expect(f.bridge.acquire).toHaveBeenCalledWith(`dsh-ssh:${workspace.hostId}`)
  expect(guest.loadURL).not.toHaveBeenCalled()
  guest.dispatchEvent(new Event('dom-ready')); await promise
  expect(guest.loadURL).toHaveBeenCalledOnce()
  expect(new URL(guest.loadURL.mock.calls[0]![0]!).searchParams.get('dsh-remote-view')).toBe('desktop')
  expect(window.location.href).toBe(original)
  expect(f.local.inert).toBe(true)
  // Closing the Add workspace observer after opening must not kill the view.
  lifetime.abort(); expect(f.bridge.release).not.toHaveBeenCalled()
  const back = [...document.querySelectorAll('button')].find(button => button.textContent === 'Return to local')!
  back.click(); await vi.waitFor(() => expect(f.local.inert).not.toBe(true))
  expect(guest.isConnected).toBe(true)
  await openRemoteWorkspace(workspace)
  expect(f.fetch).toHaveBeenCalledOnce(); expect(guest.loadURL).toHaveBeenCalledOnce()
  expect(document.querySelector<HTMLElement>('[data-dsh-remote-desktop]')!.hidden).toBe(false)
  dispose!(); expect(f.bridge.release).toHaveBeenCalledExactlyOnceWith('lease-0')
  expect(f.local.inert).not.toBe(true)
})

it('isolates Hosts and selects another Session through native navigation without replacing the client document', async () => {
  const f = fixture(), first = await f.start()
  first.guest.dispatchEvent(new Event('dom-ready')); await first.promise
  const second = await f.start({ ...workspace, id: 'second', hostId: 'b'.repeat(24), alias: 'second' })
  second.guest.dispatchEvent(new Event('dom-ready')); await second.promise
  expect(first.guest.hidden).toBe(true); expect(second.guest.hidden).toBe(false)
  await openRemoteWorkspace(workspace)
  expect(first.guest.hidden).toBe(false); expect(second.guest.hidden).toBe(true)
  await expect(openRemoteWorkspace({ ...workspace, hostId: 'c'.repeat(24) })).rejects.toThrow('identity changed')
  const session = await f.start(workspace, undefined, 'different-session')
  await session.promise
  await openRemoteWorkspace(workspace, 'different-session')
  expect(first.guest.hidden).toBe(false); expect(second.guest.hidden).toBe(true)
  expect(first.guest.executeJavaScript).toHaveBeenCalledWith('(async()=>Boolean(await window.__dshSshView?.select?.("remote-work","different-session")))()')
  expect(f.fetch.mock.calls.filter(([url]) => String(url).endsWith('/remote/open'))).toHaveLength(2)
  expect(f.guests).toHaveLength(2)
  expect(f.guests.every(guest => guest.loadURL.mock.calls.length === 1)).toBe(true)
})

it('falls back to authenticated backend validation when the retained catalog cannot select a Session', async () => {
  const f = fixture(), first = await f.start()
  first.guest.dispatchEvent(new Event('dom-ready')); await first.promise
  first.guest.executeJavaScript.mockImplementation(async (code: string) => !code.includes('__dshSshView?.select'))
  await openRemoteWorkspace(workspace, 'not-yet-observed')
  expect(f.fetch.mock.calls.filter(([url]) => String(url).endsWith('/remote/open'))).toHaveLength(2)
  expect(first.guest.executeJavaScript).toHaveBeenLastCalledWith('window.__dshSshView.open("not-yet-observed")')
  expect(first.guest.loadURL).toHaveBeenCalledOnce()
})

it('switches projects on the same retained Host without another launch request or document load', async () => {
  const f = fixture(), first = await f.start()
  first.guest.dispatchEvent(new Event('dom-ready')); await first.promise
  await openRemoteWorkspace({ ...workspace, id: 'other-project', workspaceId: 'other-remote-work', remotePath: '/other' }, 'other-session')
  expect(f.fetch.mock.calls.filter(([url]) => String(url).endsWith('/remote/open'))).toHaveLength(1)
  expect(first.guest.executeJavaScript).toHaveBeenLastCalledWith('(async()=>Boolean(await window.__dshSshView?.select?.("other-remote-work","other-session")))()')
  expect(f.guests).toHaveLength(1); expect(first.guest.loadURL).toHaveBeenCalledOnce()
})
it('reselects a retained Session even when its remote shell cleared selection after archive',async()=>{
  const f=fixture(),first=await f.start()
  first.guest.dispatchEvent(new Event('dom-ready'));await first.promise
  first.guest.executeJavaScript.mockClear()
  await openRemoteWorkspace(workspace,'first')
  expect(first.guest.executeJavaScript).toHaveBeenCalledWith('(async()=>Boolean(await window.__dshSshView?.select?.("remote-work","first")))()')
  expect(first.guest.loadURL).toHaveBeenCalledOnce()
})

it('clears only the archived selection without a close prompt or releasing its retained Host guest', async () => {
  const f = fixture(), first = await f.start()
  first.guest.dispatchEvent(new Event('dom-ready')); await first.promise
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const surface = document.querySelector<HTMLElement>('[data-dsh-remote-desktop]')!
  await remotePresentation()!.archived!({ ...workspace, hostId: 'b'.repeat(24) }, 'first')
  expect(surface.hidden).toBe(false)
  await remotePresentation()!.archived!(workspace, 'another-session')
  expect(surface.hidden).toBe(false)
  await remotePresentation()!.archived!(workspace, 'first')
  expect(surface.hidden).toBe(true); expect(confirm).not.toHaveBeenCalled()
  expect(first.guest.isConnected).toBe(true); expect(f.bridge.release).not.toHaveBeenCalled()
  await openRemoteWorkspace(workspace, 'next')
  expect(surface.hidden).toBe(false); expect(first.guest.loadURL).toHaveBeenCalledOnce()
})

it('hides an unsupported embedded view and retains its guest/draft without exposing a remote selection to local commands', async () => {
  const f = fixture(), view = await f.start()
  view.guest.dispatchEvent(new Event('dom-ready')); await view.promise
  const presentation = remotePresentation()!
  expect(remoteSelection()?.workspaceId).toBe(workspace.id)
  presentation.suspend!()
  expect(remotePresentation()).toBeUndefined(); expect(remoteSelection()).toBeUndefined()
  expect(document.querySelector<HTMLElement>('[data-dsh-remote-desktop]')!.hidden).toBe(true)
  expect(view.guest.isConnected).toBe(true); expect(f.bridge.release).not.toHaveBeenCalled()
  await expect(presentation.resume(workspace, 'first')).resolves.toBe(false)
})

it('cancels a pending view without leaking its lease, replaying setup, or disclosing the launch ticket', async () => {
  const f = fixture(), controller = new AbortController()
  const { promise, guest } = await f.start(workspace, controller.signal)
  const failed = expect(promise).rejects.toThrow('could not load')
  controller.abort(); await failed
  expect(guest.isConnected).toBe(false)
  expect(f.bridge.release).toHaveBeenCalledExactlyOnceWith('lease-0')
  expect(f.fetch).toHaveBeenCalledOnce()
  expect(guest.loadURL).not.toHaveBeenCalled()
})

it('does not accept arbitrary launch origins or open guest links in the system browser', async () => {
  const f = fixture()
  f.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ url: 'https://untrusted.test/?dsh-remote-ticket=ticket', sessionId: 'first' }) })
  await expect(openRemoteWorkspace(workspace)).rejects.toThrow('Invalid remote workspace gateway')
  expect(f.bridge.acquire).not.toHaveBeenCalled()
  const view = await f.start(); view.guest.dispatchEvent(new Event('dom-ready')); await view.promise
  const request = f.links.get('lease-0')!
  request('https://untrusted.test/'); request('http://127.0.0.1:3080/'); request('javascript:alert(1)')
  expect(view.guest.loadURL).toHaveBeenCalledOnce()
  request('http://127.0.0.1:40200/help'); expect(view.guest.loadURL).toHaveBeenCalledOnce()
})

it('reports a failed guest load without echoing credential-bearing URLs and releases the guest', async () => {
  const f = fixture(), view = await f.start()
  view.guest.loadURL.mockRejectedValue(new Error('failed loading http://127.0.0.1:40200/?dsh-remote-ticket=private-fixture-ticket'))
  const result = view.promise.catch(error => error.message as string)
  view.guest.dispatchEvent(new Event('dom-ready'))
  expect(await result).not.toContain('private-fixture-ticket')
  expect(f.bridge.release).toHaveBeenCalledOnce()
  expect(document.querySelector<HTMLElement>('[data-dsh-remote-desktop]')!.hidden).toBe(true)
})

it('leaves web deployments on their existing presentation when no Desktop guest API is available', () => {
  expect(mountDesktopWorkspaces()).toBeUndefined()
})

it('keeps one cold page load alive past the old 30 second deadline without redispatching navigation', async () => {
  vi.useFakeTimers()
  const f = fixture(), view = await f.start()
  let loaded!: () => void
  view.guest.loadURL.mockImplementationOnce(() => new Promise<void>(resolve => { loaded = resolve }))
  view.guest.dispatchEvent(new Event('dom-ready'))
  await vi.advanceTimersByTimeAsync(45000)
  expect(view.guest.isConnected).toBe(true); expect(f.bridge.release).not.toHaveBeenCalled()
  loaded(); await view.promise
  expect(view.guest.loadURL).toHaveBeenCalledOnce(); expect(f.fetch).toHaveBeenCalledOnce()
})

it('waits for a cold client boot beyond the old 45 second deadline in the same guest', async () => {
  vi.useFakeTimers()
  const f = fixture(), view = await f.start()
  view.guest.executeJavaScript.mockResolvedValue(false)
  view.guest.dispatchEvent(new Event('dom-ready'))
  await vi.advanceTimersByTimeAsync(60000)
  expect(view.guest.isConnected).toBe(true); expect(f.bridge.release).not.toHaveBeenCalled()
  view.guest.executeJavaScript.mockResolvedValue(true)
  await vi.advanceTimersByTimeAsync(100); await view.promise
  expect(view.guest.loadURL).toHaveBeenCalledOnce(); expect(f.fetch).toHaveBeenCalledOnce()
})

it('shows a saved disk history in the same panel without SSH, and a late preview cannot replace current navigation', async () => {
  const f = fixture()
  const copy = { meta: { hostId: workspace.hostId, workspaceId: workspace.workspaceId, sessionId: 'cached', title: 'Saved remote chat', savedAt: 1, complete: true },
    records: [{ type: 'event', event: { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'History survives a restart' }] } } }] }
  f.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ copy }) } as any)
  await remotePresentation()!.preview!(workspace, 'cached')
  const surface = document.querySelector<HTMLElement>('[data-dsh-remote-desktop]')!
  expect(surface.hidden).toBe(false); expect(surface.textContent).toContain('History survives a restart')
  remotePresentation()!.previewFailed!(workspace)
  expect(surface.textContent).toContain('live conversation is not connected')
  remotePresentation()!.previewFailed!(workspace, new Error('Remote catalog queue wait timed out'))
  expect(surface.textContent).toContain('Remote catalog queue wait timed out')
  expect(surface.textContent).not.toContain('remote host is unavailable')
  const open = vi.spyOn(remoteNavigation, 'open').mockImplementation(() => {})
  ;[...surface.querySelectorAll('button')].find(button => button.textContent === 'Resume live conversation')!.click()
  expect(open).toHaveBeenCalledExactlyOnceWith(workspace, 'cached')
  expect(f.bridge.acquire).not.toHaveBeenCalled(); expect(f.guests).toHaveLength(0)
  let resolve!: (value: any) => void
  f.fetch.mockImplementationOnce(async () => new Promise(value => { resolve = value }))
  const pending = remotePresentation()!.preview!(workspace, 'cached')
  ;[...surface.querySelectorAll('button')].find(x => x.textContent === 'Return to local')!.click()
  resolve({ ok: true, json: async () => ({ copy }) }); await pending
  expect(surface.hidden).toBe(true)
})

function savedCopy(sessionId = 'cached') {
  return { meta: { hostId: workspace.hostId, workspaceId: workspace.workspaceId, sessionId, title: 'Generated saved conversation', savedAt: 1, complete: true },
    records: [{ type: 'event', event: { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'Generated cached message during remote startup' }] } } }] }
}

it('shows a cache read that finishes after the remote loading panel has opened', async () => {
  const f = fixture()
  let resolve!: (value: any) => void
  f.fetch.mockImplementationOnce(async () => new Promise(value => { resolve = value }))
  const view = await f.start(workspace, undefined, 'cached')
  expect(view.guest.isConnected).toBe(true)
  resolve({ ok: true, json: async () => ({ copy: savedCopy() }) })
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Saved remote history"]')).not.toBeNull())
  const surface = document.querySelector<HTMLElement>('[data-dsh-remote-desktop]')!
  expect(surface.textContent).toContain('Generated cached message during remote startup')
  expect(view.guest.parentElement!.hidden).toBe(false)
  expect(view.guest.inert).toBe(true)
  view.guest.dispatchEvent(new Event('dom-ready')); await view.promise
  expect(surface.querySelector('[aria-label="Saved remote history"]')).toBeNull()
  expect(view.guest.inert).toBe(false)
})

it('keeps the guest in layout behind an early saved preview until its native client is ready', async () => {
  const f = fixture()
  f.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ copy: savedCopy() }) } as any)
  const view = await f.start(workspace, undefined, 'cached')
  const saved = document.querySelector<HTMLElement>('[aria-label="Saved remote history"]')!
  expect(saved).not.toBeNull(); expect(saved.parentElement!.hidden).toBe(false)
  expect(view.guest.parentElement!.hidden).toBe(false)
  expect(view.guest.hidden).toBe(false); expect(view.guest.style.display).toBe('flex')
  view.guest.dispatchEvent(new Event('dom-ready')); await view.promise
  expect(saved.isConnected).toBe(false)
})

it('does not replace a ready conversation when its initial disk read finishes late', async () => {
  const f = fixture()
  let resolve!: (value: any) => void
  f.fetch.mockImplementationOnce(async () => new Promise(value => { resolve = value }))
  const view = await f.start(workspace, undefined, 'cached')
  view.guest.dispatchEvent(new Event('dom-ready')); await view.promise
  resolve({ ok: true, json: async () => ({ copy: savedCopy() }) })
  for (let n = 0; n < 8; n++) await Promise.resolve()
  expect(document.querySelector('[aria-label="Saved remote history"]')).toBeNull()
  expect(view.guest.inert).toBe(false)
})

it('rejects another session preview after a different remote view takes ownership', async () => {
  const f = fixture()
  let resolve!: (value: any) => void
  f.fetch.mockImplementationOnce(async () => new Promise(value => { resolve = value }))
  const pending = remotePresentation()!.preview!(workspace, 'cached')
  const view = await f.start({ ...workspace, id: 'other-workspace', workspaceId: 'other-remote-work' }, undefined, 'other-session')
  resolve({ ok: true, json: async () => ({ copy: savedCopy() }) }); await pending
  expect(document.querySelector('[aria-label="Saved remote history"]')).toBeNull()
  view.guest.dispatchEvent(new Event('dom-ready')); await view.promise
})

it('requires draft-loss confirmation before releasing a Host view without any remote operation', async () => {
  const f = fixture(), view = await f.start()
  view.guest.dispatchEvent(new Event('dom-ready')); await view.promise
  const confirmation = vi.spyOn(window, 'confirm').mockReturnValue(false)
  await remotePresentation()!.close!(workspace)
  expect(view.guest.isConnected).toBe(true); expect(f.bridge.release).not.toHaveBeenCalled()
  confirmation.mockReturnValue(true); await remotePresentation()!.close!(workspace)
  expect(view.guest.isConnected).toBe(false); expect(f.bridge.release).toHaveBeenCalledExactlyOnceWith('lease-0')
  expect(f.fetch).toHaveBeenCalledOnce()
})

it('routes model settings only to the requested retained Host, without opening a connection or retargeting on late completion',async()=>{
  const f=fixture(),secondWorkspace={...workspace,id:'second',hostId:'b'.repeat(24),alias:'second'}
  expect(await remotePresentation()!.settings!(workspace)).toBe(false)
  expect(f.fetch).not.toHaveBeenCalled();expect(f.bridge.acquire).not.toHaveBeenCalled()
  const first=await f.start();first.guest.dispatchEvent(new Event('dom-ready'));await first.promise
  const second=await f.start(secondWorkspace);second.guest.dispatchEvent(new Event('dom-ready'));await second.promise
  first.guest.executeJavaScript.mockClear();second.guest.executeJavaScript.mockClear()
  let finish!:(ok:boolean)=>void
  first.guest.executeJavaScript.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
  const pending=remotePresentation()!.settings!(workspace)
  await vi.waitFor(()=>expect(first.guest.executeJavaScript).toHaveBeenCalled())
  expect(first.guest.executeJavaScript.mock.calls.filter(([code])=>code==='Boolean(window.__dshSshView?.settings?.())')).toHaveLength(1)
  expect(second.guest.executeJavaScript.mock.calls.every(([code])=>code.includes('__dshSshDrafts.flush')||code.includes('"visible"'))).toBe(true)
  await openRemoteWorkspace(secondWorkspace)
  finish(true);expect(await pending).toBe(true)
  expect(second.guest.hidden).toBe(false);expect(first.guest.hidden).toBe(true)
  expect(f.fetch).toHaveBeenCalledTimes(2);expect(f.guests).toHaveLength(2)
})

it('does not show a superseded retained Session after its native selection resolves late',async()=>{
  const f=fixture(),first=await f.start();first.guest.dispatchEvent(new Event('dom-ready'));await first.promise
  const secondWorkspace={...workspace,id:'second',hostId:'b'.repeat(24),alias:'second'}
  const second=await f.start(secondWorkspace);second.guest.dispatchEvent(new Event('dom-ready'));await second.promise
  let finish!:(ok:boolean)=>void
  first.guest.executeJavaScript.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
  const observer=new AbortController(),pending=remotePresentation()!.resume(workspace,'superseded',observer.signal)
  const rejected=expect(pending).rejects.toMatchObject({name:'AbortError'})
  await vi.waitFor(()=>expect(first.guest.executeJavaScript.mock.calls.some(([code])=>code.includes('__dshSshView?.select'))).toBe(true))
  observer.abort();finish(true);await rejected
  expect(first.guest.hidden).toBe(true);expect(second.guest.hidden).toBe(false)
  expect(f.fetch).toHaveBeenCalledTimes(2)
})
it('waits for a Promise returned by the remote selector rather than accepting the Promise as true',async()=>{
  const f=fixture(),view=await f.start();view.guest.dispatchEvent(new Event('dom-ready'));await view.promise
  vi.stubGlobal('__dshSshView',{select:async()=>false})
  view.guest.executeJavaScript.mockImplementation(async(code:string)=>code.includes('__dshSshView?.select')?await new Function(`return ${code}`)():true)
  await openRemoteWorkspace(workspace,'cold')
  expect(f.fetch.mock.calls.filter(([url])=>String(url).endsWith('/remote/open'))).toHaveLength(2)
  expect(view.guest.loadURL).toHaveBeenCalledOnce()
})
it('retains an unsaved Host view when switching or closing cannot confirm its draft',async()=>{
  const f=fixture(),view=await f.start();view.guest.dispatchEvent(new Event('dom-ready'));await view.promise
  view.guest.executeJavaScript.mockImplementation(async(code:string)=>!code.includes('__dshSshDrafts.flush'))
  await expect(openRemoteWorkspace(workspace,'different')).rejects.toMatchObject({name:'DraftSaveError'})
  vi.spyOn(window,'confirm').mockReturnValue(true)
  await expect(remotePresentation()!.close!(workspace)).rejects.toMatchObject({name:'DraftSaveError'})
  expect(view.guest.isConnected).toBe(true)
  expect(f.bridge.release).not.toHaveBeenCalled()
  expect(f.fetch).toHaveBeenCalledOnce()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('draft')
  const recovery=[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent==='Review unsaved text')!
  expect(recovery).toBeDefined();recovery.click()
  await vi.waitFor(()=>expect(view.guest.executeJavaScript).toHaveBeenCalledWith('Boolean(window.__dshSshDrafts?.openRecovery?.())'))
  await vi.waitFor(()=>expect(recovery.disabled).toBe(false))
  view.guest.executeJavaScript.mockImplementation(async()=>false);recovery.click()
  await vi.waitFor(()=>expect(document.querySelector('[role="alert"]')?.textContent).toContain('current conversation input'))
  expect(view.guest.isConnected).toBe(true);expect(f.bridge.release).not.toHaveBeenCalled();expect(f.fetch).toHaveBeenCalledOnce()
})
