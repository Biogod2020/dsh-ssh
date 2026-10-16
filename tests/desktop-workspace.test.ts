// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { mountDesktopWorkspaces } from '../src/client/desktop-workspace.ts'
import { openRemoteWorkspace } from '../src/client/remote-workspaces.ts'
import type { RemoteWorkspace } from '../src/remote/types.ts'

const workspace: RemoteWorkspace = { id: 'fixture', hostId: 'a'.repeat(24), alias: 'fixture', remotePath: '/work', title: 'work', workspaceId: 'remote-work' }
let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); dispose = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })
function fixture() {
  document.documentElement.lang = 'en'
  const local = document.createElement('button'); local.textContent = 'Local draft'; document.body.append(local); local.focus()
  const guests: Array<HTMLElement & { loadURL: ReturnType<typeof vi.fn>; insertCSS: ReturnType<typeof vi.fn> }> = []
  const create = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((name: string, options?: ElementCreationOptions) => {
    const node = create(name, options)
    if (name === 'webview') {
      const guest = Object.assign(node, { loadURL: vi.fn(async (_url: string) => {}), insertCSS: vi.fn(async () => '') })
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
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ url: 'http://127.0.0.1:40200/?dsh-remote-ticket=private-fixture-ticket' }) }))
  vi.stubGlobal('fetch', fetch)
  dispose = mountDesktopWorkspaces()
  const start = async (value = workspace, signal?: AbortSignal) => {
    const promise = openRemoteWorkspace(value, undefined, { signal })
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
  expect(f.bridge.acquire).toHaveBeenCalledWith(`dsh-ssh:${workspace.hostId}:fixture`)
  expect(guest.loadURL).not.toHaveBeenCalled()
  guest.dispatchEvent(new Event('dom-ready')); await promise
  expect(guest.loadURL).toHaveBeenCalledOnce()
  expect(new URL(guest.loadURL.mock.calls[0]![0]!).searchParams.get('dsh-remote-view')).toBe('desktop')
  expect(window.location.href).toBe(original)
  expect(f.local.inert).toBe(true)
  // Closing the Add workspace observer after opening must not kill the view.
  lifetime.abort(); expect(f.bridge.release).not.toHaveBeenCalled()
  const back = [...document.querySelectorAll('button')].find(button => button.textContent === 'Return to local')!
  back.click(); expect(f.local.inert).not.toBe(true)
  expect(guest.isConnected).toBe(true)
  await openRemoteWorkspace(workspace)
  expect(f.fetch).toHaveBeenCalledOnce(); expect(guest.loadURL).toHaveBeenCalledOnce()
  expect(document.querySelector<HTMLElement>('[data-dsh-remote-desktop]')!.hidden).toBe(false)
  dispose!(); expect(f.bridge.release).toHaveBeenCalledExactlyOnceWith('lease-0')
  expect(f.local.inert).not.toBe(true)
})

it('keeps different workspaces separate and blocks silent session/host retargeting', async () => {
  const f = fixture(), first = await f.start()
  first.guest.dispatchEvent(new Event('dom-ready')); await first.promise
  const second = await f.start({ ...workspace, id: 'second', hostId: 'b'.repeat(24), alias: 'second' })
  second.guest.dispatchEvent(new Event('dom-ready')); await second.promise
  expect(first.guest.hidden).toBe(true); expect(second.guest.hidden).toBe(false)
  await openRemoteWorkspace(workspace)
  expect(first.guest.hidden).toBe(false); expect(second.guest.hidden).toBe(true)
  await expect(openRemoteWorkspace({ ...workspace, hostId: 'c'.repeat(24) })).rejects.toThrow('identity changed')
  await expect(openRemoteWorkspace(workspace, 'different-session')).rejects.toThrow('already open')
  expect(f.guests).toHaveLength(2)
  expect(f.guests.every(guest => guest.loadURL.mock.calls.length === 1)).toBe(true)
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
  f.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ url: 'https://untrusted.test/?dsh-remote-ticket=ticket' }) })
  await expect(openRemoteWorkspace(workspace)).rejects.toThrow('Invalid remote workspace gateway')
  expect(f.bridge.acquire).not.toHaveBeenCalled()
  const view = await f.start(); view.guest.dispatchEvent(new Event('dom-ready')); await view.promise
  const request = f.links.get('lease-0')!
  request('https://untrusted.test/'); request('http://127.0.0.1:3080/'); request('javascript:alert(1)')
  expect(view.guest.loadURL).toHaveBeenCalledOnce()
  request('http://127.0.0.1:40200/help'); expect(view.guest.loadURL).toHaveBeenCalledTimes(2)
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
