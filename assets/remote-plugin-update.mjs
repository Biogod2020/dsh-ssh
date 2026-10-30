/** Stage an exact package through the official CLI. Never stop a live daemon. */
import { mkdir, readFile, writeFile, copyFile, open, lstat, mkdtemp, rename, realpath, unlink, rmdir } from 'node:fs/promises'
import { join, isAbsolute, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'

/** Prepare the bundled model helper with the same private package manager as
 * server-plugin updates. Native enablement remains a separate Host operation. */
export async function stageModelBridge({ root, node, dsh, hash, timeoutMs = 540000 }) {
  if (![root, node, dsh].every(isAbsolute) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid model helper preparation')
  const name = `@jay-local/dsh-ssh-model-bridge-${hash.slice(0, 16)}`, version = `0.0.0-${hash.slice(0, 16)}`
  const bundle = join(root, 'model-bridge', 'bundles-v2', hash), spec = `link:${bundle}`
  const source = await readFile(join(bundle, 'index.mjs'))
  const manifest = JSON.parse(await readFile(join(bundle, 'package.json'), 'utf8'))
  if ((await lstat(bundle)).isSymbolicLink() || manifest.name !== name || manifest.version !== version
    || createHash('sha256').update(source).digest('hex') !== hash) throw new Error('Model helper source mismatch')
  const home = join(root, 'data'), profile = join(home, 'profiles', 'web')
  const directory = join(root, 'state', 'model-bridge-updates', 'v4', hash), resultPath = join(directory, 'result.json')
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 })
  const parent = await lstat(dirname(directory))
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)) throw new Error('Unsafe model helper receipt storage')
  try { await mkdir(directory, { mode: 0o700 }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new Error('Unsafe model helper receipt')
    try { return JSON.parse(await readFile(resultPath, 'utf8')) }
    catch { throw new Error('Model helper preparation outcome unconfirmed; not replayed') }
  }
  const lock = join(root, 'state', 'plugin-update.lock')
  let confirmed = false
  const finish = async result => { await writeFile(resultPath, JSON.stringify(result), { mode: 0o600, flag: 'wx' }); confirmed = true; return result }
  try { await mkdir(lock, { mode: 0o700 }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    return await finish({ application: 'failed', error: { code: 'update-active-or-interrupted' } })
  }
  await writeFile(join(lock, 'pid'), String(process.pid), { mode: 0o600, flag: 'wx' })
  try {
    const installed = async () => {
      try {
        const path = join(profile, 'node_modules', name)
        const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
        return pkg.name === name && pkg.version === version
          && createHash('sha256').update(await readFile(join(path, 'index.mjs'))).digest('hex') === hash
      } catch (error) { if (error.code === 'ENOENT') return false; throw error }
    }
    if (await installed()) return await finish({ application: 'staged', version, changed: false })
    for (const file of ['package.json', 'pnpm-lock.yaml']) {
      try { await copyFile(join(profile, file), join(directory, file), constants.COPYFILE_EXCL) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    const output = await open(join(directory, 'install.log'), 'wx', 0o600)
    let timer, code
    try {
      const pnpmBin = await ensurePackageManager(root, node, output.fd, timeoutMs)
      const child = await spawnProfileCli({ node, dsh, pnpmBin, home,
        args: ['plugin', '--profile', 'web', 'add', spec, ...await profileWorkspaceFlags(profile)] }, output.fd)
      code = await new Promise((resolve, reject) => {
        child.once('error', reject); child.once('exit', resolve)
        timer = setTimeout(() => { child.unref(); reject(new Error('Model helper preparation outcome unconfirmed; not replayed')) }, timeoutMs)
      })
    } finally { clearTimeout(timer); await output.close() }
    if (code !== 0) return await finish({ application: 'failed', error: { code: 'cli-update-failed' } })
    if (!await installed()) return await finish({ application: 'failed', error: { code: 'verification-failed' } })
    return await finish({ application: 'staged', version, changed: true })
  } finally {
    if (confirmed) { await unlink(join(lock, 'pid')); await rmdir(lock) }
  }
}

export async function stagePluginUpdate({ root, node, dsh, name, version, expectedVersion, expectedEnabled, requestId, timeoutMs = 540000 }) {
  if (![root, node, dsh].every(isAbsolute) || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)
    || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(version)
    || !/^[a-zA-Z0-9-]{16,100}$/.test(requestId)) throw new Error('Invalid reviewed plugin update')
  const home = join(root, 'data'), profile = join(home, 'profiles', 'web'), directory = join(root, 'state', 'plugin-updates', requestId)
  const resultPath = join(directory, 'result.json')
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 })
  const parent = await lstat(dirname(directory))
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)) throw new Error('Unsafe plugin update storage')
  try { await mkdir(directory, { mode: 0o700 }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (!(await lstat(directory)).isDirectory()) throw new Error('Unsafe plugin update receipt')
    // Only a completed receipt is reusable. An interrupted command is never rerun.
    try { return JSON.parse(await readFile(resultPath, 'utf8')) }
    catch { throw new Error('Previous plugin update has an unconfirmed outcome; not replayed') }
  }
  const updateLock = join(root, 'state', 'plugin-update.lock')
  let confirmed = false
  const finish = async result => { await writeFile(resultPath, JSON.stringify(result), { mode: 0o600, flag: 'wx' }); confirmed = true; return result }
  try { await mkdir(updateLock, { mode: 0o700 }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    return await finish({ application: 'failed', error: { code: 'update-active-or-interrupted' } })
  }
  await writeFile(join(updateLock, 'pid'), String(process.pid), { mode: 0o600, flag: 'wx' })
  try {
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  let installed
  try { installed = JSON.parse(await readFile(join(profile, 'node_modules', name, 'package.json'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const enabled = (manifest.dsh?.profile?.bundles ?? []).includes(name)
  if (expectedVersion ? installed?.name !== name || installed.version !== expectedVersion || enabled !== expectedEnabled
    : installed || enabled || Object.hasOwn(manifest.dependencies ?? {}, name))
    return await finish({ application: 'failed', error: { code: 'stale-approval' } })
  for (const file of ['package.json', 'pnpm-lock.yaml']) {
    try { await copyFile(join(profile, file), join(directory, file), constants.COPYFILE_EXCL) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const output = await open(join(directory, 'install.log'), 'wx', 0o600)
  let timer, code
  try {
    const pnpmBin = await ensurePackageManager(root, node, output.fd, timeoutMs)
    const child = await spawnProfileCli({ node, dsh, pnpmBin, home,
      args: ['plugin', '--profile', 'web', 'add', `${name}@${version}`, ...await profileWorkspaceFlags(profile), '--save-exact'] }, output.fd)
    const completion = new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', value => resolve(value))
      timer = setTimeout(() => {
        // Leave the package manager's own locking and rollback intact.
        child.unref(); reject(new Error('Plugin update outcome unconfirmed; not replayed'))
      }, timeoutMs)
    })
    if (child.pid) await writeFile(join(directory, 'pid'), String(child.pid), { mode: 0o600, flag: 'wx' })
    code = await completion
  } finally { clearTimeout(timer); await output.close() }
  if (code !== 0) return await finish({ application: 'failed', error: { code: 'cli-update-failed' } })
  const after = JSON.parse(await readFile(join(profile, 'node_modules', name, 'package.json'), 'utf8'))
  const selected = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')).dsh?.profile?.bundles ?? []
  if (after.name !== name || after.version !== version || selected.includes(name) !== expectedEnabled)
    return await finish({ application: 'failed', error: { code: 'verification-failed' } })
  return await finish({ application: 'restart-required', changed: true, version })
  } finally {
    // An uncertain detached command retains its lock across local restarts.
    if (confirmed) { await unlink(join(updateLock, 'pid')); await rmdir(updateLock) }
  }
}

/** npm DSH exposes its official CLI as runCli(). Bind its installation-owned
 * package manager explicitly so local command resolution cannot select another
 * pnpm. Desktop launchers retain their own installation-owned manager. */
async function spawnProfileCli({ node, dsh, pnpmBin, home, args }, output) {
  const entry = await realpath(dsh), env = { ...process.env, DSH_HOME: home, PATH: `${pnpmBin}:${dirname(node)}:${process.env.PATH ?? ''}` }
  let publicCli = false
  if (/\.[cm]?js$/.test(entry)) {
    const info = await lstat(entry)
    if (info.isFile() && info.size < 1024 * 1024) publicCli = /export\s*\{[^}]*\brunCli\b|export\s+(?:async\s+)?function\s+runCli\b/.test(await readFile(entry, 'utf8'))
  }
  if (!publicCli) {
    // Installation-owned launchers can select their own pnpm despite PATH.
    // Keep their official profile locking and run the pinned tool explicitly.
    const forwarded = [...args.slice(0, 3), 'exec', join(pnpmBin, 'pnpm'), ...args.slice(3)]
    return spawn(dsh, forwarded, { cwd: home, env, stdio: ['ignore', output, output], detached: true })
  }
  const invocation = `import {pathToFileURL} from 'node:url';const cli=await import(pathToFileURL(${JSON.stringify(entry)}).href);if(typeof cli.runCli!=='function')throw Error('Native CLI interface unavailable');process.argv=[process.execPath,${JSON.stringify(entry)},...${JSON.stringify(args)}];await cli.runCli({packageManager:{command:${JSON.stringify(join(pnpmBin, 'pnpm'))},env:{PATH:process.env.PATH}}});`
  return spawn(node, ['--input-type=module', '-e', invocation], { cwd: home, env, stdio: ['ignore', output, output], detached: true })
}

/** pnpm 11 can create this marker during the first add. The older DSH CLI
 * does not add -w on the next call. Scope the flag to this exact profile root. */
async function profileWorkspaceFlags(profile) {
  try {
    const info = await lstat(join(profile, 'pnpm-workspace.yaml'))
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe profile workspace marker')
    return ['--workspace-root']
  } catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

/** Fixed private package manager; npm verifies registry integrity in its lockfile.
 * No global installation, lifecycle scripts, shell edits or credential copying. */
async function ensurePackageManager(root, node, output, timeoutMs) {
  const tools = join(root, 'tools'), target = join(tools, 'pnpm-11.20.0')
  await mkdir(tools, { recursive: true, mode: 0o700 })
  const info = await lstat(tools)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Unsafe package manager directory')
  const valid = async () => {
    try {
      const pkg = JSON.parse(await readFile(join(target, 'node_modules/pnpm/package.json'), 'utf8'))
      return pkg.name === 'pnpm' && pkg.version === '11.20.0'
    } catch { return false }
  }
  if (await valid()) return join(target, 'node_modules/.bin')
  const stage = await mkdtemp(join(tools, 'pnpm-stage-'))
  await writeFile(join(stage, 'package.json'), '{"private":true}', { mode: 0o600, flag: 'wx' })
  const npm = await realpath(join(dirname(node), 'npm'))
  const child = spawn(node, [npm, 'install', '--prefix', stage, '--registry=https://registry.npmjs.org', '--ignore-scripts',
    '--no-audit', '--no-fund', '--save-exact', 'pnpm@11.20.0'], { cwd: stage,
    env: { ...process.env, PATH: `${dirname(node)}:${process.env.PATH ?? ''}` }, stdio: ['ignore', output, output], detached: true })
  let timer
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', resolve)
      timer = setTimeout(() => { child.unref(); reject(new Error('Private package manager setup outcome unconfirmed; not replayed')) }, timeoutMs)
    })
    if (code !== 0) throw new Error('Private package manager setup failed; inspect private install.log')
  } finally { clearTimeout(timer) }
  const pkg = JSON.parse(await readFile(join(stage, 'node_modules/pnpm/package.json'), 'utf8'))
  if (pkg.name !== 'pnpm' || pkg.version !== '11.20.0') throw new Error('Private package manager verification failed')
  await rename(stage, target)
  return join(target, 'node_modules/.bin')
}
