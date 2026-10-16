import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as FsTools from '@deepseek-ai/dsh-tool-fs'
import * as BashTool from '@deepseek-ai/dsh-tool-bash'
import type { ToolDispatchExecution } from '@deepseek-ai/dsh-tools'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { TestSshd } from './helpers/sshd.ts'
import { HostStore } from '../src/store.ts'
import { SshEngine } from '../src/engine.ts'
import { SshWorkspaces, dispatchWorkspaceTool, installWorkspaceTools } from '../src/workspaces.ts'
import { runWorkspaceOperation } from '../src/workspace-transport.ts'
import { makeRoutes } from '../src/routes.ts'

const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-workspaces-test-'))
let sshd: TestSshd
let engine: SshEngine
let workspaces: SshWorkspaces
let remote: string
beforeAll(async () => {
  sshd = await TestSshd.start()
  remote = realpathSync(sshd.root)
  const store = new HostStore(join(dir, 'hosts.json'))
  store.create({ alias: 'fixture', host: '127.0.0.1', port: sshd.port, user: process.env.USER!, auth: { kind: 'key', keyPath: sshd.clientKey } })
  engine = new SshEngine(store)
  workspaces = new SshWorkspaces(engine, join(dir, 'workspaces'))
})
afterAll(() => { engine?.dispose(); sshd?.stop(); rmSync(dir, { recursive: true, force: true }) })
const run = (op: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, signal?: AbortSignal) =>
  runWorkspaceOperation(engine, 'fixture', { op, cwd: remote, args, ...extra }, signal)

describe('real SSH workspace execution', () => {
  it('creates a durable native-workspace identity after verifying the remote directory and reports a live connection', async () => {
    expect(engine.connectionStatus()).toEqual([{ alias: 'fixture', state: 'disconnected' }])
    const workspace = await workspaces.create('fixture', remote)
    expect(workspace.remotePath).toBe(remote)
    expect(workspace.localPath).not.toBe(remote)
    expect(statSync(workspace.localPath).isDirectory()).toBe(true)
    expect(workspaces.forCwd(workspace.localPath)).toEqual(workspace)
    expect((await workspaces.create('fixture', remote)).localPath).toBe(workspace.localPath)
    expect(engine.connectionStatus()).toEqual([{ alias: 'fixture', state: 'connected' }])
    const restart = new SshWorkspaces(engine, workspaces.root)
    expect(restart.forCwd(workspace.localPath)).toEqual(workspace)
    expect(() => restart.forCwd(join(workspaces.root, 'missing'))).toThrow('Refusing to run on this computer')
    await expect(workspaces.create('fixture', join(remote, 'missing'))).rejects.toThrow('does not exist')
  })

  it('reads, writes and edits over SSH with literal paths and guarded versions', async () => {
    const path = "space ' quote $(never).txt"
    const args = { file_path: path, content: 'one\ntwo\n' }
    const write = await run('write', args, { intent: { kind: 'createIfAbsent' } })
    expect(readFileSync(join(remote, path), 'utf8')).toBe(args.content)
    const read = await run('read', { file_path: path, offset: 2, limit: 1 })
    expect(read.value).toEqual({ path: join(remote, path), offset: 2, lines: [{ number: 2, text: 'two' }], totalLines: 2 })
    expect(read.version).toBe(write.version)
    const edit = await run('edit', { file_path: path, old_string: 'two', new_string: 'three' }, { intent: { version: read.version } })
    expect(readFileSync(join(remote, path), 'utf8')).toBe('one\nthree\n')
    await expect(run('write', args, { intent: { kind: 'replaceIfVersion', version: read.version } })).rejects.toThrow('FS_STALE_VERSION')
    await expect(run('write', args, { intent: { kind: 'createIfAbsent' } })).rejects.toThrow('FS_NOT_OBSERVED')
    const results = await Promise.allSettled([1, 2].map(i => run('write', { ...args, content: String(i) }, { intent: { kind: 'replaceIfVersion', version: edit.version } })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  })

  it('runs Bash in the remote directory, keeps stderr/exit code and enforces timeout', async () => {
    const result = await run('bash', { command: 'pwd; printf hello > bash-created.txt; printf problem >&2; exit 7' })
    expect(result.value).toMatchObject({ exitCode: 7, timedOut: false, stdout: { text: remote + '\n' }, stderr: { text: 'problem' } })
    expect(readFileSync(join(remote, 'bash-created.txt'), 'utf8')).toBe('hello')
    const timeout = await run('bash', { command: 'sleep 10', timeoutMs: 100 })
    expect(timeout.value).toMatchObject({ timedOut: true, exitCode: null })
    await expect(run('bash', { command: 'true', run_in_background: true })).rejects.toThrow('Background jobs')
  })

  it('cancels once after dispatch without replaying a side effect', async () => {
    const controller = new AbortController()
    const task = run('bash', { command: 'printf once >> count.txt; sleep 30' }, {}, controller.signal)
    const rejected = expect(task).rejects.toThrow('Not retried')
    await vi.waitFor(() => expect(existsSync(join(remote, 'count.txt'))).toBe(true))
    controller.abort()
    await rejected
    expect(readFileSync(join(remote, 'count.txt'), 'utf8')).toBe('once')
  })

  it('routes ordinary tools, preserves observation policy and never invokes the local body', async () => {
    const binding = await workspaces.create('fixture', remote)
    const observations = new Map<string, unknown>()
    const local = vi.fn(async () => ({ isError: false as const, value: {}, content: [] }))
    const context = {
      tools: { get: () => ({ parameters: { type: 'object' } }) },
      waterfall: vi.fn(async (name: string, target: { targetKey: string }) => {
        if (name === 'fs/edit-intent') {
          const observation = observations.get(target.targetKey) as { version?: string } | undefined
          if (!observation?.version) throw new Error('FS_NOT_OBSERVED')
          return { version: observation.version }
        }
        return { kind: 'createIfAbsent' }
      }),
      emit: vi.fn((_name: string, target: { targetKey: string }, observation: unknown) => { observations.set(target.targetKey, observation) }),
    } as unknown as Context
    const execution = (name: string, args: object, cwd = binding.localPath) => ({ name, arguments: args, agent: { session: { header: { cwd } } }, signal: new AbortController().signal }) as ToolDispatchExecution
    await expect(dispatchWorkspaceTool(context, workspaces, execution('read', { file_path: 'new.txt' }), local)).rejects.toThrow()
    expect([...observations.values()]).toContainEqual({ kind: 'absent' })
    await dispatchWorkspaceTool(context, workspaces, execution('write', { file_path: 'new.txt', content: 'remote only' }), local)
    expect(existsSync(join(binding.localPath, 'new.txt'))).toBe(false)
    expect(readFileSync(join(remote, 'new.txt'), 'utf8')).toBe('remote only')
    await dispatchWorkspaceTool(context, workspaces, execution('edit', { file_path: 'new.txt', old_string: 'only', new_string: 'edited' }), local)
    expect(readFileSync(join(remote, 'new.txt'), 'utf8')).toBe('remote edited')
    await expect(dispatchWorkspaceTool(context, workspaces, execution('pwsh', { command: 'pwd' }), local)).rejects.toThrow('not run locally')
    expect(local).not.toHaveBeenCalled()
    await dispatchWorkspaceTool(context, workspaces, execution('bash', { command: 'pwd' }, dir), local)
    expect(local).toHaveBeenCalledTimes(1)
  })

  it('passive status never reconnects and a rejected host cannot fall back locally', async () => {
    engine.dropAlias('fixture')
    await vi.waitFor(() => expect(engine.connectionStatus()[0].state).toBe('disconnected'))
    const badEngine = new SshEngine(engine.store, { knownHostsPaths: [] })
    const badWorkspaces = new SshWorkspaces(badEngine, workspaces.root)
    try {
      await expect(badWorkspaces.create('fixture', remote)).rejects.toThrow()
      expect(badEngine.connectionStatus()[0].state).toBe('failed')
      expect(badEngine.pool.size).toBe(0)
    } finally { badEngine.dispose() }
  })

  it.each([false, true])('uses the real tool registry and fences retained history (historyOnly=%s)', async historyOnly => {
    const binding = await workspaces.create('fixture', remote)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const local = vi.fn(() => { throw new Error('local execution must never happen') })
    ctx.provide('fs', { sandboxMode: undefined, resolve: local })
    ctx.provide('shell', { sandboxMode: undefined, execute: local })
    ctx.provide('shellEnv', { collect: () => ({}) })
    await ctx.plugin(FsTools)
    await ctx.plugin(BashTool)
    installWorkspaceTools(ctx, workspaces, () => true, historyOnly)
    const agent = { session: { header: { cwd: binding.localPath } } } as NonNullable<ToolDispatchExecution['agent']>
    const call = (name: string, args: object) => ctx.tools.execute({ callId: ToolCallId('fixture-' + name), name, arguments: args, agent, signal: new AbortController().signal })
    try {
      if (historyOnly) {
        const write = await call('write', { file_path: 'history-forbidden.txt', content: 'must not be written' })
        expect(write.isError).toBe(true)
        expect(JSON.stringify(write)).toContain('retained local SSH workspace history')
        expect(existsSync(join(remote, 'history-forbidden.txt'))).toBe(false)
        expect(existsSync(join(binding.localPath, 'history-forbidden.txt'))).toBe(false)
        expect(local).not.toHaveBeenCalled()
        return
      }
      const write = await call('write', { file_path: 'official.txt', content: 'hello\n' })
      expect(write.isError, JSON.stringify(write)).toBe(false)
      const read = await call('read', { file_path: 'official.txt' })
      expect(read.isError, JSON.stringify(read)).toBe(false)
      expect(read.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('hello') })
      const edit = await call('edit', { file_path: 'official.txt', old_string: 'hello', new_string: 'world' })
      expect(edit.isError, JSON.stringify(edit)).toBe(false)
      const bash = await call('bash', { command: 'cat official.txt', description: 'Read remote fixture content' })
      expect(bash.isError, JSON.stringify(bash)).toBe(false)
      expect(bash.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('world') })
      const deny = ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'fixture denied' }))
      const rejected = await call('bash', { command: 'touch forbidden.txt', description: 'Test a denied remote command' })
      deny()
      expect(rejected.isError).toBe(true)
      expect(existsSync(join(remote, 'forbidden.txt'))).toBe(false)
      expect(local).not.toHaveBeenCalled()
      const prompt = await ctx.systemPrompt.assemble({ scope: agent })
      expect(prompt.sections.find(section => section.name === 'plugin:ssh-workspace')?.text).toContain(remote)
    } finally { await ctx.fiber.dispose() }
  })

  it('registers only verified SSH directories through the authenticated workspace HTTP route', async () => {
    const registered: Array<{ path: string; title: string; id: string }> = []
    const registry = { list: () => registered, create: vi.fn(async (path: string, title = '') => { registered.push({ path, title, id: 'fixture' }) }) }
    const { routes } = makeRoutes({ store: engine.store, engine, workspaces, workspaceRegistry: () => registry,
      requestRejection: req => req.headers.authorization === 'fixture' ? undefined : 401, stagingDir: join(dir, 'staging') })
    const server = createServer((req, res) => {
      const route = routes.find(route => route.path === req.url)
      if (route) void route.handler(req, res)
      else { res.writeHead(404); res.end() }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dsh-ssh/workspaces`
    const headers = { Authorization: 'fixture', 'Content-Type': 'application/json' }
    try {
      expect((await fetch(url)).status).toBe(401)
      const bad = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ alias: 'fixture', remotePath: join(remote, 'missing') }) })
      expect(bad.status).toBe(400)
      expect(registry.create).not.toHaveBeenCalled()
      const good = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ alias: 'fixture', remotePath: remote }) })
      expect(good.status).toBe(201)
      const binding = (await good.json()).workspace
      expect(registry.create).toHaveBeenCalledExactlyOnceWith(binding.localPath, binding.title)
      registered[0].title = 'Renamed workspace'
      expect((await (await fetch(url, { headers })).json()).workspaces[0].title).toBe('Renamed workspace')
      registered.length = 0
      expect((await (await fetch(url, { headers })).json()).workspaces).toEqual([])
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
})
