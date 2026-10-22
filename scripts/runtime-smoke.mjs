/** Run only against an isolated DSH_HOME containing no real host records. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { WebSocket } from 'ws'

const logPath = process.argv[2]
assert(logPath, 'usage: node scripts/runtime-smoke.mjs <isolated-server-log>')
const raw = readFileSync(logPath, 'utf8').match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]
assert(raw, 'server must have started and printed a local login URL')
const login = new URL(raw)
const response = await fetch(login, { redirect: 'manual' })
assert.equal(response.status, 303)
const cookie = response.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')
const headers = { Cookie: cookie, Origin: login.origin, 'Content-Type': 'application/json' }
const api = path => login.origin + '/api/dsh-ssh/' + path
const hosts = await fetch(api('hosts'), { headers })
assert.equal(hosts.status, 200)
assert.deepEqual(await hosts.json(), { hosts: [] }, 'refuse to alter a real/nonempty host store')
for (const endpoint of ['workspaces', 'connections', 'remote/workspaces', 'remote/history/audit']) {
  assert.equal((await fetch(api(endpoint))).status, 401)
  assert.equal((await fetch(api(endpoint), { headers: { ...headers, Origin: 'https://untrusted.invalid' } })).status, 403)
  assert.equal((await fetch(api(endpoint), { headers })).status, 200)
}
assert.equal((await fetch(api('directories'))).status, 401)
assert.equal((await fetch(api('directories'), { headers: { ...headers, Origin: 'https://untrusted.invalid' } })).status, 403)
assert.equal((await fetch(api('directories'), { headers })).status, 400)
for (const endpoint of ['remote/connect', 'remote/open', 'remote/recover', 'remote/history/finish-clear']) {
  assert.equal((await fetch(api(endpoint), { method: 'POST', body: '{}' })).status, 401)
  assert.equal((await fetch(api(endpoint), { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.invalid' }, body: '{}' })).status, 403)
  assert.equal((await fetch(api(endpoint), { method: 'POST', headers, body: '{}' })).status, 400)
}
const unauth = await fetch(api('hosts'))
assert.equal(unauth.status, 401)
const crossSite = await fetch(api('hosts'), { headers: { ...headers, Origin: 'https://untrusted.invalid' } })
assert.equal(crossSite.status, 403)
const html = await (await fetch(login.origin, { headers })).text()
const bundlePath = html.match(/"id":"@biogod\/dsh-ssh","url":"([^"]+)"/)?.[1]
assert(bundlePath, 'plugin must be present in the official browser manifest')
const bundle = await fetch(new URL(bundlePath, login.origin), { headers })
assert.equal(bundle.status, 200)
assert((await bundle.text()).includes('@biogod/dsh-ssh'))
for (const [wsHeaders, expected] of [[{}, 401], [{ Cookie: cookie, Origin: 'https://untrusted.invalid' }, 403]]) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(api('terminal?alias=fixture').replace('http:', 'ws:'), { headers: wsHeaders, handshakeTimeout: 3000 })
    ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); try { assert.equal(res.statusCode, expected); resolve() } catch (error) { reject(error) } })
    ws.once('open', () => { ws.close(); reject(new Error('unauthorized terminal unexpectedly accepted')) })
    ws.on('error', error => { if (!String(error).includes('closed before')) reject(error) })
  })
}
// Test data only, with an intentionally closed discard port. Never contacts a remote host.
const create = await fetch(api('hosts'), { method: 'POST', headers, body: JSON.stringify({
  alias: 'local-smoke-fixture', host: '127.0.0.1', port: 9, user: 'fixture', auth: { kind: 'password', password: 'fixture-only' },
}) })
assert.equal(create.status, 201)
try {
  const workspace = await fetch(api('workspaces'), { method: 'POST', headers,
    body: JSON.stringify({ alias: 'local-smoke-fixture', remotePath: '~' }) })
  assert.equal(workspace.status, 409, 'legacy placeholder creation must be disabled')
  assert(!(await workspace.json()).workspace, 'a failed connection must not create a workspace')
  const exec = await fetch(api('exec'), { method: 'POST', headers, body: JSON.stringify({ alias: 'local-smoke-fixture', command: 'true', timeoutMs: 1000 }) })
  const body = await exec.json()
  assert(body.error || body.success === false, 'connection refusal must not report success')
  assert.deepEqual(await (await fetch(api('connections'), { headers })).json(), { connections: [{ alias: 'local-smoke-fixture', state: 'failed' }] })
} finally {
  const remove = await fetch(api('hosts?alias=local-smoke-fixture'), { method: 'DELETE', headers })
  assert.equal(remove.status, 200)
}
assert.deepEqual(await (await fetch(api('hosts'), { headers })).json(), { hosts: [] })
console.log('Runtime smoke passed: HTTP + terminal auth, same-origin fence, client bundle, host CRUD, failed exec; fixture removed. No model API called.')
