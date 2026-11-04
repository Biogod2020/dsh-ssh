import type { IncomingMessage } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { mkdir, readFile, writeFile, lstat, chmod, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, isAbsolute, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { isLoopbackRequest } from './loopback.ts'
import { readJsonBody, writeJson } from './http.ts'
import { atomicJson, readJson, UPDATE_PACKAGE } from './update-worker.ts'
import { configureUpdateService } from './update-service.ts'
import type { PluginUpdateView, UpdateConfig, UpdateProfile } from './update-types.ts'

interface Options {
  packageRoot?: string
  configureService?: typeof configureUpdateService
  launch?: (configFile: string, worker: string, config: UpdateConfig) => void
}

export class SelfUpdate {
  private configFile?: string
  private worker?: string
  private config?: UpdateConfig
  private supported = false
  private initialized: Promise<void>
  private operation: Promise<void> = Promise.resolve()
  private readonly packageRoot: string
  private runningVersion = ''
  constructor(private profile: UpdateProfile | undefined, private options: Options = {}) {
    this.packageRoot = options.packageRoot ?? fileURLToPath(new URL('..', import.meta.url))
    this.initialized = this.initialize().catch(async () => {
      if (this.configFile && this.config?.enabled) {
        await atomicJson(join(dirname(this.configFile), 'status.json'), { phase: 'failed', checkedAt: Date.now() }).catch(() => {})
      }
    })
  }
  private async initialize(): Promise<void> {
    this.runningVersion = (await readJson<{ version: string }>(join(this.packageRoot, 'package.json'))).version
    if (!this.profile || !isAbsolute(this.profile.dir) || !isAbsolute(this.profile.installAnchor)
      || !['darwin', 'linux', 'win32'].includes(process.platform)) return
    const installed = await readJson<{ dependencies?: Record<string, string> }>(join(this.profile.dir, 'package.json'))
    const spec = installed.dependencies?.[UPDATE_PACKAGE]
    if (!spec || /^(?:file:|link:|workspace:|git|https?:)/.test(spec)) return
    const root = join(this.profile.dir, '.dsh-ssh-updates')
    await mkdir(join(root, 'hosts'), { recursive: true, mode: 0o700 })
    if ((await lstat(root)).isSymbolicLink() || (await lstat(join(root, 'hosts'))).isSymbolicLink()) return
    await chmod(root, 0o700); await chmod(join(root, 'hosts'), 0o700)
    // Leases last until the process exits, even if its plugin is disabled or reloaded.
    await atomicJson(join(root, 'hosts', process.pid + '.json'), { pid: process.pid })
    this.configFile = join(root, 'config.json')
    let previous: UpdateConfig | undefined
    try { previous = await readJson<UpdateConfig>(this.configFile) } catch {}
    const packageManager = { ...(this.profile.packageManager ?? { command: 'pnpm', args: [], env: {} }) }
    if (!isAbsolute(packageManager.command)) {
      // Resolve PATH once, so the independent scheduler does not depend on an interactive shell.
      const candidates = (process.env.PATH ?? '').split(delimiter).flatMap(dir => (process.platform === 'win32' ? ['', '.exe', '.cmd'] : ['']).map(ext => join(dir, packageManager.command + ext)))
      const found = await Promise.all(candidates.map(async path => { try { await access(path); return path } catch { return undefined } }))
      const command = found.find(Boolean)
      if (!command) return
      packageManager.command = command
    }
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(packageManager.command)) {
      // Invoke the package manager's JS entry directly; never pass package arguments through cmd.exe.
      const require = createRequire(join(dirname(packageManager.command), 'updater.cjs'))
      let entry: string | undefined
      for (const name of ['pnpm', 'corepack']) {
        try {
          const manifest = require.resolve(name + '/package.json')
          const candidate = join(dirname(manifest), name === 'pnpm' ? 'bin/pnpm.cjs' : 'dist/pnpm.js')
          await access(candidate); entry = candidate; break
        } catch {}
      }
      if (!entry) return
      packageManager.command = process.execPath
      packageManager.args = [...(process.versions.electron ? ['--expose-internals'] : []), entry, ...packageManager.args]
    }
    this.config = { enabled: previous?.enabled === true, profile: this.profile.dir, runtimeManifest: this.profile.installAnchor,
      executable: process.execPath, executableArgs: process.versions.electron ? ['--expose-internals'] : [],
      packageManager: { command: packageManager.command, args: [...packageManager.args], env: { PATH: process.env.PATH ?? '', ...packageManager.env } } }
    const bytes = await readFile(join(this.packageRoot, 'lib/update-worker.js'))
    this.worker = join(root, 'worker-' + createHash('sha256').update(bytes).digest('hex').slice(0, 16) + '.mjs')
    await writeFile(this.worker, bytes, { mode: 0o600 })
    await atomicJson(this.configFile, this.config)
    this.supported = true
    if (this.config.enabled) {
      // Refresh the independent helper too when a newer plugin starts.
      await (this.options.configureService ?? configureUpdateService)(this.configFile, this.worker, this.config, true)
      this.launch()
    } else {
      try { await access(join(root, 'transaction.json')); this.launch() } catch {}
    }
  }
  private launch(): void {
    if (!this.configFile || !this.worker || !this.config) return
    if (this.options.launch) { this.options.launch(this.configFile, this.worker, this.config); return }
    const child = spawn(this.config.executable, [...this.config.executableArgs, this.worker, '--config', this.configFile], {
      detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    child.on('error', () => { void atomicJson(join(dirname(this.configFile!), 'status.json'), { phase: 'failed', checkedAt: Date.now() }).catch(() => {}) })
    child.unref()
  }
  async view(): Promise<PluginUpdateView> {
    await this.initialized
    if (this.config && this.configFile) {
      try { this.config.enabled = (await readJson<UpdateConfig>(this.configFile)).enabled === true } catch { this.config.enabled = false }
    }
    const view: PluginUpdateView = { enabled: this.config?.enabled === true, supported: this.supported,
      runningVersion: this.runningVersion, phase: this.supported ? this.config?.enabled ? 'ready' : 'disabled' : 'unsupported' }
    if (this.configFile && view.enabled) {
      try {
        const status = await readJson<Partial<PluginUpdateView>>(join(dirname(this.configFile), 'status.json'))
        if (['ready', 'checking', 'waiting', 'installed', 'failed'].includes(status.phase ?? '')) view.phase = status.phase!
        if (typeof status.availableVersion === 'string') view.availableVersion = status.availableVersion
        if (typeof status.installedVersion === 'string') view.installedVersion = status.installedVersion
        if (typeof status.checkedAt === 'number') view.checkedAt = status.checkedAt
      } catch {}
    }
    return view
  }
  async setEnabled(value: boolean): Promise<PluginUpdateView> {
    await this.initialized
    const change = this.operation.then(async () => {
      if (!this.supported || !this.configFile || !this.worker || !this.config) throw new Error('Automatic updates are unavailable in this installation')
      this.config.enabled = value
      await atomicJson(this.configFile, this.config)
      try { await (this.options.configureService ?? configureUpdateService)(this.configFile, this.worker, this.config, value) }
      catch {
        this.config.enabled = false; await atomicJson(this.configFile, this.config)
        throw new Error('Could not configure the user update service. Keep DSH running under your desktop account and try again.')
      }
      if (value) this.launch()
      else {
        try { await access(join(dirname(this.configFile), 'transaction.json')); this.launch() } catch {}
      }
    })
    this.operation = change.catch(() => {})
    await change
    return this.view()
  }
  route(rejection: (request: IncomingMessage) => 401 | 403 | undefined): WebRoute {
    return { kind: 'exact', path: '/api/dsh-ssh/update', handler: async (req, res) => {
      const denied = rejection(req)
      if (denied || !isLoopbackRequest(req)) { writeJson(res, denied ?? 403, { error: 'Update access denied' }); return }
      res.setHeader('Cache-Control', 'no-store')
      try {
        if (req.method === 'GET') { writeJson(res, 200, await this.view()); return }
        if (req.method === 'POST') {
          const body = await readJsonBody(req, { maxBytes: 128 }) as { enabled?: unknown }
          if (typeof body?.enabled !== 'boolean') { writeJson(res, 400, { error: 'Choose whether to enable automatic updates' }); return }
          writeJson(res, 200, await this.setEnabled(body.enabled)); return
        }
        writeJson(res, 405, { error: 'Method not allowed' })
      } catch (error) { writeJson(res, 400, { error: error instanceof Error ? error.message : 'Update settings failed' }) }
    } }
  }
}
