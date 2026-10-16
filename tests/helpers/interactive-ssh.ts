/** Real encrypted SSH keyboard-interactive fixture; its shell echoes input. */
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import ssh2, { type Server as SshServer, type Connection } from 'ssh2'
import { DEFAULT_KNOWN_HOSTS } from '../../src/engine/known-hosts.ts'

export class InteractiveSsh {
  readonly answers = ['fixture-session-only', '246810']
  readonly clients = new Set<Connection>()
  challenges = 0
  shells = 0
  shellRequests = 0
  inputs: string[] = []
  private constructor(readonly port: number, private server: SshServer, private root: string) {}
  static async start(holdShell = false): Promise<InteractiveSsh> {
    const root = mkdtempSync(join(tmpdir(), 'dsh-interactive-ssh-')); chmodSync(root, 0o700)
    const key = join(root, 'host.key')
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-f', key, '-N', ''], { stdio: 'ignore' })
    let fixture: InteractiveSsh
    const server = new ssh2.Server({ hostKeys: [readFileSync(key)] }, client => {
      fixture.clients.add(client)
      client.on('error', () => {})
      client.once('close', () => fixture.clients.delete(client))
      client.on('authentication', ctx => {
        if (ctx.method !== 'keyboard-interactive' || ctx.username !== 'fixture') { ctx.reject(['keyboard-interactive']); return }
        fixture.challenges++
        ctx.prompt([{ prompt: 'Fixture password:', echo: false }], 'Fixture SSH verification', 'Session-only password for this isolated SSH endpoint.', first => {
          if (first[0] !== fixture.answers[0]) { ctx.reject(); return }
          fixture.challenges++
          ctx.prompt([{ prompt: 'Verification code:', echo: false }], 'Fixture second factor', 'Enter the acceptance code for this isolated endpoint.', second => {
            if (second[0] === fixture.answers[1]) ctx.accept(); else ctx.reject()
          })
        })
      })
      client.on('ready', () => client.on('session', accept => {
        const session = accept(); session.on('pty', acceptPty => acceptPty()); session.on('window-change', () => {})
        session.on('shell', acceptShell => {
          fixture.shellRequests++
          if (holdShell) return // Test cancellation before the channel ACK.
          fixture.shells++
          const stream = acceptShell(); if (!stream) return
          stream.on('data', (chunk: Buffer) => { fixture.inputs.push(chunk.toString()); stream.write(chunk) })
          stream.on('close', () => { try { stream.close() } catch {} })
        })
      }))
      client.on('tcpip', (accept, _reject, info) => {
        const stream = accept(), socket = connect(info.destPort, info.destIP)
        stream.pipe(socket).pipe(stream); socket.on('error', () => stream.close())
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    fixture = new InteractiveSsh((server.address() as { port: number }).port, server, root)
    const pub = readFileSync(key + '.pub', 'utf8').trim().split(/\s+/).slice(0, 2).join(' ')
    appendFileSync(DEFAULT_KNOWN_HOSTS[0]!, `[127.0.0.1]:${fixture.port} ${pub}\n`, { mode: 0o600 })
    return fixture
  }
  async stop(): Promise<void> {
    for (const client of this.clients) client.end()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
    rmSync(this.root, { recursive: true, force: true })
  }
}
