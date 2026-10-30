/** One default Web runtime per account. Private receipts never enter public output. */
import { mkdir, readFile, writeFile, rename, lstat, realpath, unlink, rmdir, open, symlink }  from 'node:fs/promises'
import { join, dirname, isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
export const accountServicePaths = home => ({ directory: join(home, 'services/web'), receipt: join(home, 'services/web/server.json'),
  lock: join(home, 'services/web/ensure.lock'), log: join(home, 'services/web/server.log'), supervisor: join(home, 'services/web/supervisor.json'),
  supervisorLog: join(home, 'services/web/supervisor.log'), stopped: join(home, 'services/web/stopped') })
export async function writeAccountJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const old = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error })
  if (old && (!old.isFile() || old.isSymbolicLink())) throw Error('Unsafe account service state')
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await rename(temp, path)
}
export async function readAccountJson(path) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || process.getuid && info.uid !== process.getuid()) throw Error('Account service state must be private')
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}
function safeUrl(receipt) {
  if (!receipt?.url) return undefined
  const url = new URL(receipt.url)
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || Number(url.port) !== receipt.port
    || url.pathname !== '/' || !url.searchParams.get('token') || url.username || url.password) throw Error('Unsafe account service URL')
  return url
}
export async function probeAccountWeb(receipt, home) {
  if (!receipt || !alive(receipt.pid) || receipt.uid !== undefined && receipt.uid !== process.getuid?.()) return false
  if (receipt.home && await realpath(receipt.home) !== await realpath(home)) return false
  const url = safeUrl(receipt)
  if (!url) return false
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    await response.body?.cancel()
    return response.status === 303 && response.headers.has('set-cookie')
  } catch { return false }
}
export async function publishAccountWeb(config, receipt) {
  const home = await realpath(config.home), value = { ...receipt, protocol: 1, home, root: config.root, uid: process.getuid?.() }
  if (!safeUrl(value)) throw Error('Incomplete account service receipt')
  await writeAccountJson(accountServicePaths(home).receipt, value)
  // Older SSH controllers keep the same daemon identity and data path.
  await writeAccountJson(join(config.root, 'state/server.json'), value)
  return value
}
export async function accountWebActivity(receipt) {
  const url = safeUrl(receipt)
  if (!url) throw Error('No authenticated account service receipt')
  const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
  await login.body?.cancel()
  if (login.status !== 303) throw Error('Account service authentication could not be checked')
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const response = await fetch(url.origin + '/api/dsh-account-service/activity', {
    headers: { Cookie: cookie, Origin: url.origin }, signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) { await response.body?.cancel(); throw Error('Account activity check is unavailable; service retained') }
  const value = await response.json()
  if (value?.checked !== true || typeof value.idle !== 'boolean') throw Error('Account activity result is incompatible')
  return value
}
async function launchUrl(path) {
  try {
    const f = await open(path, 'r')
    try {
      const bytes = Buffer.alloc(Math.min((await f.stat()).size, 128 * 1024))
      await f.read(bytes, 0, bytes.length, Math.max(0, (await f.stat()).size - bytes.length))
      return [...bytes.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '').matchAll(/http:\/\/127\.0\.0\.1:\d+\/?\?token=[A-Za-z0-9_.~%-]+/g)].at(-1)?.[0]
    } finally { await f.close() }
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}
async function reconcile(config, paths) {
  const receipt = await readAccountJson(paths.receipt)
  if (await probeAccountWeb(receipt, config.home)) return receipt
  if (receipt && alive(receipt.pid)) {
    // A live but unready service is never replaced.
    const url = await launchUrl(paths.log)
    if (url) {
      const recovered = { ...receipt, url, port: Number(new URL(url).port) }
      if (await probeAccountWeb(recovered, config.home)) return publishAccountWeb(config, recovered)
    }
    const owner = await readAccountJson(join(paths.lock, 'owner.json'))
    if (!receipt.url && owner && alive(owner.pid)) return undefined
    throw Error('The account Web process is alive but unready; no second process was started')
  }
  const legacy = await readAccountJson(join(config.root, 'state/server.json'))
  let sameHome = false
  try { sameHome = await realpath(join(config.root, 'data')) === await realpath(config.home) } catch {}
  if (legacy && alive(legacy.pid) && sameHome) {
    if (await probeAccountWeb(legacy, config.home)) return publishAccountWeb(config, legacy)
    throw Error('The existing account runtime is alive but cannot be authenticated; it was retained')
  }
}
export async function ensureAccountWeb(config) {
  if (![config.home, config.root, config.node, config.dsh].every(isAbsolute)) throw Error('Account service paths must be absolute')
  config = { ...config, home: await realpath(config.home) }
  const paths = accountServicePaths(config.home)
  await mkdir(paths.directory, { recursive: true, mode: 0o700 })
  const existing = await reconcile(config, paths)
  if (existing) return existing
  try { await mkdir(paths.lock, { mode: 0o700 }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    let owner = await readAccountJson(join(paths.lock, 'owner.json'))
    if (!owner) { await delay(100); owner = await readAccountJson(join(paths.lock, 'owner.json')) }
    if (!owner || !alive(owner.pid)) throw Error('Account startup was interrupted; inspect its private receipt before retrying')
    const deadline = Date.now() + (config.timeoutMs ?? 90000)
    while (Date.now() < deadline) {
      const value = await reconcile(config, paths)
      if (value) return value
      if (!alive(owner.pid)) throw Error('Account startup result is unconfirmed; it was not repeated')
      await delay(200)
    }
    throw Error('The account service is still starting; no second launch was dispatched')
  }
  await writeAccountJson(join(paths.lock, 'owner.json'), { pid: process.pid })
  try {
    const afterLock = await reconcile(config, paths)
    if (afterLock) return afterLock
    const oldLog = await lstat(paths.log).catch(error => { if (error.code !== 'ENOENT') throw error })
    if (oldLog?.isSymbolicLink()) throw Error('Account service log must not be a symlink')
    const log = await open(paths.log, 'w', 0o600)
    let child
    await writeAccountJson(join(paths.lock, 'child.json'), { dispatched: true })
    try {
      child = spawn(config.dsh, ['web', '--host', '127.0.0.1', '--port', String(config.port ?? 3080), '--no-open'], {
        cwd: config.home, env: { ...process.env, DSH_HOME: config.home, PATH: `${dirname(config.node)}:${process.env.PATH ?? ''}` },
        detached: true, stdio: ['ignore', log.fd, log.fd],
      })
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    } finally { await log.close() }
    child.unref()
    await writeAccountJson(join(paths.lock, 'child.json'), { pid: child.pid })
    let receipt = { protocol: 1, pid: child.pid, port: 0, url: '', home: config.home, root: config.root,
      uid: process.getuid?.(), userHome: config.userHome ?? homedir(), directory: config.home, version: config.version }
    await writeAccountJson(paths.receipt, receipt)
    const deadline = Date.now() + (config.timeoutMs ?? 90000)
    while (Date.now() < deadline) {
      const url = await launchUrl(paths.log)
      if (url) {
        const ready = { ...receipt, url, port: Number(new URL(url).port) }
        if (await probeAccountWeb(ready, config.home)) return publishAccountWeb(config, ready)
      }
      if (!alive(child.pid)) throw Error('Account Web startup failed; inspect its private service log')
      await delay(200)
    }
    throw Error('Account startup result is unconfirmed; the live process was retained')
  } finally {
    const childRecord = await readAccountJson(join(paths.lock, 'child.json'))
    const published = await readAccountJson(paths.receipt)
    if (!childRecord || published?.pid === childRecord.pid) {
      await unlink(join(paths.lock, 'child.json')).catch(error => { if (error.code !== 'ENOENT') throw error })
      await unlink(join(paths.lock, 'owner.json')); await rmdir(paths.lock)
    }
  }
}
export async function stopAccountWeb(config) {
  const paths = accountServicePaths(await realpath(config.home)), receipt = await readAccountJson(paths.receipt)
  if (!receipt || !alive(receipt.pid)) {
    await mkdir(paths.directory, { recursive: true, mode: 0o700 })
    await writeFile(paths.stopped, 'explicit-stop\n', { mode: 0o600 }); return
  }
  if (!await probeAccountWeb(receipt, config.home)) throw Error('Service identity cannot be confirmed; no stop was sent')
  const activity = await accountWebActivity(receipt)
  if (activity.pid !== receipt.pid) throw Error('Service process identity changed; no stop was sent')
  if (!activity.idle) throw Error('The account has active work; its service was retained')
  await writeFile(paths.stopped, 'explicit-stop\n', { mode: 0o600 })
  process.kill(receipt.pid, 'SIGINT')
  const deadline = Date.now() + 15000
  while (alive(receipt.pid) && Date.now() < deadline) await delay(100)
  if (alive(receipt.pid)) throw Error('The account service is still shutting down; no force kill was used')
}
export async function ensureSupervisor(config, configPath) {
  const paths = accountServicePaths(await realpath(config.home)), lock = join(paths.directory, 'supervisor.lock')
  try { await mkdir(lock, { mode: 0o700 }) } catch (error) { if (error.code === 'EEXIST') return; throw error }
  try {
    const record = await readAccountJson(paths.supervisor)
    if (record && alive(record.pid)) return
    const log = await open(paths.supervisorLog, 'a', 0o600)
    try {
      const child = spawn(config.node, [fileURLToPath(import.meta.url), '--account-service-supervise', configPath], {
        cwd: config.home, env: process.env, stdio: ['ignore', log.fd, log.fd], detached: true,
      })
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) }); child.unref()
      await writeAccountJson(paths.supervisor, { pid: child.pid, home: config.home })
    } finally { await log.close() }
  } finally { await rmdir(lock) }
}
async function supervise(config) {
  const paths = accountServicePaths(await realpath(config.home))
  let stopped = false
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = true })
  while (!stopped) {
    try { if ((await lstat(paths.stopped)).isFile()) break } catch (error) { if (error.code !== 'ENOENT') break }
    try { await ensureAccountWeb(config) } catch { /* Keep live/uncertain owners; a later explicit invocation reports the error. */ }
    await delay(3000)
  }
}
function webInvocation(args) {
  if (args[0] === 'web') return args.slice(1)
  if (args[0] === '--profile' && args[1] === 'web') return args.slice(2)
  if (args[0] === '--profile=web') return args.slice(1)
}
export async function runAccountCli(configPath, args) {
  const config = await readAccountJson(configPath)
  if (!config) throw Error('Default account service is not configured')
  const canonical = await realpath(config.home)
  let explicit = process.env.DSH_HOME
  if (explicit?.startsWith('~/')) explicit = join(homedir(), explicit.slice(2))
  const isolated = explicit && await realpath(resolve(explicit)).catch(() => resolve(explicit)) !== canonical
  const web = webInvocation(args)
  if (isolated || web === undefined && args[0] !== 'service' || args.some(value => ['--help', '-h', '--dump-config', '--dump-config-schema', '--dump-default-config', '--patch'].includes(value))) {
    const child = spawn(config.dsh, args, { stdio: 'inherit', env: { ...process.env, ...(!explicit ? { DSH_HOME: canonical } : {}) } })
    return await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) })
  }
  if (args[0] === 'service' && !['start', 'status', 'stop', 'restart'].includes(args[1])) throw Error('Usage: dsh service start|status|stop|restart')
  const paths = accountServicePaths(canonical)
  if (args[0] === 'service' && args[1] === 'stop') { await stopAccountWeb(config); console.log('Default DSH Web service stopped.'); return 0 }
  if (args[0] === 'service' && args[1] === 'restart') await stopAccountWeb(config)
  if (args[0] === 'service' && args[1] === 'status') {
    const receipt = await readAccountJson(paths.receipt)
    console.log(JSON.stringify({ running: await probeAccountWeb(receipt, canonical), pid: receipt?.pid,
      origin: receipt?.port ? `${new URL(receipt.url).protocol}//127.0.0.1:${receipt.port}` : undefined, home: canonical, version: receipt?.version }))
    return 0
  }
  if (web?.some(value => value === '--host' || value.startsWith('--host='))) {
    const at = web.indexOf('--host'), host = at >= 0 ? web[at + 1] : web.find(value => value.startsWith('--host='))?.slice(7)
    if (host !== '127.0.0.1') throw Error('The shared account service only listens on 127.0.0.1')
  }
  await unlink(paths.stopped).catch(error => { if (error.code !== 'ENOENT') throw error })
  const receipt = await ensureAccountWeb(config)
  await ensureSupervisor(config, configPath)
  const origin = new URL(receipt.url).origin
  console.log(`Default DSH Web service: ${origin}/ (PID ${receipt.pid})`)
  if (process.stdout.isTTY) console.log(receipt.url)
  return 0
}
const ownEntry = process.argv[1] && await realpath(process.argv[1]).catch(() => undefined) === await realpath(fileURLToPath(import.meta.url))
if (ownEntry && process.argv[2] === '--account-service-supervise') await supervise(await readAccountJson(process.argv[3]))
else if (ownEntry && process.argv[2] === '--account-service-cli') {
  try { process.exitCode = await runAccountCli(process.argv[3], process.argv.slice(4)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}

/** Default homes share physical data; explicit fixture/research homes remain isolated. */
export async function prepareAccountHome({ root, home = join(homedir(), '.dsh') }) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const legacy = join(root, 'data')
  const exists = async path => lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error })
  const a = await exists(home), b = await exists(legacy)
  if (a && b) {
    if (await realpath(home) !== await realpath(legacy)) throw Error('Two existing default DSH homes require a backed-up merge; neither was replaced')
  } else if (a) await symlink(await realpath(home), legacy)
  else if (b) { await mkdir(dirname(home), { recursive: true, mode: 0o700 }); await symlink(await realpath(legacy), home) }
  else { await mkdir(home, { recursive: true, mode: 0o700 }); if (home !== legacy) await symlink(await realpath(home), legacy) }
  if (!(await lstat(await realpath(home))).isDirectory()) throw Error('Default DSH home is not a directory')
  return realpath(home)
}
export async function stageAccountService({ root, home, dsh, node, version, serviceSource, bridgeSource, installEntry = true, port = 3080 }) {
  home = await prepareAccountHome({ root, home })
  const hash = createHash('sha256').update(serviceSource).update(bridgeSource).digest('hex')
  const directory = join(root, 'tools/account-web', hash), module = join(directory, 'account-service.mjs')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (const [file, source] of [['account-service.mjs', serviceSource], ['account-service-bridge.mjs', bridgeSource]]) {
    const path = join(directory, file)
    try { await writeFile(path, source, { flag: 'wx', mode: 0o600 }) }
    catch (error) { if (error.code !== 'EEXIST') throw error; if ((await lstat(path)).isSymbolicLink() || await readFile(path, 'utf8') !== source) throw Error('Account service source changed unexpectedly') }
  }
  const profile = join(home, 'profiles/web'), patchPath = join(profile, 'cordis.patch.yml')
  await mkdir(profile, { recursive: true, mode: 0o700 })
  let patch = await readFile(patchPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  if ((await lstat(patchPath).catch(() => undefined))?.isSymbolicLink()) throw Error('Profile patch must not be a symlink')
  const start = '# dsh-account-service managed start', end = '# dsh-account-service managed end'
  if (patch.includes(start)) {
    const from = patch.indexOf(start), to = patch.indexOf(end, from)
    if (to < 0 || patch.indexOf(start, from + 1) >= 0) throw Error('Account service patch marker is ambiguous')
    patch = patch.slice(0, from) + patch.slice(to + end.length)
  }
  const content = patch.replace(/^\s*#.*$/gm, '').trim()
  if (content === '[]') patch = patch.replace(/^\s*\[\]\s*$/m, '')
  else if (content && !content.startsWith('-')) throw Error('Expected the native profile patch array')
  const block = `${start}\n- insert:\n    - id: dsh-account-service\n      name: ${JSON.stringify(join(directory, 'account-service-bridge.mjs'))}\n      config: ${JSON.stringify({ root, version })}\n${end}\n`
  const updated = `${patch.trimEnd()}\n${block}`
  const before = await readFile(patchPath, 'utf8').catch(() => '')
  if (before !== updated) {
    if (before) await writeFile(join(directory, `patch-before-${randomUUID()}.yml`), before, { mode: 0o600, flag: 'wx' })
    const temp = `${patchPath}.${randomUUID()}.tmp`; await writeFile(temp, updated, { mode: 0o600, flag: 'wx' }); await rename(temp, patchPath)
  }
  const configPath = join(home, 'services/web/config.json'), launcher = join(homedir(), '.local/bin/dsh')
  const prior = await readAccountJson(configPath)
  // Installing a newer SSH helper does not silently change the account's core.
  if (prior) { dsh = prior.dsh; node = prior.node; version = prior.version; port = prior.port ?? port }
  const config = { root, home, dsh, node, version, port }
  if (installEntry) {
    await mkdir(dirname(launcher), { recursive: true, mode: 0o700 })
    const info = await lstat(launcher).catch(error => { if (error.code !== 'ENOENT') throw error })
    const previousWrapper = info?.isFile() && (await readFile(launcher, 'utf8')).includes('# dsh-account-service entry v1')
    if (!previousWrapper && info) {
      const backup = join(dirname(launcher), `.dsh-before-account-${Date.now()}-${randomUUID()}`)
      if (resolve(dsh) === launcher) config.dsh = info.isSymbolicLink() ? await realpath(launcher) : backup
      await rename(launcher, backup)
    }
    const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`
    const source = `#!/bin/sh\n# dsh-account-service entry v1\nexec ${quote(node)} ${quote(module)} --account-service-cli ${quote(configPath)} "$@"\n`
    const temp = `${launcher}.${randomUUID()}.tmp`; await writeFile(temp, source, { flag: 'wx', mode: 0o755 }); await rename(temp, launcher)
  }
  await writeAccountJson(configPath, config)
  return { config, configPath, module, home }
}
