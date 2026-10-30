// @vitest-environment jsdom
import { act, createElement, useEffect, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SlotCore, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SshApi } from '../src/client/api.ts'
import { mountWorkspaceFlows } from '../src/client/workspace-flow.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const names = ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow']
let root: Root | undefined, release: (() => void) | undefined
afterEach(async () => {
  await act(async () => { root?.unmount(); release?.() })
  root = undefined; release = undefined; document.body.replaceChildren()
})
function fixture() {
  const core = new SlotCore()
  const register = core.register.bind(core) as (options: object, component: unknown) => () => void
  register({ name: 'root', children: Object.fromEntries(names.map(name => [name, { kind: 'single', scope: 'root' }])) }, () => null)
  const slots = { register, entries: core.entries.bind(core), subscribe: core.subscribe.bind(core),
    inject: (_name: string, callback: () => () => void) => callback() }
  const api = { listHosts: vi.fn(async () => []) } as unknown as SshApi
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const owner = { open: true, busy: false, onPicked: vi.fn(), onCancel: vi.fn(), onError: vi.fn() }
  const render = async (name: string, overrides = {}) => {
    const entry = [...core.entries(name)].sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0]!
    await act(async () => root!.render(createElement(entry.component as ComponentType<Record<string, unknown>>, {
      ...entry.inject?.(), ...owner, ...overrides,
    })))
  }
  return { core, register, owner, render, mount: () => { release = mountWorkspaceFlows({ slots } as unknown as Context, api) } }
}
const click = async (text: string) => {
  const button = [...document.querySelectorAll('button')].find(item => item.textContent === text)!
  await act(async () => button.click())
}

it.each(names)('retains the Web directory browser and its outcome callbacks in %s', async name => {
  const f = fixture(), listDirectory = vi.fn(async () => '/web/project'), injected = () => ({ listDirectory })
  const Browse = ({ onPicked, onCancel, onError, listDirectory: list, busy }: DirectoryFlowOwnerProps & { listDirectory: typeof listDirectory }) =>
    <section aria-label="Original Web browser">
      <button disabled={busy} onClick={() => { void list().then(onPicked) }}>Open directory</button>
      <button onClick={onCancel}>Cancel browser</button>
      <button onClick={() => onError('original error')}>Report error</button>
    </section>
  f.register({ name, inject: injected, locale: 'directory-browser' }, Browse)
  f.mount()
  expect(f.core.entries(name)[0]).toMatchObject({ inject: injected, locale: 'directory-browser' })
  await f.render(name)
  expect(listDirectory).not.toHaveBeenCalled()
  await click('本地文件夹')
  expect(document.querySelector('[aria-label="Original Web browser"]')).not.toBeNull()
  await click('Open directory')
  expect(listDirectory).toHaveBeenCalledOnce()
  expect(f.owner.onPicked).toHaveBeenCalledExactlyOnceWith('/web/project')
  await click('Cancel browser'); expect(f.owner.onCancel).toHaveBeenCalledOnce()
  await click('Report error'); expect(f.owner.onError).toHaveBeenCalledExactlyOnceWith('original error')
  await f.render(name, { busy: true })
  expect([...document.querySelectorAll('button')].find(item => item.textContent === 'Open directory')!.disabled).toBe(true)
})

it('keeps the original Desktop picker bridge and re-arms after cancellation', async () => {
  const f = fixture(), pick = vi.fn(async (): Promise<string | null> => null)
  function Native(owner: DirectoryFlowOwnerProps & { pick: typeof pick }) {
    useEffect(() => { void owner.pick().then(path => path === null ? owner.onCancel() : owner.onPicked(path)) }, [])
    return null
  }
  f.register({ name: names[0], inject: () => ({ pick }) }, Native)
  f.mount(); await f.render(names[0]!)
  expect(pick).not.toHaveBeenCalled()
  await click('本地文件夹')
  expect(pick).toHaveBeenCalledOnce(); expect(f.owner.onCancel).toHaveBeenCalledOnce()
  await f.render(names[0]!, { open: false }); await f.render(names[0]!)
  pick.mockResolvedValue('/desktop/project')
  await click('本地文件夹')
  expect(pick).toHaveBeenCalledTimes(2)
  expect(f.owner.onPicked).toHaveBeenCalledExactlyOnceWith('/desktop/project')
})

it('follows a late or replaced original occupant and restores it on plugin unload', async () => {
  const f = fixture()
  f.mount(); expect(f.core.entries(names[0]!)).toHaveLength(0)
  let remove!: () => void
  await act(async () => { remove = f.register({ name: names[0] }, () => <p>Original</p>) })
  expect(f.core.entries(names[0]!)).toHaveLength(2)
  let replacement!: StoredEntry
  await act(async () => {
    f.register({ name: names[0], priority: -10 }, () => <p>Replacement</p>)
    replacement = f.core.entries(names[0]!).find(entry => entry.options.priority === -10)!
  })
  await f.render(names[0]!); await click('本地文件夹')
  expect(document.body.textContent).toBe('Replacement')
  await act(async () => { remove(); release!() }); release = undefined
  expect(f.core.entries(names[0]!)).toEqual([replacement])
})
