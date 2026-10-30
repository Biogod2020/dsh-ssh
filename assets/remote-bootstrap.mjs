/** A detached DSH process owns its files, plugins and sessions; SSH owns only transport. */
import { mkdir, open, readFile, rename, unlink, rmdir, realpath, stat, lstat } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

async function bootstrapLegacyRemote({ root, dsh, node, directory, version, supportedVersions, timeoutMs = 90000 }) {
  if (![root, dsh, node].every(isAbsolute)) throw new Error('Remote executable and install paths must be absolute')
  if (!Array.isArray(supportedVersions) || !supportedVersions.includes(version)) throw new Error('Unsupported remote DSH version')
  directory = directory === '~' ? homedir() : directory.startsWith('~/') ? join(homedir(), directory.slice(2)) : directory
  if (!isAbsolute(directory)) throw new Error('Choose an absolute remote directory or ~/path')
  directory = await realpath(directory)
  if (!(await stat(directory)).isDirectory()) throw new Error('Remote workspace is not a directory')
  const state = join(root, 'state'), home = join(root, 'data')
  await mkdir(state, { recursive: true, mode: 0o700 })
  await mkdir(home, { recursive: true, mode: 0o700 })
  for (const path of [state, home]) if ((await lstat(path)).isSymbolicLink()) throw new Error('Managed state must not be a symlink')
  const receiptPath = join(state, 'server.json'), lockPath = join(state, 'start.lock'), logPath = join(state, 'server.log')
  const alive = pid => {
    if (!Number.isSafeInteger(pid) || pid < 1) return false
    try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error }
  }
  const healthy = async receipt => {
    if (receipt?.protocol !== 1 || receipt.root !== root || !supportedVersions.includes(receipt.version) || !alive(receipt.pid)) return false
    try {
      const url = new URL(receipt.url)
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || Number(url.port) !== receipt.port || !url.searchParams.get('token')) return false
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2500) })
      await response.body?.cancel()
      return response.status === 303 && response.headers.has('set-cookie')
    } catch { return false }
  }
  const readReceipt = async () => {
    try { return JSON.parse(await readFile(receiptPath, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return undefined; throw new Error('Cannot read remote server receipt; inspect private state before retrying') }
  }
  const readLaunchUrl = async () => {
    const file = await open(logPath, 'r')
    try {
      const size = (await file.stat()).size, bytes = Buffer.alloc(Math.min(size, 128 * 1024))
      await file.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length))
      return [...bytes.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '').matchAll(/http:\/\/127\.0\.0\.1:\d+\/?\?token=[A-Za-z0-9_.~%-]+/g)].at(-1)?.[0]
    } finally { await file.close() }
  }
  const publish = async receipt => {
    const path = `${receiptPath}.${process.pid}.tmp`
    const file = await open(path, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(receipt)); await file.sync() } finally { await file.close() }
    await rename(path, receiptPath)
  }
  const previous = await readReceipt()
  if (await healthy(previous)) return { ...previous, directory, userHome: homedir() }
  // A lost bootstrap channel can leave a running daemon with only its PID published.
  // Reconcile its authenticated launch receipt instead of spawning another process.
  if (previous?.root === root && alive(previous.pid)) {
    const url = await readLaunchUrl()
    if (url) {
      const recovered = { ...previous, url, port: Number(new URL(url).port) }
      if (await healthy(recovered)) { await publish(recovered); return { ...recovered, directory, userHome: homedir() } }
    }
    throw new Error('Recorded remote DSH is alive but not ready; it has not been replaced')
  }
  try { await mkdir(lockPath, { mode: 0o700 }) } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Remote startup is active or interrupted; inspect state/start.lock before retrying')
    throw error
  }
  const owner = await open(join(lockPath, 'pid'), 'wx', 0o600)
  await owner.writeFile(String(process.pid)); await owner.close()
  const ignoreHangup = () => {}
  process.on('SIGHUP', ignoreHangup)
  try {
    const existing = await readReceipt()
    if (await healthy(existing)) return { ...existing, directory, userHome: homedir() }
    if (existing && alive(existing.pid)) throw new Error('Recorded remote DSH is alive but not ready; it has not been replaced')
    const oldLog = await lstat(logPath).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (oldLog?.isSymbolicLink()) throw new Error('Remote server log must not be a symlink')
    const log = await open(logPath, 'w', 0o600)
    let child
    try {
      child = spawn(dsh, ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
        // One daemon serves every workspace on this account. A repository's
        // .env must not decide how that shared process starts or reaches the
        // network. Workspace ownership is established by workspace/create.
        cwd: home, env: { ...process.env, PATH: `${node.slice(0, node.lastIndexOf('/'))}:${join(root, 'tools/pnpm-11.20.0/node_modules/.bin')}:${process.env.PATH ?? ''}`, DSH_HOME: home },
        detached: true, stdio: ['ignore', log.fd, log.fd],
      })
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    } finally { await log.close() }
    child.unref()
    // Publish the PID before waiting. Losing SSH must never trigger another spawn on reconnect.
    const receipt = { protocol: 1, pid: child.pid, port: 0, url: '', root, directory, userHome: homedir(), version }
    await publish(receipt)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const url = await readLaunchUrl()
      if (url) {
        const ready = { ...receipt, url, port: Number(new URL(url).port) }
        if (await healthy(ready)) { await publish(ready); return ready }
      }
      if (!alive(child.pid)) throw new Error('Remote DSH exited during startup; inspect the private state/server.log')
      await delay(200)
    }
    throw new Error('Remote DSH did not become ready; process receipt retained, no restart or replay performed')
  } finally {
    process.off('SIGHUP', ignoreHangup)
    await unlink(join(lockPath, 'pid')); await rmdir(lockPath)
  }
}

/** New default: terminal and SSH select one account home and service. Explicit
 * test/isolated roots keep their own home and never rewrite the user's entry. */
export async function bootstrapRemote(input) {
  if (!input.account) return bootstrapLegacyRemote(input)
  const { root, node, dsh, version, supportedVersions, account } = input
  if (![root, node, dsh].every(isAbsolute) || !supportedVersions.includes(version)) throw Error('Unsupported account runtime')
  let directory = input.directory === '~' ? homedir() : input.directory.startsWith('~/') ? join(homedir(), input.directory.slice(2)) : input.directory
  directory = await realpath(directory)
  if (!(await stat(directory)).isDirectory()) throw Error('Remote workspace is not a directory')
  const { createHash } = await import('node:crypto')
  const { pathToFileURL } = await import('node:url')
  const { writeFile } = await import('node:fs/promises')
  const hash = createHash('sha256').update(account.serviceSource).update(account.bridgeSource).digest('hex')
  const stage = join(root, 'tools/account-web', hash), module = join(stage, 'account-service.mjs')
  await mkdir(stage, { recursive: true, mode: 0o700 })
  if ((await lstat(stage)).isSymbolicLink()) throw Error('Unsafe account service source directory')
  try { await writeFile(module, account.serviceSource, { mode: 0o600, flag: 'wx' }) }
  catch (error) { if (error.code !== 'EEXIST') throw error; if ((await lstat(module)).isSymbolicLink() || await readFile(module, 'utf8') !== account.serviceSource) throw Error('Account service source mismatch') }
  const service = await import(pathToFileURL(module).href)
  const prepared = await service.stageAccountService({ root, node, dsh, version, ...account })
  const receipt = await service.ensureAccountWeb({ ...prepared.config, timeoutMs: input.timeoutMs })
  await service.ensureSupervisor(prepared.config, prepared.configPath)
  return { ...receipt, directory, userHome: homedir() }
}
