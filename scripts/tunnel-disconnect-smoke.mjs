/** Fault injection against an installed archive in a disposable DSH home. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { connect, createServer } from 'node:net'
import ssh2 from 'ssh2'
import { DEFAULT_KNOWN_HOSTS } from '../src/engine/known-hosts.ts'

const run = promisify(execFile), dsh = process.argv[2], archive = process.argv[3]
assert(dsh && archive && isAbsolute(archive), 'usage: node --experimental-transform-types scripts/tunnel-disconnect-smoke.mjs <dsh> <absolute.tgz> [--expect-crash]')
const expectCrash = process.argv[4] === '--expect-crash'
const root = await mkdtemp(join(tmpdir(), 'dsh-tunnel-fault-')), home = join(root, 'home')
await mkdir(join(home, '.ssh'), { recursive: true, mode: 0o700 })
DEFAULT_KNOWN_HOSTS.splice(0, DEFAULT_KNOWN_HOSTS.length, join(home, '.ssh/known_hosts'))
const TEST_USER = 'isolated-fixture', TEST_PASSWORD = 'isolated-fixture-only'
const key = join(root, 'host-key')
await run('ssh-keygen', ['-t', 'ed25519', '-f', key, '-N', '', '-q'])
const hostKey = await readFile(key), publicKey = (await readFile(key + '.pub', 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ')
async function fixture() {
  const clients = new Set(), sockets = new Set()
  let connections = 0, commands = 0
  const echo = createServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.pipe(socket) })
  await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve))
  const server = new ssh2.Server({ hostKeys: [hostKey] }, client => {
    clients.add(client); connections++
    client.on('error', () => {})
    client.once('close', () => clients.delete(client))
    client.on('authentication', auth => {
      if (auth.method === 'password' && auth.username === TEST_USER && auth.password === TEST_PASSWORD) auth.accept()
      else auth.reject()
    })
    client.on('ready', () => {
      client.on('session', accept => { const session = accept(); session.on('exec', (_accept, reject) => { commands++; reject() }) })
      client.on('tcpip', (accept, reject, info) => {
        if (info.destIP !== '127.0.0.1' || info.destPort !== echo.address().port) { reject(); return }
        const stream = accept(), target = connect(info.destPort, '127.0.0.1')
        stream.on('error', () => target.destroy()); stream.once('close', () => target.destroy())
        target.on('error', () => stream.close()); stream.pipe(target).pipe(stream)
      })
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const { appendFile } = await import('node:fs/promises')
  await appendFile(DEFAULT_KNOWN_HOSTS[0], `[127.0.0.1]:${port} ${publicKey}\n`, { mode: 0o600 })
  return { port, echoPort: echo.address().port,
    get connectCount() { return connections }, get commandCount() { return commands },
    killAllClients() { for (const client of clients) client.end() },
    async stop() { for (const client of clients) client.end(); for (const socket of sockets) socket.destroy(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => echo.close(resolve))]) },
  }
}
const env = { ...process.env, HOME: home, DSH_HOME: join(home, '.dsh'),
  DEEPSEEK_API_KEY: 'isolated-fixture-not-a-real-key', DEEPSEEK_BASE_URL: 'http://127.0.0.1:9' }
const install = await run(dsh, ['plugin', '--profile', 'web', 'add', archive], { env, timeout: 60000 })
await writeFile(join(root, 'install.log'), install.stdout + install.stderr, { mode: 0o600 })
const first = await fixture(), second = await fixture()
const logPath = join(root, 'server.log'), log = await open(logPath, 'wx', 0o600)
const child = spawn(dsh, ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'], { env, stdio: ['ignore', log.fd, log.fd] })
await log.close()
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function echo(port, text) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('fixture tunnel timed out')) }, 5000)
    const finish = error => { clearTimeout(timer); socket.destroy(); reject(error) }
    socket.once('connect', () => socket.write(text))
    socket.once('data', bytes => { clearTimeout(timer); socket.destroy(); resolve(bytes.toString()) })
    socket.once('error', finish)
    socket.once('close', () => finish(new Error('fixture tunnel closed')))
  })
}

try {
  let login
  for (let n = 0; n < 450; n++) {
    if (child.exitCode !== null) throw new Error(`Fixture DSH exited before startup; diagnostics: ${root}`)
    const raw = (await readFile(logPath, 'utf8')).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]
    if (raw) { login = new URL(raw); break }
    await delay(200)
  }
  assert(login, `Fixture did not start; diagnostics: ${root}`)
  const auth = await fetch(login, { redirect: 'manual' })
  const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const headers = { Cookie: cookie, Origin: login.origin, 'content-type': 'application/json' }
  const api = async (path, body, status = 200) => {
    const response = await fetch(login.origin + '/api/dsh-ssh/' + path, {
      method: body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
    })
    assert.equal(response.status, status, `fixture ${path}`)
    return response.json()
  }
  for (const [alias, server] of [['broken', first], ['healthy', second]]) {
    await api('hosts', { alias, host: '127.0.0.1', port: server.port, user: TEST_USER,
      auth: { kind: 'password', password: TEST_PASSWORD } }, 201)
  }
  const broken = (await api('tunnel', { action: 'start', alias: 'broken', remotePort: first.echoPort })).tunnel
  const healthy = (await api('tunnel', { action: 'start', alias: 'healthy', remotePort: second.echoPort })).tunnel
  assert.equal(await echo(broken.localPort, 'before disconnect'), 'before disconnect')
  assert.equal(await echo(healthy.localPort, 'independent connection'), 'independent connection')
  first.killAllClients()
  let disconnected = false
  for (let n = 0; n < 100; n++) {
    const status = (await api('connections')).connections.find(item => item.alias === 'broken')
    if (status?.state === 'disconnected') { disconnected = true; break }
    await delay(25)
  }
  assert(disconnected, 'the SSH fixture must actually disconnect before the fault')
  const attemptsBefore = first.connectCount
  for (let n = 0; n < 3; n++) {
    await assert.rejects(echo(broken.localPort, 'must not be replayed'))
    if (expectCrash) break
    assert.equal(child.exitCode, null, 'one failed forward must not terminate DSH')
  }
  if (expectCrash) {
    for (let n = 0; n < 100 && child.exitCode === null; n++) await delay(25)
    assert.notEqual(child.exitCode, null, 'the old archive must reproduce the crash')
    assert.match(await readFile(logPath, 'utf8'), /Not connected/)
    console.log('Old archive reproduced the uncaught Not connected crash in an isolated DSH process')
  } else {
    assert.equal((await api('hosts')).hosts.length, 2)
    assert.equal(await echo(healthy.localPort, 'still forwarding'), 'still forwarding')
    assert.equal(first.connectCount, attemptsBefore, 'failed requests must not reconnect SSH')
    assert.equal(first.commandCount + second.commandCount, 0, 'no SSH commands may be dispatched')
    assert.equal(child.exitCode, null)
    assert(!/fatal uncaught exception/.test(await readFile(logPath, 'utf8')))
    const result = { passed: true, failedForwards: 3, dshStillAlive: true, independentTunnelAlive: true, noReplay: true, noModelRequests: true }
    await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
    console.log('Installed-archive disconnect acceptance passed: DSH survives, independent tunnel works, no reconnect/replay/model requests')
  }
  console.log(`Private fixture diagnostics: ${root}`)
} finally {
  child.kill('SIGTERM')
  if (child.exitCode === null) await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(5000).then(() => { if (child.exitCode === null) child.kill('SIGKILL') }),
  ])
  first.killAllClients(); second.killAllClients()
  await Promise.all([first.stop(), second.stop()])
}
