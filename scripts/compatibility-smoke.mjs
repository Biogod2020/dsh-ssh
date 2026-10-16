/** Isolated compatibility acceptance. Never reads or edits the daily DSH home. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

const run = promisify(execFile)
const dsh = process.argv[2] ?? 'dsh'
const source = process.argv[3] ?? `link:${process.cwd()}`
const registryArgs = process.env.DSH_SMOKE_REGISTRY ? [`--registry=${process.env.DSH_SMOKE_REGISTRY}`] : []
const version = (await run(dsh, ['--version'])).stdout.trim()
const root = await mkdtemp(join(tmpdir(), 'dsh-compat-smoke-'))
const home = join(root, 'home'), logPath = join(root, 'server.log')
await mkdir(home, { mode: 0o700 })
const env = { ...process.env, HOME: home, DSH_HOME: join(home, '.dsh') }
if (process.argv[4] === '--from-link') {
  await run(dsh, ['plugin', '--profile', 'web', 'add', `link:${process.cwd()}`], { env, timeout: 60000 })
}
await run(dsh, ['plugin', '--profile', 'web', 'add', source, ...registryArgs], { env, timeout: 60000 })
const log = await open(logPath, 'wx', 0o600)
const child = spawn(dsh, ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
  env, stdio: ['ignore', log.fd, log.fd],
})
await log.close()
try {
  let login
  for (let i = 0; i < 450; i++) {
    if (child.exitCode !== null) throw new Error(`DSH ${version} exited during startup; private diagnostics: ${root}`)
    const raw = (await readFile(logPath, 'utf8')).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]
    if (raw) { login = new URL(raw); break }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert(login, `DSH did not start; private diagnostics: ${root}`)
  const smoke = await run(process.execPath, ['scripts/runtime-smoke.mjs', logPath], { timeout: 30000 })
  process.stdout.write(smoke.stdout)
  const response = await fetch(login, { redirect: 'manual' })
  const cookie = response.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')
  const headers = { Cookie: cookie, Origin: login.origin, 'content-type': 'application/json' }
  const rpc = async (method, args) => {
    const response = await fetch(login.origin + '/api/' + method, {
      method: 'POST', headers, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
      signal: AbortSignal.timeout(10000),
    })
    assert.equal(response.status, 200, `${method} HTTP status`)
    const body = await response.json()
    assert.equal(body.result?.ok, true, `${method} must succeed`)
    return body.result.value
  }
  const before = await rpc('settings/describe', {})
  const section = before.namespaces.find(row => row.ns === 'ssh-ops') ?? before.namespaces.find(row => row.ns === 'dsh-ssh')
  assert(section, 'SSH settings must appear in the native forms')
  const namespace = section.ns
  const set = async (field, value) => {
    const current = (await rpc('settings/describe', {})).namespaces.find(row => row.ns === namespace)
    await rpc('settings/mutate', { ns: namespace, ops: [{ op: 'set', path: [field], value }], expectedRevision: current.revision })
  }
  await set('terminalFontFamily', 'monospace')
  assert.equal((await fetch(login.origin + '/api/dsh-ssh/hosts', { headers })).status, 200)
  await set('enabled', false)
  assert.equal((await fetch(login.origin + '/api/dsh-ssh/hosts', { headers })).status, 404)
  await set('enabled', true)
  assert.equal((await fetch(login.origin + '/api/dsh-ssh/hosts', { headers })).status, 200)
  assert.equal(child.exitCode, null, 'settings must leave the server running')
  console.log(`DSH ${version} compatibility passed: native settings, enable/disable, isolated runtime; diagnostics: ${root}`)
} finally {
  child.kill('SIGTERM')
  if (child.exitCode === null) await new Promise(resolve => {
    child.once('exit', resolve)
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5000)
    timer.unref()
  })
}
