/** Exercise DSH's real third-party updater in a generated home and loopback registry. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'

const run = promisify(execFile), [dsh, requested] = process.argv.slice(2)
assert(dsh && requested, 'usage: native-update-smoke.mjs <DSH 0.2.2-rc.1 executable> <archive>')
const archive = resolve(requested), root = await mkdtemp(join(tmpdir(), 'dsh-native-update-'))
const home = join(root, 'home'), extracted = join(root, 'extracted')
await mkdir(home, { mode: 0o700 }); await mkdir(extracted)
await run('tar', ['-xzf', archive, '-C', extracted])
const pkgRoot = join(extracted, 'package'), pkg = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'))
const from = pkg.version
// A registry candidate with identical tested code; it is never published.
pkg.version = from.includes('-') ? from + '.smoke' : from.split('.').map((n, i) => i === 2 ? Number(n) + 1 : n).join('.') + '-native.smoke'
const candidate = pkg.version
await writeFile(join(pkgRoot, 'package.json'), JSON.stringify(pkg))
await run('npm', ['pack', '--ignore-scripts', '--pack-destination', root], { cwd: pkgRoot })
const bytes = await readFile(join(root, `${pkg.name.replace(/^@/, '').replaceAll('/', '-')}-${candidate}.tgz`))
const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
const env = { ...process.env, HOME: home, DSH_HOME: join(home, '.dsh') }
await run(dsh, ['plugin', '--profile', 'web', 'add', archive, '--registry=https://registry.npmjs.org'], { env, timeout: 120000 })
const profile = join(env.DSH_HOME, 'profiles/web'), manifestPath = join(profile, 'package.json')
const original = JSON.parse(await readFile(manifestPath, 'utf8'))
original.dependencies[pkg.name] = from
original.fixture = 'retain unrelated fields'
await writeFile(manifestPath, JSON.stringify(original))
await writeFile(join(env.DSH_HOME, 'cordis.patch.yml'), '- id: product-analytics\n  disabled: true\n- id: desktop-product-telemetry\n  disabled: true\n', { mode: 0o600 })
const marker = join(home, 'retained-manuscript.md')
await writeFile(marker, 'Fictional local data must remain unchanged.\n')
let registry, child
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0])
  if (path === '/' + pkg.name || path === '/' + pkg.name + '/' + candidate) {
    const version = { ...pkg, dist: { tarball: registry + '/candidate.tgz', integrity } }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(path.endsWith('/' + candidate) ? version : {
      name: pkg.name, 'dist-tags': { latest: candidate }, time: { [candidate]: '2026-01-01T00:00:00.000Z' },
      versions: { [candidate]: version },
    })); return
  }
  if (path === '/candidate.tgz') { res.end(bytes); return }
  try {
    const response = await fetch('https://registry.npmjs.org' + req.url, { signal: AbortSignal.timeout(30000) })
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' })
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch { res.writeHead(502); res.end() }
})
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  registry = 'http://127.0.0.1:' + server.address().port
  const logPath = join(root, 'host.log'), log = await open(logPath, 'wx', 0o600)
  child = spawn(dsh, ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'], { env, stdio: ['ignore', log.fd, log.fd] })
  await log.close()
  let login
  for (let n = 0; n < 600; n++) {
    assert.equal(child.exitCode, null, `Host exited; private diagnostics: ${root}`)
    const raw = (await readFile(logPath, 'utf8')).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]
    if (raw) { login = new URL(raw); break }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert(login, `Host timeout; private diagnostics: ${root}`)
  const auth = await fetch(login, { redirect: 'manual' })
  const headers = { Cookie: auth.headers.getSetCookie().map(row => row.split(';')[0]).join('; '), Origin: login.origin, 'content-type': 'application/json' }
  const rpc = async (name, args) => {
    const method = 'pluginManager/' + name
    const response = await fetch(login.origin + '/api/' + method, { method: 'POST', headers,
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal: AbortSignal.timeout(180000) })
    assert.equal(response.status, 200, name)
    const body = await response.json()
    assert.equal(body.result?.ok, true, `${name}: ${JSON.stringify(body.result?.error)}`)
    return body.result.value
  }
  const bundles = await rpc('listBundles', {})
  assert.equal(bundles.find(row => row.name === pkg.name)?.updatable, true)
  const versions = await rpc('listVersions', { name: pkg.name, options: { registry } })
  assert.equal(versions.status, 'listed', JSON.stringify(versions))
  assert(versions.versions.some(row => row.version === candidate && !row.incompatible))
  const result = await rpc('updateBundle', { name: pkg.name, version: candidate, options: { registry, requestId: randomUUID() } })
  assert(['applied', 'restart-required'].includes(result.result.application), JSON.stringify(result))
  const installed = JSON.parse(await readFile(join(profile, 'node_modules', pkg.name, 'package.json'), 'utf8'))
  assert.equal(installed.version, candidate)
  const after = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.equal(after.dependencies[pkg.name], candidate)
  assert.equal(after.fixture, original.fixture)
  assert.deepEqual(new Set(after.dsh.profile.bundles), new Set(original.dsh.profile.bundles))
  assert.equal(await readFile(marker, 'utf8'), 'Fictional local data must remain unchanged.\n')
  console.log(`Native update passed for ${pkg.name}: compatible candidate, exact registry install, retained selection and local data (${result.result.application}); private diagnostics: ${root}`)
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await new Promise(resolve => { child.once('exit', resolve); const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5000); timer.unref() })
  }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
