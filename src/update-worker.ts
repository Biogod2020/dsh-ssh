/** Standalone updater. This bundle has no DSH runtime imports. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, rm, readdir, lstat, symlink, realpath } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { valid, gt, satisfies } from 'semver'
import type { UpdateConfig, PluginUpdateView } from './update-types.ts'
import { configureUpdateService } from './update-service.ts'

export const UPDATE_PACKAGE = '@biogod/dsh-ssh'
const registry = 'https://registry.npmjs.org'
const metadataFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
interface Manifest { name?: string; version?: string; engines?: { dsh?: string; node?: string }; dependencies?: Record<string, string>; [key: string]: unknown }
interface RegistryVersion extends Manifest { dist?: { tarball?: string; integrity?: string } }
interface Journal { backup: string; target: string; moved: boolean; linked: boolean; files: Record<string, string | null> }
export interface WorkerOptions {
  /** Loopback registry is injected by integration tests, never read from persisted user configuration. */
  registry?: string
  afterStep?: (step: string) => Promise<void>
  onError?: (error: unknown) => void
}

export async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')) as T }
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = path + '.' + randomUUID()
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  await rename(temp, path)
}
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return true
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

/** Match DSH's package writer lock, so its CLI and this helper cannot write together. */
async function lock(path: string): Promise<(() => Promise<void>) | undefined> {
  try { await writeFile(path, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const record = await readFile(path, 'utf8')
    if (processAlive(Number(record.trim()))) return undefined
    const claim = path + '.recover'
    try { await writeFile(claim, '', { flag: 'wx', mode: 0o600 }) } catch { return undefined }
    try {
      if (await readFile(path, 'utf8') !== record) return undefined
      await rm(path)
    } finally { await rm(claim, { force: true }) }
    return lock(path)
  }
  return async () => { if ((await readFile(path, 'utf8')).trim() === String(process.pid)) await rm(path) }
}

async function hostsActive(root: string): Promise<boolean> {
  const leases = join(root, 'hosts')
  for (const file of await readdir(leases)) {
    if (!/^\d+\.json$/.test(file)) continue
    const pid = Number(file.slice(0, -5))
    if (processAlive(pid)) return true
    await rm(join(leases, file), { force: true })
  }
  return false
}
async function enabled(configFile: string): Promise<boolean> {
  try { return (await readJson<UpdateConfig>(configFile)).enabled === true } catch { return false }
}
async function execute(config: UpdateConfig, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(config.packageManager.command, [...config.packageManager.args, ...args], {
      cwd, env: { ...process.env, ...config.packageManager.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32',
    })
    const timer = setTimeout(() => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM') } catch {}
      reject(new Error('Package operation exceeded its deadline'))
    }, 180000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolveRun() : reject(new Error('Package operation failed')) })
  })
}
async function limitedFetch(url: string, maxBytes: number, json = false): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error', headers: json ? { Accept: 'application/json', 'Cache-Control': 'no-cache' } : {} })
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > maxBytes) throw new Error('Update download refused')
  const chunks: Buffer[] = []; let bytes = 0
  const reader = response.body!.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.length
      if (bytes > maxBytes) throw new Error('Update download exceeded its limit')
      chunks.push(Buffer.from(value))
    }
  } finally { await reader.cancel() }
  return Buffer.concat(chunks)
}
function compatible(manifest: RegistryVersion, runtime: string): boolean {
  return manifest.name === UPDATE_PACKAGE && !!valid(manifest.version) && typeof manifest.engines?.dsh === 'string'
    && satisfies(runtime, manifest.engines.dsh, { includePrerelease: true })
    && (!manifest.engines.node || satisfies(process.versions.node, manifest.engines.node))
}
async function textOrNull(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
async function restore(root: string, journal: Journal): Promise<void> {
  if (resolve(journal.target) !== join(dirname(root), 'node_modules', '@biogod', 'dsh-ssh')
    || dirname(journal.backup) !== root || !/^previous-[a-f0-9-]+$/.test(journal.backup.slice(root.length + 1))
    || metadataFiles.some(name => !(name in journal.files))
    || Object.entries(journal.files).some(([name, content]) => !metadataFiles.includes(name) || (content !== null && typeof content !== 'string'))) throw new Error('Invalid update recovery record')
  // Inspect filesystem facts too: a crash can occur between rename and journal write.
  let backupExists = false
  try { await lstat(journal.backup); backupExists = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (backupExists) {
    await rm(journal.target, { recursive: true, force: true })
    await rename(journal.backup, journal.target)
  }
  for (const [name, content] of Object.entries(journal.files)) {
    const path = join(dirname(root), name)
    if (content === null) await rm(path, { force: true })
    else { const temp = path + '.' + randomUUID(); await writeFile(temp, content, { mode: 0o600 }); await rename(temp, path) }
  }
  await rm(join(root, 'transaction.json'), { force: true })
}

/** One check prepares immutable files, waits for every registered Host, then commits. */
export async function runUpdate(configFile: string, options: WorkerOptions = {}): Promise<void> {
  const root = dirname(configFile)
  const releaseWorker = await lock(join(root, 'worker.lock'))
  if (!releaseWorker) return
  let unlockProfile: (() => Promise<void>) | undefined
  let stagedRelease: string | undefined, committed = false
  const status = (phase: PluginUpdateView['phase'], extra = {}) => atomicJson(join(root, 'status.json'), { phase, checkedAt: Date.now(), ...extra })
  try {
    const config = await readJson<UpdateConfig>(configFile)
    if (resolve(config.profile, '.dsh-ssh-updates') !== resolve(root)) throw new Error('Invalid update profile')
    const interrupted = await textOrNull(join(root, 'transaction.json'))
    if (interrupted !== null) {
      await status('failed')
      while (await hostsActive(root)) await delay(1000)
      const release = await lock(join(config.profile, 'package.json.lock'))
      if (!release) return
      try { await restore(root, JSON.parse(interrupted)); await status('failed') } finally { await release() }
      return // Recovery never retries the interrupted write in the same invocation.
    }
    if (!config.enabled) return
    const target = join(config.profile, 'node_modules', '@biogod', 'dsh-ssh')
    const profile = await readJson<Manifest>(join(config.profile, 'package.json'))
    const spec = profile.dependencies?.[UPDATE_PACKAGE]
    if (!spec) {
      await atomicJson(configFile, { ...config, enabled: false })
      await configureUpdateService(configFile, process.argv[1]!, config, false)
      return
    }
    if (/^(?:file:|link:|workspace:|git|https?:)/.test(spec)) throw new Error('Automatic updates require an npm-installed plugin')
    const current = await readJson<Manifest>(join(target, 'package.json'))
    const runtime = (await readJson<Manifest>(config.runtimeManifest)).version
    if (!runtime || !valid(runtime) || current.name !== UPDATE_PACKAGE || !valid(current.version)) throw new Error('Cannot determine installed versions')
    await status('checking')
    const source = options.registry ?? registry
    const document = JSON.parse((await limitedFetch(source + '/@biogod%2fdsh-ssh', 8 * 1024 * 1024, true)).toString()) as { 'dist-tags': { latest: string }; versions: Record<string, RegistryVersion> }
    const candidate = document.versions[document['dist-tags'].latest]
    if (!candidate || !compatible(candidate, runtime) || !gt(candidate.version!, current.version!)) { await status('ready'); return }
    const version = candidate.version!
    const tarball = new URL(candidate.dist?.tarball ?? '')
    const allowed = new URL(source)
    if (tarball.origin !== allowed.origin || tarball.pathname !== `/@biogod/dsh-ssh/-/dsh-ssh-${version}.tgz`
      || !/^sha512-[A-Za-z0-9+/]+=*$/.test(candidate.dist?.integrity ?? '')) throw new Error('Invalid update artifact')
    const bytes = await limitedFetch(tarball.href, 16 * 1024 * 1024)
    if ('sha512-' + createHash('sha512').update(bytes).digest('base64') !== candidate.dist!.integrity) throw new Error('Update checksum mismatch')
    const stage = join(root, 'releases', version + '-' + randomUUID())
    stagedRelease = stage
    await mkdir(stage, { recursive: true, mode: 0o700 })
    const archive = join(stage, 'package.tgz')
    await writeFile(archive, bytes, { mode: 0o600 })
    await atomicJson(join(stage, 'package.json'), { private: true })
    const installArgs = ['add', archive, '--ignore-scripts', '--ignore-pnpmfile', '--ignore-workspace', '--save-exact', '--registry=' + source]
    await execute(config, installArgs, stage)
    const prepared = join(stage, 'node_modules', '@biogod', 'dsh-ssh')
    const installed = await readJson<RegistryVersion>(join(prepared, 'package.json'))
    if (installed.version !== version || !compatible(installed, runtime)) throw new Error('Prepared package is incompatible')
    for (const file of ['lib/index.js', 'lib/client.js', 'lib/update-worker.js', 'cordis.patch.yml']) {
      const info = await lstat(join(prepared, file)); if (!info.isFile()) throw new Error('Prepared package is incomplete')
    }
    await status('waiting', { availableVersion: version })
    while (await hostsActive(root)) { if (!await enabled(configFile)) return; await delay(1000) }
    // A short quiet period lets replacement Hosts register before installation.
    await delay(1500)
    if (!await enabled(configFile) || await hostsActive(root)) return
    while (!(unlockProfile = await lock(join(config.profile, 'package.json.lock')))) {
      if (!await enabled(configFile) || await hostsActive(root)) return
      await delay(1000)
    }
    if (await hostsActive(root) || !await enabled(configFile)) return
    const before = await readJson<Manifest>(join(config.profile, 'package.json'))
    if (before.dependencies?.[UPDATE_PACKAGE] !== spec
      || (await readJson<Manifest>(join(target, 'package.json'))).version !== current.version) throw new Error('Plugin changed while preparing the update')
    const files: Record<string, string | null> = {}
    for (const file of metadataFiles) files[file] = await textOrNull(join(config.profile, file))
    const nextRuntime = (await readJson<Manifest>(config.runtimeManifest)).version
    if (!nextRuntime || !compatible(installed, nextRuntime)) throw new Error('DSH changed while preparing the update')
    if (!await enabled(configFile) || await hostsActive(root)) return
    const journal: Journal = { target, backup: join(root, 'previous-' + randomUUID()), moved: false, linked: false, files }
    await atomicJson(join(root, 'transaction.json'), journal)
    try {
      // Keep normal pnpm metadata and relative local dependencies in their original
      // profile context. This command changes no installed package files.
      await execute(config, ['add', UPDATE_PACKAGE + '@' + version, '--lockfile-only', '--ignore-scripts', '--ignore-pnpmfile', '--save-exact', '--registry=' + source], config.profile)
      if (await textOrNull(join(config.profile, 'pnpm-workspace.yaml')) !== files['pnpm-workspace.yaml']) throw new Error('Package policy changed during the update')
      const after = await readJson<Manifest>(join(config.profile, 'package.json'))
      if (after.dependencies?.[UPDATE_PACKAGE] !== version || !(await readFile(join(config.profile, 'pnpm-lock.yaml'), 'utf8')).includes(candidate.dist!.integrity!)) throw new Error('Prepared lockfile does not match the verified package')
      await atomicJson(join(config.profile, 'package.json'), { ...before, dependencies: { ...before.dependencies, [UPDATE_PACKAGE]: version } })
      await options.afterStep?.('package.json')
      if (await hostsActive(root) || !await enabled(configFile)) throw new Error('A Host started during installation')
      await rename(target, journal.backup); journal.moved = true
      await atomicJson(join(root, 'transaction.json'), journal)
      await options.afterStep?.('moved')
      await symlink(await realpath(prepared), target, process.platform === 'win32' ? 'junction' : 'dir'); journal.linked = true
      await atomicJson(join(root, 'transaction.json'), journal)
      if (await hostsActive(root) || !await enabled(configFile)) throw new Error('A Host started during installation')
      await rm(join(root, 'transaction.json'))
      committed = true
      await status('installed', { installedVersion: version })
    } catch (error) { await restore(root, journal); throw error }
  } catch (error) {
    options.onError?.(error)
    // Paths, environment, credentials and package-manager diagnostics stay out of status and host logs.
    await status('failed')
  } finally {
    if (stagedRelease && !committed && await textOrNull(join(root, 'transaction.json')) === null) {
      await rm(stagedRelease, { recursive: true, force: true })
    }
    await unlockProfile?.(); await releaseWorker()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--config') {
  void runUpdate(process.argv[3]!).catch(() => { process.exitCode = 1 })
}
