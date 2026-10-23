/**
 * Standalone real-sshd harness: spawns /usr/sbin/sshd as the current user
 * with a sandboxed config, host key, and a generated client keypair (key
 * auth only). Gives the SFTP tests a production-grade server.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DEFAULT_KNOWN_HOSTS } from '../../src/engine/known-hosts.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, createServer } from 'node:net'
import { Client } from 'ssh2'

/** Every spawned sshd (orphan cleanup if the test process dies early). */
const spawned: ChildProcess[] = []

async function availablePort(): Promise<number> {
  const reservation = createServer()
  await new Promise<void>((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',resolve)})
  const port = (reservation.address() as {port:number}).port
  await new Promise<void>((resolve,reject)=>reservation.close(error=>error?reject(error):resolve()))
  return port
}
async function confirmOwnSshd(port:number, publicKey:Buffer, privateKey:Buffer):Promise<void>{
  await new Promise<void>((resolve,reject)=>{
    const client=new Client();let settled=false
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);client.end();if(error)reject(error);else resolve()}
    const timer=setTimeout(()=>finish(new Error('Generated sshd identity was not confirmed')),5000)
    client.once('error',()=>finish(new Error('Generated sshd identity or authentication did not match')))
    client.once('close',()=>finish(new Error('Generated sshd closed before readiness confirmation')))
    client.once('ready',()=>finish())
    client.connect({host:'127.0.0.1',port,username:process.env.USER,privateKey,readyTimeout:5000,hostVerifier:(key:Buffer)=>key.equals(publicKey)})
  })
}

/** Wait until the port accepts TCP connections (aborts on a spawn error). */
async function waitPort(port: number, timeoutMs: number, spawnError?: () => Error | undefined): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const error = spawnError?.()
    if (error !== undefined) throw error
    const ok = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => { socket.destroy(); resolve(false) })
    })
    if (ok) return
    if (Date.now() > deadline) throw new Error('sshd did not start listening in time')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** The real-sshd harness. */
export class TestSshd {
  readonly port: number
  /** Absolute path of the client private key. */
  readonly clientKey: string
  /** The sandbox dir (also the writable remote filesystem area). */
  readonly root: string
  private readonly process: ChildProcess
  private readonly dir: string

  private constructor(port: number, clientKey: string, root: string, process: ChildProcess, dir: string) {
    this.port = port
    this.clientKey = clientKey
    this.root = root
    this.process = process
    this.dir = dir
  }

  /** Start sshd on a random high port. */
  static async start(options: { home?: string; path?: string; env?:NodeJS.ProcessEnv; port?:number } = {}): Promise<TestSshd> {
    if(options.port!==undefined&&(!Number.isInteger(options.port)||options.port<1||options.port>65535))throw new Error('Invalid fixture port')
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-sshd-'))
    const root = join(dir, 'remote')
    mkdirSync(join(dir, 'etc'), { recursive: true })
    mkdirSync(join(dir, 'home', '.ssh'), { recursive: true })
    mkdirSync(root, { recursive: true })
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', join(dir, 'etc', 'host_key'), '-N', '', '-q'], { stdio: 'ignore' })
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', join(dir, 'client'), '-N', '', '-q'], { stdio: 'ignore' })
    const authorized = join(dir, 'home', '.ssh', 'authorized_keys')
    writeFileSync(authorized, readFileSync(join(dir, 'client.pub'), 'utf8'), 'utf8')
    chmodSync(authorized, 0o600)

    const port = options.port ?? await availablePort()
    const config = [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${join(dir, 'etc', 'host_key')}`,
      `PidFile ${join(dir, 'sshd.pid')}`,
      `AuthorizedKeysFile ${authorized}`,
      'PasswordAuthentication no',
      'PubkeyAuthentication yes',
      'UsePAM no',
      'UsePrivilegeSeparation no',
      'StrictModes no',
      `AllowUsers ${process.env.USER}`,
      'Subsystem sftp internal-sftp',
      'LogLevel ERROR',
      ...Object.entries({ HOME: options.home, PATH: options.path }).flatMap(([key, value]) => {
        if (!value) return []
        if (/[\r\n\x00]/.test(value)) throw new Error('Invalid fixture environment')
        return [`SetEnv ${key}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`]
      }),
    ].join('\n')
    writeFileSync(join(dir, 'sshd_config'), config + '\n', 'utf8')
    const log = join(dir, 'sshd.log')
    // Give sshd its own descriptor. Ending a piped WriteStream after readiness
    // races with later sshd diagnostics and can throw write-after-end in tests.
    const logFd = openSync(log, 'wx', 0o600)
    let child: ChildProcess
    try {
      child = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(dir, 'sshd_config')], {
        env:options.env,
        stdio: ['ignore', 'ignore', logFd],
      })
    } finally { closeSync(logFd) }
    spawned.push(child)
    let spawnError: Error | undefined
    child.once('error', (error) => { spawnError = error })
    try {
      await waitPort(port, 8_000, () => spawnError !== undefined
        ? new Error(`failed to spawn /usr/sbin/sshd: ${spawnError.message}`)
        : child.exitCode!==null||child.signalCode!==null ? new Error('Generated sshd exited before readiness confirmation') : undefined)
      const publicKey=Buffer.from(readFileSync(join(dir,'etc','host_key.pub'),'utf8').trim().split(/\s+/)[1]!,'base64')
      await confirmOwnSshd(port,publicKey,readFileSync(join(dir,'client')))
      if(child.exitCode!==null||child.signalCode!==null)throw new Error('Generated sshd exited before pinning its key')
    } catch (error) {
      child.kill()
      let detail = ''
      try {
        detail = readFileSync(log, 'utf8').slice(0, 2000)
      } catch { /* no log */ }
      rmSync(dir, { recursive: true, force: true })
      throw new Error(`sshd failed to start: ${String(error)} ${detail}`)
    }
    appendFileSync(DEFAULT_KNOWN_HOSTS[0], `[127.0.0.1]:${port} ${readFileSync(join(dir, 'etc', 'host_key.pub'), 'utf8')}\n`, { mode: 0o600 })
    return new TestSshd(port, join(dir, 'client'), root, child, dir)
  }

  /** Stop sshd and clean up (kill is synchronous; dir removal follows exit). */
  stop(): void {
    try { this.process.kill() } catch { /* gone */ }
    void (async () => {
      if (this.process.exitCode === null) {
        await new Promise<void>((resolve) => {
          this.process.once('exit', () => resolve())
          setTimeout(resolve, 2_000)
        })
      }
      rmSync(this.dir, { recursive: true, force: true })
    })()
  }
}

// Best-effort orphan cleanup if the test process dies without stop().
process.on('exit', () => {
  for (const child of spawned) {
    try { child.kill() } catch { /* gone */ }
  }
})
