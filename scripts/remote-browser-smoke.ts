/** Isolated browser fixture. Every SSH write and runtime install belongs to the printed temporary root. */
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, createWriteStream, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { TestSshd } from '../tests/helpers/sshd.ts'
import { slowTcp } from '../tests/helpers/slow-tcp.ts'
import { InteractiveSsh } from '../tests/helpers/interactive-ssh.ts'
import { gatedTcp } from '../tests/helpers/gated-tcp.ts'
import { DEFAULT_KNOWN_HOSTS } from '../src/engine/known-hosts.ts'
import { HostStore } from '../src/store.ts'
import { SshEngine } from '../src/engine.ts'
import { SshWorkspaces, type SshWorkspace } from '../src/workspaces.ts'
import { randomUUID } from 'node:crypto'

const extraClusterTargets = Number(process.env.DSH_CLUSTER_SCALE_SMOKE ?? '0')
if (!Number.isInteger(extraClusterTargets) || extraClusterTargets < 0 || extraClusterTargets > 24 || extraClusterTargets > 0 && process.env.DSH_CLUSTER_SMOKE !== '1') {
  throw new Error('DSH_CLUSTER_SCALE_SMOKE requires cluster mode and an integer from 0 to 24')
}
const root = mkdtempSync(join(tmpdir(), 'dsh-remote-browser-'))
const local = join(root, 'local'), remote = join(root, 'remote')
mkdirSync(join(local, '.ssh'), { recursive: true }); mkdirSync(remote)
DEFAULT_KNOWN_HOSTS.splice(0, DEFAULT_KNOWN_HOSTS.length, join(local, '.ssh/known_hosts'))
const sshd = await TestSshd.start({ home: remote, path: '/usr/bin:/bin:/usr/sbin:/sbin' })
const transferFixture = process.env.DSH_TRANSFER_SMOKE === '1'
const clusterFixture = process.env.DSH_CLUSTER_SMOKE === '1'
const interactive = process.env.DSH_TERMINAL_AUTH_SMOKE === '1' ? await InteractiveSsh.start() : undefined
const connectionGate = process.env.DSH_CONNECTION_WAIT_SMOKE === '1' ? await gatedTcp(sshd.port) : undefined
let gateTimer: ReturnType<typeof setInterval> | undefined
if (connectionGate) {
  const hostKey = readFileSync(DEFAULT_KNOWN_HOSTS[0]!, 'utf8').split('\n').find(line => line.startsWith(`[127.0.0.1]:${sshd.port} `))!
  appendFileSync(DEFAULT_KNOWN_HOSTS[0]!, hostKey.replace(`[127.0.0.1]:${sshd.port}`, `[127.0.0.1]:${connectionGate.port}`) + '\n')
  writeFileSync(join(remote, 'waiting-download.bin'), Buffer.alloc(262144, 43), { mode: 0o600 })
  gateTimer = setInterval(() => {
    let action = ''
    try { action = readFileSync(join(root, 'connection-control'), 'utf8').trim() } catch {}
    if (action === 'release' && connectionGate.holding) connectionGate.release()
    else if (action === 'hold' && !connectionGate.holding) connectionGate.hold()
    writeFileSync(join(root, 'connection-gate.json'), JSON.stringify({ port: connectionGate.port,
      holding: connectionGate.holding, active: connectionGate.activeConnections, accepted: connectionGate.acceptedConnections }), { mode: 0o600 })
  }, 100)
  gateTimer.unref()
}
if (interactive) writeFileSync(join(root, 'auth-inputs.json'), JSON.stringify(interactive.answers), { mode: 0o600 })
const paced = transferFixture ? await slowTcp(sshd.port) : undefined
if (paced) {
  const hostKey = readFileSync(DEFAULT_KNOWN_HOSTS[0]!, 'utf8').split('\n').find(line => line.startsWith(`[127.0.0.1]:${sshd.port} `))!
  appendFileSync(DEFAULT_KNOWN_HOSTS[0]!, hostKey.replace(`[127.0.0.1]:${sshd.port}`, `[127.0.0.1]:${paced.port}`) + '\n')
  const payload = Buffer.alloc(2 * 1024 * 1024)
  for (let index = 0; index < payload.length; index++) payload[index] = index % 251
  writeFileSync(join(local, 'transfer-payload.bin'), payload, { mode: 0o600 })
  writeFileSync(join(remote, 'download-payload.bin'), payload, { mode: 0o600 })
  for (const [name, bytes] of [['queue-one.bin', payload], ['queue-two.bin', payload.subarray(0, 131072)], ['queue-three.bin', payload], ['queue-four.bin', payload.subarray(0, 262144)]] as const) {
    writeFileSync(join(local, name), bytes, { mode: 0o600 })
  }
  for (const [name, bytes] of [['queue-download-a.bin', payload], ['queue-download-b.bin', payload.subarray(0, 262144)]] as const) {
    writeFileSync(join(remote, name), bytes, { mode: 0o600 })
  }
}
let secondary: TestSshd | undefined
const secondaryHome = join(root, 'remote-secondary')
if (process.env.DSH_MULTI_TERMINAL_SMOKE === '1' || clusterFixture) {
  mkdirSync(secondaryHome)
  secondary = await TestSshd.start({ home: secondaryHome, path: '/usr/bin:/bin:/usr/sbin:/sbin' })
}
const scaled: Array<{ alias: string; home: string; server: TestSshd }> = []
for (let index = 1; index <= extraClusterTargets; index++) {
  const alias = `scale-${String(index).padStart(2, '0')}`, home = join(root, `remote-cluster-${String(index).padStart(2, '0')}`)
  mkdirSync(home)
  scaled.push({ alias, home, server: await TestSshd.start({ home, path: '/usr/bin:/bin:/usr/sbin:/sbin' }) })
}
const env = { ...process.env, HOME: local, DSH_HOME: join(local, '.dsh') }
const dsh = process.env.DSH_SMOKE_DSH ?? 'dsh'
await promisify(execFile)(dsh, ['plugin', '--profile', 'web', 'add', process.env.DSH_SMOKE_PLUGIN ?? `link:${process.cwd()}`], { env, timeout: 60000 })
const store = new HostStore(join(env.DSH_HOME, 'dsh-ssh.json'))
store.create({ alias: 'isolated-remote', host: '127.0.0.1', port: sshd.port, user: process.env.USER!, auth: { kind: 'key', keyPath: sshd.clientKey }, ...(clusterFixture ? { environment: 'test', tags: ['fixture', 'primary'] } : {}) })
if (paced) store.create({ alias: 'isolated-slow', host: '127.0.0.1', port: paced.port, user: process.env.USER!, auth: { kind: 'key', keyPath: sshd.clientKey } })
if (secondary) {
  store.create({ alias: 'isolated-secondary', host: '127.0.0.1', port: secondary.port, user: process.env.USER!, auth: { kind: 'key', keyPath: secondary.clientKey }, ...(clusterFixture ? { environment: 'test', tags: ['fixture', 'secondary'] } : {}) })
  store.create({ alias: 'unreachable-fixture', host: '127.0.0.1', port: 1, user: process.env.USER!, auth: { kind: 'key', keyPath: sshd.clientKey } })
}
if (clusterFixture) for (const alias of ['queued-one', 'queued-two']) store.create({ alias, host: '127.0.0.1', port: sshd.port, user: process.env.USER!, auth: { kind: 'key', keyPath: sshd.clientKey }, environment: 'test', tags: ['fixture', 'primary'] })
for (const target of scaled) store.create({ alias: target.alias, host: '127.0.0.1', port: target.server.port, user: process.env.USER!, auth: { kind: 'key', keyPath: target.server.clientKey }, environment: 'test', tags: ['fixture', 'scaled'] })
if (interactive) store.create({ alias: 'isolated-interactive', host: '127.0.0.1', port: interactive.port, user: 'fixture', auth: { kind: 'password' } })
if (connectionGate) store.create({ alias: 'isolated-waiting', host: '127.0.0.1', port: connectionGate.port, user: process.env.USER!, auth: { kind: 'key', keyPath: sshd.clientKey } })
const engine = new SshEngine(store)
let legacy: SshWorkspace | undefined
try {
  const check = await engine.exec('isolated-remote', 'printf "%s" "$HOME"')
  if (!check.success || check.stdout !== remote) { sshd.stop(); throw new Error('Fixture SSH HOME isolation failed; no remote installation attempted') }
  if (secondary) {
    const check = await engine.exec('isolated-secondary', 'printf "%s" "$HOME"')
    if (!check.success || check.stdout !== secondaryHome) { secondary.stop(); sshd.stop(); throw new Error('Secondary fixture HOME isolation failed') }
  }
  for (const target of scaled) {
    const check = await engine.exec(target.alias, 'printf "%s" "$HOME"')
    if (!check.success || check.stdout !== target.home) {
      for (const target of scaled) target.server.stop()
      secondary?.stop(); sshd.stop(); throw new Error('Scaled fixture SSH HOME isolation failed')
    }
  }
  if (process.env.DSH_LEGACY_TERMINAL_SMOKE === '1') {
    legacy = await new SshWorkspaces(engine, join(env.DSH_HOME, 'ssh-workspaces')).create('isolated-remote', remote)
  }
} finally { engine.dispose() }
const logPath = join(root, 'local-server.log'), log = createWriteStream(logPath, { mode: 0o600 })
const child = spawn(dsh, ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.pipe(log); child.stderr.pipe(log)
writeFileSync(join(root, 'fixture.json'), JSON.stringify({ root, local, remote, pid: child.pid, scaled: scaled.map(target => ({ alias: target.alias, home: target.home, port: target.server.port })) }), { mode: 0o600 })
const cleanup = async () => {
  child.kill('SIGTERM'); sshd.stop(); secondary?.stop(); paced?.close()
  for (const target of scaled) target.server.stop()
  clearInterval(gateTimer)
  if (connectionGate) {
    await connectionGate.close()
    writeFileSync(join(root, 'connection-proof.json'), JSON.stringify({ port: connectionGate.port, active: connectionGate.activeConnections,
      accepted: connectionGate.acceptedConnections }), { mode: 0o600 })
  }
  if (interactive) {
    writeFileSync(join(root, 'auth-proof.json'), JSON.stringify({ port: interactive.port, challenges: interactive.challenges, shells: interactive.shells, inputs: interactive.inputs, activeConnections: interactive.clients.size }), { mode: 0o600 })
    await interactive.stop()
  }
  try {
    const record = JSON.parse(readFileSync(join(remote, '.local/share/dsh-remote/state/server.json'), 'utf8'))
    if (record.root === join(remote, '.local/share/dsh-remote')) process.kill(record.pid, 'SIGTERM')
  } catch {}
  process.exit()
}
process.on('SIGINT', cleanup); process.on('SIGTERM', cleanup)
let login = ''
for (let i = 0; i < 450; i++) {
  if (child.exitCode !== null) throw new Error(`Isolated DSH exited; inspect ${root}`)
  try { login = readFileSync(logPath, 'utf8').match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0] ?? '' } catch {}
  if (login) break
  await new Promise(resolve => setTimeout(resolve, 200))
}
if (!login) throw new Error(`Isolated DSH did not start; inspect ${root}`)
let entryCookie: string | undefined
if (legacy) {
  const loginResponse = await fetch(login, { redirect: 'manual' })
  if (loginResponse.status !== 303) throw new Error('Isolated DSH login failed')
  entryCookie = loginResponse.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const origin = new URL(login).origin
  const rpc = async (method: string, args: object) => {
    const response = await fetch(origin + '/api/' + method, {
      method: 'POST', headers: { Cookie: entryCookie!, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
    })
    const body = await response.json() as { result?: { ok: boolean; value?: Record<string, unknown>; error?: { message?: string } } }
    if (!response.ok || !body.result?.ok) throw new Error(`Isolated ${method} failed: ${body.result?.error?.message ?? response.status}`)
    return body.result.value!
  }
  const created = await rpc('workspace/create', { request: { path: legacy.localPath } })
  const workspaceId = (created.workspace as { workspaceId: string }).workspaceId
  await rpc('session/create', { request: { workspaceId } })
  const listResponse = await fetch(origin + '/api/dsh-ssh/workspaces', { headers: { Cookie: entryCookie, Origin: origin } })
  const listed = await listResponse.json() as { workspaces?: Array<{ localPath: string }> }
  if (!listResponse.ok || !listed.workspaces?.some(item => item.localPath === legacy.localPath)) throw new Error('Legacy SSH binding not visible to browser')
}
const entry = createServer((req, res) => {
  if (req.url !== '/') { res.writeHead(404); res.end(); return }
  res.writeHead(303, { Location: entryCookie ? new URL(login).origin : login,
    ...(entryCookie ? { 'Set-Cookie': entryCookie } : {}),
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end(); entry.close()
})
await new Promise<void>(resolve => entry.listen(0, '127.0.0.1', resolve))
const address = entry.address()
console.log(JSON.stringify({ root, entry: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : ''}/`, legacy: Boolean(legacy) }))
