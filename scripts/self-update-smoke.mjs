/** Real package-manager and Host restart acceptance, entirely in a generated HOME. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const [dsh, archiveArgument] = process.argv.slice(2)
const archive = archiveArgument && resolve(archiveArgument)
const normalize = (command, args) => {
  if (command === 'npm' && process.platform === 'win32') return [process.execPath, [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args]]
  if (/\.js$/.test(command)) return [process.execPath, [command, ...args]]
  return [command, args]
}
const exec = (command, args, options) => { const [bin, argv] = normalize(command, args); return promisify(execFile)(bin, argv, { windowsHide: true, ...options }) }
const start = (command, args, options) => { const [bin, argv] = normalize(command, args); return spawn(bin, argv, { windowsHide: true, ...options }) }
assert(dsh && archive, 'usage: self-update-smoke.mjs <DSH executable> <verified archive>')
const root = await mkdtemp(join(tmpdir(), 'dsh-self-update-smoke-'))
const home = join(root, 'home'), extracted = join(root, 'artifact')
await mkdir(home, { mode: 0o700 }); await mkdir(extracted)
await exec('tar', ['-xzf', archive, '-C', extracted])
const pkgDir = join(extracted, 'package'), manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'))
const baseVersion = manifest.version, version = baseVersion + '.smoke'
manifest.version = version
await writeFile(join(pkgDir, 'package.json'), JSON.stringify(manifest))
await exec('npm', ['pack', '--ignore-scripts', '--pack-destination', root], { cwd: pkgDir, timeout: 60000 })
const packed = await readFile(join(root, `biogod-dsh-ssh-${version}.tgz`))
const integrity = 'sha512-' + createHash('sha512').update(packed).digest('base64')
const env = { ...process.env, HOME: home, ...(process.platform === 'win32' ? { USERPROFILE: home } : {}), DSH_HOME: join(home, '.dsh') }
await exec(dsh, ['plugin', '--profile', 'web', 'add', archive, '--registry=https://registry.npmjs.org'], { env, timeout: 90000 })
const profile = join(env.DSH_HOME, 'profiles/web'), state = join(profile, '.dsh-ssh-updates')
// The tarball stands in for the npm release awaiting publication.
const originalProfile = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
originalProfile.dependencies['@biogod/dsh-ssh'] = baseVersion
originalProfile.fixture = 'keep unrelated profile fields'
await writeFile(join(profile, 'package.json'), JSON.stringify(originalProfile))
const fixtureConfig = join(env.DSH_HOME, 'dsh-ssh.json')
await writeFile(fixtureConfig, JSON.stringify({ version: 1, hosts: [] }), { mode: 0o600 })
const originalConfig = await readFile(fixtureConfig)
let host, helper, registry, stopRegistry
const children = []
async function wait(check, milliseconds = 120000) {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) { if (await check().catch(() => false)) return; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error(`Self-update smoke exceeded a deadline; private diagnostics: ${root}`)
}
async function startHost(label) {
  let output = ''
  const child = start(dsh, ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child)
  child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  let login
  await wait(async () => { const raw = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]; if (raw) login = new URL(raw); return !!login })
  const response = await fetch(login, { redirect: 'manual' })
  const headers = { Cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), Origin: login.origin }
  const view = async () => {
    let value
    try {
      await wait(async () => {
        const response = await fetch(login.origin + '/api/dsh-ssh/update', { headers, signal: AbortSignal.timeout(10000) })
        if (response.status === 404) return false // Listening precedes asynchronous plugin imports.
        assert.equal(response.status, 200, label + ' updater route'); value = await response.json(); return true
      }, 45000)
    } catch (error) { console.error(output.replace(/token=[^&\s]+/g, 'token=<redacted>')); throw error }
    return value
  }
  const setEnabled = async enabled => {
    const response = await fetch(login.origin + '/api/dsh-ssh/update', { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }), signal: AbortSignal.timeout(45000) })
    assert.equal(response.status, 200, 'update setting mutation')
  }
  return { child, view, setEnabled, login }
}
try {
  host = await startHost('before')
  const initial = await host.view()
  assert.equal(initial.enabled, false); assert.equal(initial.supported, true); assert.equal(initial.runningVersion, baseVersion)
  if (process.env.DSH_UPDATE_BROWSER_SMOKE === '1') {
    await writeFile(join(root, 'browser.json'), JSON.stringify({ login: host.login.href, profile, root }), { mode: 0o600 })
    console.log(JSON.stringify({ browserFixture: root }))
    await wait(async () => { await readFile(join(root, 'browser-complete')); return true }, 180000)
  }
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(req.url.split('?')[0])
    if (path === '/@biogod/dsh-ssh') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ name: '@biogod/dsh-ssh', 'dist-tags': { latest: version }, versions: {
        [version]: { ...manifest, dist: { tarball: registry + `/@biogod/dsh-ssh/-/dsh-ssh-${version}.tgz`, integrity } },
      } })); return
    }
    if (path === `/@biogod/dsh-ssh/-/dsh-ssh-${version}.tgz`) { res.end(packed); return }
    try {
      const upstream = await fetch('https://registry.npmjs.org' + req.url, { signal: AbortSignal.timeout(30000) })
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      res.end(Buffer.from(await upstream.arrayBuffer()))
    } catch { res.writeHead(502); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  registry = 'http://127.0.0.1:' + server.address().port
  stopRegistry = () => { server.closeAllConnections(); server.close() }
  const configFile = join(state, 'config.json')
  const config = JSON.parse(await readFile(configFile, 'utf8')); config.enabled = true
  const wrapper = join(root, 'package-manager.cjs')
  await writeFile(wrapper, `const fs=require('fs'),cp=require('child_process');const out=fs.openSync(${JSON.stringify(join(root, 'package-manager.log'))},'a',0o600);const child=cp.spawn(process.argv[2],process.argv.slice(3),{stdio:['ignore',out,out]});child.on('error',()=>process.exit(1));child.on('exit',code=>process.exit(code??1));`)
  config.packageManager = { command: process.execPath, args: [wrapper, config.packageManager.command, ...config.packageManager.args], env: config.packageManager.env }
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 })
  const worker = join(pkgDir, 'lib/update-worker.js')
  let diagnostics = ''
  helper = spawn(config.executable, [...config.executableArgs, '--input-type=module', '-e', 'import(process.argv[1]).then(m=>m.runUpdate(process.argv[2],{registry:process.argv[3],onError:e=>console.error(e)}))', pathToFileURL(worker).href, configFile, registry],
    { env: { ...env, PATH: process.platform === 'win32' ? process.env.SystemRoot + '\\System32;' + process.env.SystemRoot : '/usr/bin:/bin:/usr/sbin:/sbin', ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] }); children.push(helper)
  helper.stderr.on('data', bytes => { diagnostics += bytes })
  const phase = async () => JSON.parse(await readFile(join(state, 'status.json'), 'utf8')).phase
  try { await wait(async () => await phase() === 'waiting') }
  catch (error) { await writeFile(join(root, 'helper.log'), diagnostics, { mode: 0o600 }); console.error(diagnostics); console.error(await readFile(join(root, 'package-manager.log'), 'utf8').catch(() => 'Package manager was not started')); throw error }
  assert.equal((await host.view()).runningVersion, baseVersion, 'the running Host must not be replaced')
  host.child.kill('SIGTERM'); await new Promise(resolve => host.child.once('exit', resolve))
  await wait(async () => helper.exitCode !== null)
  await writeFile(join(root, 'helper.log'), diagnostics, { mode: 0o600 })
  assert.equal(await phase(), 'installed', 'the independent helper must finish after Host exit')
  assert.deepEqual(await readFile(fixtureConfig), originalConfig)
  const updatedProfile = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.equal(updatedProfile.fixture, originalProfile.fixture)
  assert.equal(updatedProfile.dependencies['@biogod/dsh-ssh'], version)
  host = await startHost('after')
  assert.equal((await host.view()).runningVersion, version, 'the next Host must execute the prepared package')
  await host.setEnabled(false)
  host.child.kill('SIGTERM'); await new Promise(resolve => host.child.once('exit', resolve))
  try {
    await exec(config.packageManager.command, [...config.packageManager.args, 'install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile', '--registry=' + registry],
    { cwd: await realpath(profile), env: { ...env, ...config.packageManager.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 120000 })
  } catch (error) { console.error(await readFile(join(root, 'package-manager.log'), 'utf8')); throw error }
  assert.equal(JSON.parse(await readFile(join(profile, 'node_modules/@biogod/dsh-ssh/package.json'), 'utf8')).version, version)
  console.log('Self-update acceptance passed: real pnpm, verified archive, active Host protection, exit installation, retained SSH config, and new version after restart')
} finally {
  if (host?.child.exitCode === null) { try { await host.setEnabled(false) } catch {} }
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
  stopRegistry?.()
}
