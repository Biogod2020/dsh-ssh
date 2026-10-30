// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { mountDesktopWorkspaces } from '../src/client/desktop-workspace.ts'
import { openRemoteWorkspace } from '../src/client/remote-workspaces.ts'
import { createWebGuest } from '../src/client/web-guest.ts'

vi.mock('../src/client/web-guest.ts', () => ({ createWebGuest: vi.fn(() => {
  const frame = document.createElement('iframe')
  return Object.assign(frame, { loadURL: vi.fn(async (url: string) => { frame.src = url }), control: vi.fn(async () => true) })
}) }))
let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); dispose = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })

it('attaches a Web guest with its actual destination and never starts the Desktop blank lease navigation', async () => {
  vi.stubGlobal('dshDesktop', undefined)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ url: 'http://127.0.0.1:40200/?dsh-remote-ticket=generated-only', sessionId: 'generated-session' }) })))
  let firstNavigation = ''
  const append = Element.prototype.append
  vi.spyOn(Element.prototype, 'append').mockImplementation(function (this: Element, ...nodes: (Node | string)[]) {
    for (const node of nodes) if (node instanceof HTMLIFrameElement && !node.isConnected) firstNavigation = node.src
    append.apply(this, nodes)
  })
  dispose = mountDesktopWorkspaces(undefined, { get: () => undefined, slots: {} } as any)
  expect(dispose).toBeTypeOf('function')
  await openRemoteWorkspace({ id: 'generated', hostId: 'a'.repeat(24), alias: 'fixture', remotePath: '/generated', workspaceId: 'generated-workspace', title: 'Generated' })
  expect(new URL(firstNavigation).origin).toBe('http://127.0.0.1:40200')
  expect(new URL(firstNavigation).searchParams.get('dsh-remote-view')).toBe('desktop')
  expect(vi.mocked(createWebGuest).mock.results.at(-1)!.value.loadURL).toHaveBeenCalledOnce()
})
