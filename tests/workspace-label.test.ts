// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { remoteWorkspaceName } from '../src/client/workspace-label.ts'
import { mountWorkspaceStatus } from '../src/client/workspace-status.ts'
import { remoteNavigation, remoteWorkspaceKey } from '../src/client/remote-navigation.ts'
import type { SshApi } from '../src/client/api.ts'

let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); dispose = undefined; remoteNavigation.clear(); document.body.replaceChildren(); vi.useRealTimers(); document.documentElement.lang = '' })

it('keeps custom titles and literal alias characters intact', () => {
  expect(remoteWorkspaceName({ title: 'notes [SSH:other]', alias: 'fixture' })).toBe('notes [SSH:other]')
  expect(remoteWorkspaceName({ title: 'notes [SSH:a[b].*]', alias: 'a[b].*' })).toBe('notes')
  expect(remoteWorkspaceName({ title: ' [SSH:fixture]', alias: 'fixture' })).toBe(' [SSH:fixture]')
})

it('labels same-name native projects by their routing identities and restores native DOM on unload', async () => {
  vi.useFakeTimers(); document.documentElement.lang = 'en'
  const a = { id: 'a', hostId: 'a'.repeat(24), alias: 'macbook', title: 'project [SSH:macbook]', remotePath: '/a', workspaceId: 'same' }
  const b = { ...a, id: 'b', hostId: 'b'.repeat(24), alias: '<img src=x>', remotePath: '/b' }
  remoteNavigation.update([a, b], [{ hostId: a.hostId, phase: 'ready' }, { hostId: b.hostId, phase: 'disconnected' }])
  document.body.innerHTML = `<aside data-pane="sidebar">${[a,b].map(workspace => `<div role="treeitem" draggable="true" class="projectRow_test" data-row-key="workspace:${remoteWorkspaceKey(workspace)}"><span class="projectText_test"><span class="title_test">project</span></span></div>`).join('')}<div role="treeitem" class="projectRow_test"><span class="projectText_test"><span class="title_test">project</span></span></div></aside>`
  const api = { listWorkspaces: async () => [], connectionStatus: async () => [] }
  dispose = mountWorkspaceStatus(api as unknown as SshApi)
  await vi.advanceTimersByTimeAsync(30)
  const badges = [...document.querySelectorAll<HTMLElement>('[data-dsh-remote-host]')]
  expect(badges.map(badge => badge.getAttribute('aria-label'))).toEqual(['Remote host: macbook', 'Remote host: <img src=x>'])
  expect(badges.map(badge => badge.title)).toEqual(['Remote host: macbook\n/a', 'Remote host: <img src=x>\n/b'])
  expect(document.querySelector('img')).toBeNull()
  expect(document.querySelectorAll('[data-dsh-ssh-status]')).toHaveLength(2)
  expect([...document.querySelectorAll<HTMLElement>('[data-dsh-ssh-status]')].map(dot => dot.dataset.state)).toEqual(['connected', 'disconnected'])
  expect(badges.every(badge => !badge.hasAttribute('tabindex'))).toBe(true)
  // A native rerender can replace only its owned title. No duplicate badges or callbacks.
  document.querySelector('.title_test')!.textContent = 'renamed project'
  remoteNavigation.update([a, b])
  expect(document.querySelectorAll('[data-dsh-remote-host]')).toHaveLength(2)
  expect(document.querySelector('.title_test')?.textContent).toBe('renamed project')
  remoteNavigation.update([b])
  expect(document.querySelectorAll('[data-dsh-remote-host]')).toHaveLength(1)
  dispose(); dispose = undefined
  expect(document.querySelectorAll('[data-dsh-remote-host], [data-dsh-ssh-status]')).toHaveLength(0)
  expect([...document.querySelectorAll('[class*="projectText"]')].every(node => node.className === 'projectText_test')).toBe(true)
  expect(document.querySelector('[draggable]')?.getAttribute('draggable')).toBe('true')
})
