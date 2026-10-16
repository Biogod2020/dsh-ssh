import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type { FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { validateJsonSchemaValue, type ToolDispatchExecution, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { SshEngine } from './engine.ts'
import { dshHome } from './dsh-home.ts'
import { runWorkspaceOperation, WorkspaceOperationError } from './workspace-transport.ts'

export interface SshWorkspace {
  alias: string
  remotePath: string
  localPath: string
  title: string
}

/** Local identity only. No remote user files or model credentials are copied here. */
export class SshWorkspaces {
  readonly root: string
  constructor(readonly engine: SshEngine, root = join(dshHome(), 'ssh-workspaces')) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    this.root = realpathSync(root)
  }

  list(): SshWorkspace[] {
    return readdirSync(this.root).flatMap(id => {
      const path = join(this.root, id, 'workspace.json')
      if (!existsSync(path)) return []
      return [this.read(path)]
    })
  }

  private read(path: string): SshWorkspace {
    const item = JSON.parse(readFileSync(path, 'utf8')) as SshWorkspace
    if (typeof item.alias !== 'string' || typeof item.remotePath !== 'string' || typeof item.localPath !== 'string'
      || typeof item.title !== 'string' || !item.remotePath.startsWith('/') || !this.owns(item.localPath)) {
      throw new Error('Invalid SSH workspace binding; refusing local execution')
    }
    return item
  }

  owns(cwd: string): boolean {
    const rel = relative(this.root, resolve(cwd))
    return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !rel.startsWith(sep))
  }

  forCwd(cwd?: string): SshWorkspace | undefined {
    if (cwd === undefined || !this.owns(cwd)) return undefined
    const binding = this.list().find(item => item.localPath === resolve(cwd))
    if (!binding) throw new Error('SSH workspace binding is missing. Refusing to run on this computer.')
    return binding
  }

  async create(alias: string, remotePath: string): Promise<SshWorkspace> {
    if (!this.engine.find(alias)) throw new Error('Choose a configured SSH host first')
    const result = await runWorkspaceOperation(this.engine, alias, { op: 'probe', cwd: remotePath })
    if (!result.path?.startsWith('/')) throw new Error('Remote host did not return an absolute directory')
    const id = createHash('sha256').update(JSON.stringify([alias, result.path])).digest('hex').slice(0, 20)
    const dir = join(this.root, id)
    const file = join(dir, 'workspace.json')
    if (existsSync(file)) return this.read(file)
    const title = `${basename(result.path) || 'root'} [SSH:${alias}]`
    const localPath = join(dir, title)
    mkdirSync(localPath, { recursive: true, mode: 0o700 })
    const item: SshWorkspace = { alias, remotePath: result.path, localPath, title }
    // This instruction also survives a missing plugin: the anchor contains no user files.
    writeFileSync(join(localPath, 'AGENTS.md'), `This is an SSH workspace identity, not a local source directory.\nRemote host: ${alias}\nRemote directory: ${result.path}\nOrdinary read/write/edit/bash tools must be routed by SSH Ops. If that adapter is unavailable, STOP; never operate on the local identity directory.\n`, { mode: 0o600 })
    const temp = file + '.' + randomUUID() + '.tmp'
    writeFileSync(temp, JSON.stringify(item), { mode: 0o600 })
    renameSync(temp, file)
    return item
  }
}

const REMOTE_TOOLS = new Set(['read', 'write', 'edit', 'bash'])
// Transport and interaction tools may run locally; their nested file/command calls still route here.
const LOCAL_SAFE_TOOLS = new Set(['run_code', 'update_plan', 'ask_user', 'ask_user_question', 'request_user_input', 'web_search', 'web_fetch'])

/** Around-dispatch adapter preserves the official schemas, renderers and pre-execute approval pipeline. */
export async function dispatchWorkspaceTool(ctx: Context, workspaces: SshWorkspaces, exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
  const binding = workspaces.forCwd(exec.agent?.session.header.cwd)
  if (!binding) return next()
  if (!REMOTE_TOOLS.has(exec.name)) {
    if (LOCAL_SAFE_TOOLS.has(exec.name)) return next()
    throw new Error(`Tool ${exec.name} is not available in an SSH workspace; use read, write, edit or bash. It was not run locally.`)
  }
  const definition = ctx.tools.get(exec.name, exec.agent)
  if (!definition) throw new Error('Tool is unavailable: ' + exec.name)
  const invalid = validateJsonSchemaValue(definition.parameters, exec.arguments, 'arguments')
  if (invalid.length) throw new Error(invalid.join('; '))
  const args = exec.arguments as Record<string, unknown>
  if (args.sandbox_permissions !== undefined) throw new Error('Local sandbox escalation cannot be applied to an SSH host')
  exec.signal.throwIfAborted()
  const call = (op: string, extra: Record<string, unknown> = {}) => runWorkspaceOperation(workspaces.engine, binding.alias,
    { op, cwd: binding.remotePath, args, ...extra }, exec.signal)
  let target: FsTarget | undefined
  let intent: FsWriteIntent | { version: FsVersion } | undefined
  if (exec.name !== 'bash') {
    const resolved = await call('resolve')
    target = { targetKey: `ssh://${binding.alias}${resolved.path}` as FsTarget['targetKey'], displayPath: resolved.path! }
    if (exec.name === 'write') intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
    if (exec.name === 'edit') intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
  }
  let result
  try {
    result = await call(exec.name, { ...(intent ? { intent } : {}), ...(target ? { expectedPath: target.displayPath } : {}) })
  } catch (error) {
    if (target && exec.name === 'read' && error instanceof WorkspaceOperationError && error.code === 'FS_NOT_FOUND') {
      ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
    }
    throw error
  }
  if (target && result.version) ctx.emit('fs/observed', target, { kind: 'present', version: result.version as FsVersion }, exec)
  // The registry validates this value and applies the original tool's render/meta functions.
  return { isError: false, value: result.value as Extract<ToolExecutionResult, { isError: false }>['value'], content: [] }
}

export function installWorkspaceTools(ctx: Context, workspaces: SshWorkspaces, enabled: () => boolean = () => true, historyOnly = false): void {
  ctx.on('tools/execute', (exec, next) => {
    if (historyOnly && workspaces.forCwd(exec.agent?.session.header.cwd)) throw new Error('This is retained local SSH workspace history. Open the workspace from the SSH workspaces list to continue in remote DSH; no tool was run locally.')
    if (!enabled() && workspaces.forCwd(exec.agent?.session.header.cwd)) throw new Error('SSH Ops is disabled; remote workspace operations cannot run locally')
    return dispatchWorkspaceTool(ctx, workspaces, exec, next)
  })
  ctx.systemPrompt.section({
    name: 'plugin:ssh-workspace', order: 151,
    text: context => {
      const agent = context.scope as { session?: { header: { cwd?: string } } } | undefined
      const binding = workspaces.forCwd(agent?.session?.header.cwd)
      if (binding && historyOnly) return `This local conversation is retained SSH workspace history for ${binding.alias}:${binding.remotePath}. Execution has migrated to a remote DSH service. Ask the user to open this workspace from the SSH workspaces list. Do not execute tools or treat the local identity directory as project files.`
      return binding ? `SSH workspace: ${binding.alias}:${binding.remotePath}. Use read/write/edit/bash normally; these execute on this remote host. The session's local cwd is an identity only, never use it as a remote file path. Use remote absolute paths or paths relative to ${binding.remotePath}. Before modifying remote files, read and follow the remote AGENTS.md files in this directory and its parents. No local fallback or automatic replay occurs. Other host-dependent tools and background jobs are unavailable; use foreground bash. A disconnected or interrupted write may have happened remotely: inspect before retrying. Remote host requires Python 3 and bash.` : ''
    },
  })
}
