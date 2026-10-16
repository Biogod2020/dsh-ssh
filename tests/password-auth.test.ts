import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server, type Connection } from 'ssh2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HostStore } from '../src/store.ts'
import { SshEngine } from '../src/engine.ts'
import { buildConnectConfig, connectClient, DEFAULTS, isAccountPasswordPrompt } from '../src/engine/connection-pool.ts'
import type { SshHostEntry } from '../src/protocol.ts'
import { TestSshServer, TEST_PASSWORD, TEST_USER } from './helpers/ssh-server.ts'

let directory: string, server: TestSshServer, wrongKey: string
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ssh-fallback-auth-'))
  wrongKey = join(directory, 'wrong-key')
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', wrongKey, '-N', '', '-q'], { stdio: 'ignore' })
  server = await TestSshServer.start()
})
afterAll(async () => { server?.killAllClients(); await server?.stop(); rmSync(directory, { recursive: true, force: true }) })
const entry = (auth: SshHostEntry['auth']): SshHostEntry => ({ alias: 'fixture', host: '127.0.0.1', port: server.port, user: TEST_USER,
  auth, tags: [], proxyJump: [], createdAt: 1, updatedAt: 1 })

describe('fallback handshake', () => {
  it('tries a key first, then a configured password on the same connection and dispatches the operation once', async () => {
    const store = new HostStore(join(directory, 'hosts.json'))
    store.create(entry({ kind: 'key', keyPath: wrongKey, password: TEST_PASSWORD, rememberPassword: false }))
    const engine = new SshEngine(store), before = server.commandCount, connections = server.connectCount, authBefore = server.authMethods.length
    try {
      const result = await engine.exec('fixture', 'echo ok')
      expect(result.stdout).toBe('ok\n')
      expect(server.commandCount - before).toBe(1)
      expect(server.connectCount - connections).toBe(1)
      expect(server.authMethods.slice(authBefore)).toEqual(['none', 'publickey', 'password'])
    } finally { engine.dispose() }
  })

  it('accepts the configured key even when the fallback is wrong', async () => {
    const before = server.authMethods.length
    const client = await connectClient(buildConnectConfig(entry({ kind: 'key', keyPath: server.keyPair.privateKey, password: 'wrong' }), undefined, DEFAULTS))
    client.end()
    expect(server.authMethods.slice(before)).not.toContain('password')
  })

  it.each(['missing', 'encrypted', 'public-only'] as const)('falls back when the primary key is %s', async kind => {
    let keyPath = join(directory, 'not-present')
    if (kind === 'public-only') keyPath = server.keyPair.publicKey
    if (kind === 'encrypted') {
      keyPath = join(directory, 'encrypted')
      execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', 'fixture-passphrase', '-q'], { stdio: 'ignore' })
    }
    const client = await connectClient(buildConnectConfig(entry({ kind: 'key', keyPath, password: TEST_PASSWORD }), undefined, DEFAULTS))
    client.end()
  })

  it('falls back after an unavailable agent, without dropping the handshake', async () => {
    const client = await connectClient(buildConnectConfig(entry({ kind: 'agent', agentPath: join(directory, 'missing-agent'), password: TEST_PASSWORD }), undefined, DEFAULTS))
    client.end()
  })

  it('keeps unknown host keys closed before password authentication', async () => {
    const before = server.authMethods.length
    const trust = join(directory, 'empty-known-hosts'); writeFileSync(trust, '')
    const config = buildConnectConfig(entry({ kind: 'key', keyPath: wrongKey, password: TEST_PASSWORD }), undefined, { ...DEFAULTS, knownHostsPaths: [trust] })
    await expect(connectClient(config)).rejects.toThrow(/known_hosts|host key/i)
    expect(server.authMethods.slice(before)).toEqual([])
  })

  it('does not replay an operation when the connection drops after a side effect', async () => {
    const store = new HostStore(join(directory, 'no-replay.json'))
    store.create(entry({ kind: 'key', keyPath: wrongKey, password: TEST_PASSWORD, rememberPassword: false }))
    const engine = new SshEngine(store), before = server.commandCount
    try {
      await engine.exec('fixture', 'side-effect-then-disconnect').catch(() => undefined)
      expect(server.commandCount - before).toBe(1)
    } finally { engine.dispose() }
  })

  it('reports attempted methods and never includes the rejected password', async () => {
    const config = buildConnectConfig(entry({ kind: 'key', keyPath: wrongKey, password: 'never-log-this-secret' }), undefined, DEFAULTS)
    await expect(connectClient(config)).rejects.toThrow(/Tried: publickey, password, keyboard-interactive/)
    try { await connectClient(config) } catch (error) { expect(String(error)).not.toContain('never-log-this-secret') }
  })
})

describe('keyboard-interactive account passwords', () => {
  it.each(['Password:', '密码：', 'Account password:'])('recognizes %s', prompt => expect(isAccountPasswordPrompt(prompt)).toBe(true))
  it.each(['One-time password:', 'OTP password:', 'Verification password:', '验证码', 'Password code:'])('does not autofill %s', prompt => expect(isAccountPasswordPrompt(prompt)).toBe(false))

  it('handles an empty PAM notice, fills the account password once, and leaves OTP input to the user', async () => {
    const clients: Connection[] = [], responses: string[][] = []
    const interactive = new Server({ hostKeys: [readFileSync(server.keyPair.privateKey)] }, client => {
      clients.push(client); client.on('error', () => {})
      client.on('authentication', ctx => {
        if (ctx.method !== 'keyboard-interactive') { ctx.reject(['keyboard-interactive']); return }
        ctx.prompt([], 'Notice', 'Welcome', zero => {
          responses.push(zero)
          ctx.prompt([{ prompt: 'Password:', echo: false }], account => {
            responses.push(account)
            ctx.prompt([{ prompt: 'One-time password:', echo: false }], otp => {
              responses.push(otp)
              if (account[0] === TEST_PASSWORD && otp[0] === '123456') ctx.accept()
              else ctx.reject()
            })
          })
        })
      })
    })
    await new Promise<void>(resolve => interactive.listen(0, '127.0.0.1', resolve))
    const port = (interactive.address() as { port: number }).port
    const trust = join(directory, 'interactive-known-hosts')
    const publicKey = readFileSync(server.keyPair.publicKey, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ')
    writeFileSync(trust, `[127.0.0.1]:${port} ${publicKey}\n`)
    const config = buildConnectConfig({ ...entry({ kind: 'password', password: TEST_PASSWORD }), port }, undefined, { ...DEFAULTS, knownHostsPaths: [trust] })
    const prompts: string[] = []
    try {
      const client = await connectClient(config, (_name, _instructions, _lang, challenges, finish) => {
        prompts.push(...challenges.map(item => item.prompt)); finish(['123456'])
      })
      client.end()
      expect(responses).toEqual([[], [TEST_PASSWORD], ['123456']])
      expect(prompts).toEqual(['One-time password:'])
    } finally {
      for (const client of clients) client.end()
      await new Promise<void>(resolve => interactive.close(() => resolve()))
    }
  })
})
