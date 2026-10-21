// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceFlow } from '../src/client/WorkspaceFlow.tsx'
import { WorkspaceSurface } from '../src/client/workspace-surfaces.tsx'
import { mountWorkspaceStatus } from '../src/client/workspace-status.ts'
import type { SshApi } from '../src/client/api.ts'
import type { SshWorkspace } from '../src/workspaces.ts'
import { connectRemoteWorkspace, openRemoteWorkspace } from '../src/client/remote-workspaces.ts'
import { RemoteRequestError } from '../src/client/remote-errors.ts'
import type { HostPayload, SshHostSummary } from '../src/protocol.ts'
import { hostHistoryId, readRecentHostIds } from '../src/client/host-picker-history.ts'
vi.mock('../src/client/remote-workspaces.ts', () => ({ connectRemoteWorkspace: vi.fn(), openRemoteWorkspace: vi.fn() }));
vi.mock('../src/client/panel/TerminalTab.tsx', () => ({
  TerminalTab: ({ lockedAlias, remoteCwd, autoConnect }: { lockedAlias: string; remoteCwd: string; autoConnect: boolean }) =>
    <div data-ssh-terminal={`${lockedAlias}:${remoteCwd}:${autoConnect}`} />,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) act(dispose)
  vi.useRealTimers(); document.body.replaceChildren()
  vi.clearAllMocks()
  localStorage.clear()
})
const binding: SshWorkspace = { title: 'project [SSH:fixture]', alias: 'fixture', remotePath: '/remote/project', localPath: '/identities/project' }
const fixtureHost: SshHostSummary = { alias: 'fixture', host: 'example.test', port: 22, user: 'me', auth: 'key', keyReady: true,
  proxyJump: [], tags: [], passwordAvailable: false, passwordRemembered: false, createdAt: 1, updatedAt: 1 }
const makeApi = () => ({
  listHosts: vi.fn(async () => [fixtureHost]),
  updateHost: vi.fn(async (_alias: string, _patch: Partial<HostPayload>) => ({ ...fixtureHost, updatedAt: 2 })),
  listWorkspaces: vi.fn(async () => [binding]),
  connectionStatus: vi.fn(async () => [{ alias: 'fixture', state: 'connected' }]),
  createWorkspace: vi.fn(async () => binding),
  previewSshConfig: vi.fn(async () => ({ parsed: 2, candidates: [
    { alias: 'one', host: 'one.test', port: 22, user: 'me', auth: 'key' as const, proxyJump: [], hasProxyCommand: false },
    { alias: 'two', host: 'two.test', port: 22, user: 'me', auth: 'key' as const, proxyJump: [], hasProxyCommand: false },
  ], skippedBlocks: [] })),
  importSshConfig: vi.fn(async (_aliases: string[]) => ({ parsed: 2, added: 1, skipped: 0, skippedBlocks: [] })),
  browseDirectories: vi.fn(async (_alias: string, path: string, prefix = '') => ({
    path: path === '~' ? '/remote/home' : path.replace(/\/$/, ''),
    directories: (path === '~' ? ['alpha', 'beta'] : path.replace(/\/$/, '') === '/remote/home/alpha' ? ['nested'] : [])
      .filter(name => name.startsWith(prefix)), truncated: false,
  })),
})
const button = (text: string) => [...document.querySelectorAll('button')].find(item => item.textContent === text)!

describe('Add workspace', () => {
  async function mount(api: ReturnType<typeof makeApi>, pickLocal = vi.fn(async () => '/local/project')) {
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container); disposers.push(() => root.unmount())
    const onPicked = vi.fn(), onCancel = vi.fn()
    await act(async () => root.render(<WorkspaceFlow open busy={false} api={api as unknown as SshApi} pickLocal={pickLocal} onPicked={onPicked} onCancel={onCancel} onError={vi.fn()} />))
    return { onPicked, onCancel, pickLocal }
  }
  async function chooseHost(alias = 'fixture') {
    if (!document.querySelector('[role="combobox"]')) await act(async () => button('更换主机').click())
    await act(async () => {
      const search = document.querySelector<HTMLInputElement>('[role="combobox"]')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, alias)
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => document.querySelector<HTMLButtonElement>(`[data-host-alias="${alias}"]`)!.click())
  }
  it('opens with no selected host and never probes on selection, typing or host switching', async () => {
    vi.useFakeTimers()
    const api = makeApi()
    api.listHosts.mockResolvedValue([fixtureHost, { ...fixtureHost, alias: 'other' }])
    await mount(api)
    expect(api.previewSshConfig).not.toHaveBeenCalled()
    await act(async () => button('SSH 远程工作区').click())
    expect(document.querySelector<HTMLInputElement>('[role="combobox"]')!.value).toBe('')
    expect(button('连接并添加').disabled).toBe(true)
    await chooseHost()
    const input = document.querySelector<HTMLInputElement>('input[placeholder="~/projects/my-project"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '/work/')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(api.browseDirectories).not.toHaveBeenCalled()
    await act(async () => button('浏览远端目录').click())
    await act(async () => button('更换主机').click())
    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(api.browseDirectories).not.toHaveBeenCalled()
    // Switching before the debounce must not probe either the old or new host.
    await chooseHost('other')
    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(api.browseDirectories).not.toHaveBeenCalled()
    expect(connectRemoteWorkspace).not.toHaveBeenCalled()
    expect(api.importSshConfig).not.toHaveBeenCalled()
    await act(async () => button('浏览远端目录').click())
    await act(async () => vi.advanceTimersByTimeAsync(260))
    expect(api.browseDirectories).toHaveBeenCalledExactlyOnceWith('other', '~', '')
  })
  it('previews config on request, cancels without saving, and adds only checked hosts without probing', async () => {
    const api = makeApi(), view = await mount(api)
    await act(async () => button('SSH 远程工作区').click())
    const openPicker = async () => { await act(async () => button('导入 ~/.ssh/config').click()) }
    await openPicker()
    expect(document.querySelector('[aria-label="添加工作区"]')?.getAttribute('aria-hidden')).toBe('true')
    expect(api.previewSshConfig).toHaveBeenCalledOnce()
    expect([...document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].every(input => !input.checked)).toBe(true)
    expect(button('加入所选主机').disabled).toBe(true)
    const picker = document.querySelector('[role=dialog][aria-label="从 SSH 配置选择主机"]')!
    await act(async () => picker.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(view.onCancel).not.toHaveBeenCalled()
    expect(api.importSshConfig).not.toHaveBeenCalled()
    await openPicker()
    await act(async () => document.querySelector<HTMLInputElement>('input[type=checkbox][aria-label=two]')!.click())
    await act(async () => button('加入所选主机').click())
    expect(api.importSshConfig).toHaveBeenCalledExactlyOnceWith(['two'])
    expect(document.querySelector('[data-selected-host]')).toBeNull()
    expect(api.browseDirectories).not.toHaveBeenCalled()
    expect(connectRemoteWorkspace).not.toHaveBeenCalled()
  })
  it('preserves the local picker and opens the remote runtime without creating a local session', async () => {
    vi.mocked(connectRemoteWorkspace).mockResolvedValue({ id: 'remote', hostId: 'host', alias: 'fixture', title: 'remote', remotePath: '/remote/project', workspaceId: 'remote-workspace' })
    const api = makeApi(), view = await mount(api)
    await act(async () => button('本地文件夹').click())
    expect(view.onPicked).toHaveBeenCalledWith('/local/project')
    expect(api.createWorkspace).not.toHaveBeenCalled()
    await act(async () => button('SSH 远程工作区').click())
    await chooseHost()
    expect(document.querySelector('[data-selected-host]')?.getAttribute('data-selected-host')).toBe('fixture')
    expect(document.querySelector('[role="dialog"]')?.parentElement?.parentElement).toBe(document.body)
    await act(async () => button('连接并添加').click())
    expect(connectRemoteWorkspace).toHaveBeenCalledWith('fixture', '~', expect.any(Function), { signal: expect.any(AbortSignal) })
    expect(openRemoteWorkspace).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workspaceId: 'remote-workspace' }), undefined, { signal: expect.any(AbortSignal) })
    expect(api.createWorkspace).not.toHaveBeenCalled()
    expect(view.onPicked).toHaveBeenCalledTimes(1)
    expect(readRecentHostIds()).toEqual([hostHistoryId(fixtureHost)])
  })
  it('keeps failed SSH creation visible without adopting a local workspace or retrying', async () => {
    const api = makeApi(); vi.mocked(connectRemoteWorkspace).mockRejectedValue(new Error('Host key not trusted'))
    const view = await mount(api)
    await act(async () => button('SSH 远程工作区').click())
    await chooseHost()
    await act(async () => button('连接并添加').click())
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Host key not trusted')
    expect(view.onPicked).not.toHaveBeenCalled()
    expect(connectRemoteWorkspace).toHaveBeenCalledTimes(1)
    expect(openRemoteWorkspace).not.toHaveBeenCalled()
    expect(view.pickLocal).not.toHaveBeenCalled()
    expect(readRecentHostIds()).toEqual([])
  })
  it('disables old-host actions while replacing a selection and Escape keeps that selection', async () => {
    const api = makeApi(), view = await mount(api)
    await act(async () => button('SSH 远程工作区').click())
    await chooseHost()
    const path = document.querySelector<HTMLInputElement>('input[placeholder="~/projects/my-project"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(path, '/keep/path')
      path.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('更换主机').click())
    expect(button('连接并添加').disabled).toBe(true)
    expect(button('浏览远端目录').disabled).toBe(true)
    await act(async () => document.querySelector('[role="combobox"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(view.onCancel).not.toHaveBeenCalled()
    expect(document.querySelector('[data-selected-host]')?.getAttribute('data-selected-host')).toBe('fixture')
    expect(button('连接并添加').disabled).toBe(false)
    expect(path.value).toBe('/keep/path')
    await chooseHost()
    expect(path.value).toBe('/keep/path')
    expect(api.browseDirectories).not.toHaveBeenCalled()
    expect(connectRemoteWorkspace).not.toHaveBeenCalled()
  })
  it('edits a fallback inside the workspace flow without repeating workspace creation or closing the parent', async () => {
    vi.useFakeTimers()
    const api = makeApi(), view = await mount(api)
    await act(async () => button('SSH 远程工作区').click())
    await chooseHost()
    await act(async () => button('认证 / 回退密码').click())
    expect(document.querySelector('[role="dialog"][aria-label="添加工作区"]')?.getAttribute('aria-hidden')).toBe('true')
    const password = [...document.querySelectorAll('input')].find(input => input.type === 'password' && input.autocomplete === 'off')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(password, 'fixture-password')
      password.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('保存').click())
    expect(api.updateHost).toHaveBeenCalledWith('fixture', expect.objectContaining({ auth: expect.objectContaining({ kind: 'key', password: 'fixture-password', rememberPassword: false }) }))
    await act(async () => vi.advanceTimersByTimeAsync(260))
    expect(api.browseDirectories).not.toHaveBeenCalled()
    expect(connectRemoteWorkspace).not.toHaveBeenCalled()
    expect(api.createWorkspace).not.toHaveBeenCalled()
    expect(view.onCancel).not.toHaveBeenCalled()
    expect(button('连接并添加')).toBeTruthy()
  })
  it('can create a host directly inside the Add workspace flow', async () => {
    await mount(makeApi())
    await act(async () => button('SSH 远程工作区').click())
    await chooseHost()
    await act(async () => button('新增主机').click())
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2)
    expect([...document.querySelectorAll('h3')].map(item => item.textContent)).toContain('新增主机')
  })
  it('leaves setup in the background and suppresses a late launch even if its parent has not closed yet', async () => {
    let complete!: (value: Awaited<ReturnType<typeof connectRemoteWorkspace>>) => void
    let signal!: AbortSignal
    vi.mocked(connectRemoteWorkspace).mockImplementation((_alias, _path, progress, options) => {
      signal = options!.signal!; progress('Checking', { id: 'background', alias: 'fixture', phase: 'checking', message: 'Checking' })
      return new Promise(resolve => { complete = resolve })
    })
    const view = await mount(makeApi())
    await act(async () => button('SSH 远程工作区').click())
    await chooseHost()
    await act(async () => button('连接并添加').click())
    expect(button('留在后台准备').disabled).toBe(false)
    await act(async () => button('留在后台准备').click())
    expect(signal.aborted).toBe(true); expect(view.onCancel).toHaveBeenCalledOnce()
    await act(async () => complete({ id: 'ready', hostId: 'host', alias: 'fixture', title: 'remote', remotePath: '/remote/project', workspaceId: 'remote-workspace' }))
    expect(openRemoteWorkspace).not.toHaveBeenCalled(); expect(connectRemoteWorkspace).toHaveBeenCalledOnce()
    expect(readRecentHostIds()).toEqual([])
  })
  it('shows a brief path failure and preserves its exact original error in a disclosure', async () => {
    const original = 'cannot create a Workspace: EACCES /remote/restricted/folder'
    vi.mocked(connectRemoteWorkspace).mockRejectedValue(new RemoteRequestError(original, 'workspace/invalid-path'))
    await mount(makeApi()); await act(async () => button('SSH 远程工作区').click())
    await chooseHost()
    await act(async () => button('连接并添加').click())
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('无法打开此远端目录。')
    expect(document.querySelector('details')?.open).toBe(false)
    expect(document.querySelector('details pre')?.textContent).toBe(original)
    expect(openRemoteWorkspace).not.toHaveBeenCalled()
  })
  it('browses only on an explicit request, enters a child and selects its canonical path', async () => {
    vi.useFakeTimers()
    const api = makeApi(); await mount(api)
    await act(async () => button('SSH 远程工作区').click())
    await chooseHost()
    await act(async () => button('浏览远端目录').click())
    await act(async () => vi.advanceTimersByTimeAsync(260))
    expect(api.browseDirectories).toHaveBeenCalledWith('fixture', '~', '')
    const directory = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[data-directory-choice]')]
      .find(item => item.textContent?.includes(name))
    expect(directory('alpha')).toBeTruthy()
    const input = document.querySelector<HTMLInputElement>('input[placeholder="~/projects/my-project"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '~/al')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => vi.advanceTimersByTimeAsync(260))
    expect(api.browseDirectories).toHaveBeenCalledTimes(1)
    await act(async () => button('浏览远端目录').click())
    await act(async () => vi.advanceTimersByTimeAsync(260))
    expect(api.browseDirectories).toHaveBeenCalledWith('fixture', '~', 'al')
    expect(directory('beta')).toBeUndefined()
    await act(async () => directory('alpha')!.click())
    await act(async () => vi.advanceTimersByTimeAsync(260))
    expect(input.value).toBe('/remote/home/alpha/')
    expect(directory('nested')).toBeTruthy()
    await act(async () => button('选择此目录').click())
    expect(input.value).toBe('/remote/home/alpha')
    expect(button('浏览远端目录')).toBeTruthy()
    await act(async () => button('浏览远端目录').click())
    await act(async () => vi.advanceTimersByTimeAsync(260))
    expect(api.browseDirectories).toHaveBeenLastCalledWith('fixture', '/remote/home/alpha', '')
    expect(directory('nested')).toBeTruthy()
  })
})

describe('workspace connectivity lamps', () => {
  const rows = () => {
    document.body.innerHTML = `<aside data-pane="sidebar"><div role="treeitem" class="projectRow_test"><span class="projectText_test"><span class="title_test">${binding.title}</span></span></div><div role="treeitem" class="projectRow_test"><span class="projectText_test"><span class="title_test">Local</span></span></div></aside>`
  }
  it('updates real remote rows, marks failed polling unknown, heals remounts and removes owned nodes', async () => {
    vi.useFakeTimers(); rows()
    const api = makeApi()
    const dispose = mountWorkspaceStatus(api as unknown as SshApi); disposers.push(dispose)
    await vi.advanceTimersByTimeAsync(30)
    expect(document.querySelectorAll('[data-dsh-ssh-status]')).toHaveLength(1)
    expect(document.querySelector('[data-dsh-ssh-status]')?.getAttribute('data-state')).toBe('connected')
    api.connectionStatus.mockRejectedValue(new Error('server offline'))
    await vi.advanceTimersByTimeAsync(5030)
    expect(document.querySelector('[data-dsh-ssh-status]')?.getAttribute('data-state')).toBe('unknown')
    api.connectionStatus.mockResolvedValue([{ alias: 'fixture', state: 'disconnected' }])
    rows()
    await vi.advanceTimersByTimeAsync(5030)
    expect(document.querySelector('[data-dsh-ssh-status]')?.getAttribute('data-state')).toBe('disconnected')
    dispose()
    expect(document.querySelector('[data-dsh-ssh-status]')).toBeNull()
    const calls = api.connectionStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(api.connectionStatus).toHaveBeenCalledTimes(calls)
  })
})

it('never mounts native local file/terminal panels on an SSH workspace, including while the session is loading', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); disposers.push(() => root.unmount())
  const original = vi.fn(() => <div>Native local panel</div>)
  const openSsh = vi.fn()
  const render = async (cwd?: string, surface: 'body' | 'title' | 'hidden' = 'body') => {
    const props = { original, openSsh, surface, sessionId: 'fixture', useSessions: (select: (state: unknown) => unknown) => select({ byId: { fixture: { cwd } } }) }
    await act(async () => root.render(<WorkspaceSurface {...props as unknown as Parameters<typeof WorkspaceSurface>[0]} />))
  }
  await render()
  await render('/private/profile/ssh-workspaces/identity/project')
  expect(original).not.toHaveBeenCalled()
  await act(async () => button('打开 SSH 面板').click())
  expect(openSsh).toHaveBeenCalledTimes(1)
  await render('/private/profile/ssh-workspaces/identity/project', 'title')
  await render('/private/profile/ssh-workspaces/identity/project', 'hidden')
  expect(original).not.toHaveBeenCalled()
  await render('/local/project')
  expect(original).toHaveBeenCalledTimes(1)
})

it('binds the right-sidebar terminal to the old session host and remote directory only', async () => {
  const cwd = '/private/profile/ssh-workspaces/identity/project'
  const api = makeApi()
  api.listWorkspaces.mockResolvedValue([{ ...binding, localPath: cwd }])
  const original = vi.fn(() => <div>Native local terminal</div>)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); disposers.push(() => root.unmount())
  const render = async (path: string) => {
    const props = { original, openSsh: vi.fn(), surface: 'terminal', api: api as unknown as SshApi,
      sessionId: 'fixture', useSessions: (select: (state: unknown) => unknown) => select({ byId: { fixture: { cwd: path } } }) }
    await act(async () => root.render(<WorkspaceSurface {...props as unknown as Parameters<typeof WorkspaceSurface>[0]} />))
  }
  await render(cwd)
  expect(container.querySelector('[data-ssh-terminal]')?.getAttribute('data-ssh-terminal')).toBe('fixture:/remote/project:true')
  expect(original).not.toHaveBeenCalled()
  await render('/private/profile/ssh-workspaces/other/project')
  expect(container.querySelector('[data-ssh-terminal]')).toBeNull()
  expect(container.textContent).toContain('未找到此会话的 SSH 工作区绑定')
  expect(original).not.toHaveBeenCalled()
})
