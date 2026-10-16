import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { HostStore } from '../src/store.ts'
import { SshEngine } from '../src/engine.ts'
import { makeRoutes } from '../src/routes.ts'
import type { TerminalServerFrame } from '../src/protocol.ts'
import { InteractiveSsh } from './helpers/interactive-ssh.ts'
import { TestSshServer, TEST_USER, TEST_PASSWORD } from './helpers/ssh-server.ts'

async function wait(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(check()).toBe(true)
}
async function fixture(holdShell = false) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-terminal-identity-')), ssh = await InteractiveSsh.start(holdShell)
  const store = new HostStore(join(root, 'hosts.json')), engine = new SshEngine(store)
  const entry = store.create({ alias: 'interactive', host: '127.0.0.1', port: ssh.port, user: 'fixture', auth: { kind: 'password' } })
  const { upgrade } = makeRoutes({ store, engine, stagingDir: root, requestRejection: () => undefined })
  const server = createServer(); server.on('upgrade', (req, socket, head) => upgrade.handler(req, socket, head))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `ws://127.0.0.1:${(server.address() as { port: number }).port}`
  const sockets: WebSocket[] = []
  const open = (version = entry.updatedAt) => {
    const ws = new WebSocket(origin + '/api/dsh-ssh/terminal?' + new URLSearchParams({ alias: entry.alias, expectedUpdatedAt: String(version) }))
    const frames: TerminalServerFrame[] = []; sockets.push(ws)
    ws.on('message', bytes => frames.push(JSON.parse(bytes.toString()))); ws.on('error', () => {})
    return { ws, frames }
  }
  return { ssh, store, engine, entry, open, async close() {
    for (const ws of sockets) ws.terminate()
    await wait(() => engine.connectionStatus().every(row => row.state !== 'connecting' && row.state !== 'connected'))
    engine.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); await ssh.stop(); rmSync(root, { recursive: true, force: true })
  } }
}

it('reports the captured identity across two auth rounds and host edits, then opens only one shell', async () => {
  const f = await fixture(), { ws, frames } = f.open(), version = f.entry.updatedAt
  try {
    await wait(() => frames.some(frame => frame.type === 'auth_prompt'))
    const target = { alias: 'interactive', user: 'fixture', host: '127.0.0.1', port: f.ssh.port, updatedAt: version }
    expect(frames[0]).toEqual({ type: 'target', target })
    f.store.update('interactive', { port: 1, auth: { kind: 'password', password: 'must-never-be-used' } })
    ws.send(JSON.stringify({ type: 'auth_response', responses: [f.ssh.answers[0]] }))
    await wait(() => frames.filter(frame => frame.type === 'auth_prompt').length === 2)
    ws.send(JSON.stringify({ type: 'auth_response', responses: [f.ssh.answers[1]] }))
    await wait(() => frames.some(frame => frame.type === 'ready'))
    expect(frames.filter(frame => frame.type === 'auth_prompt').every(frame => frame.target?.port === f.ssh.port)).toBe(true)
    expect(frames.find(frame => frame.type === 'ready')).toMatchObject({ target })
    expect(JSON.stringify(frames)).not.toContain('must-never-be-used'); expect(JSON.stringify(frames)).not.toContain(f.ssh.answers[0])
    ws.send(JSON.stringify({ type: 'input', data: 'one explicit input\r' }))
    await wait(() => frames.some(frame => frame.type === 'output'))
    expect(f.ssh.shells).toBe(1); expect(f.ssh.inputs.join('')).toBe('one explicit input\r')
  } finally { await f.close() }
})

it('closing during an unanswered challenge cancels its connection immediately and opens no shell', async () => {
  const f = await fixture(), { ws, frames } = f.open()
  try {
    await wait(() => frames.some(frame => frame.type === 'auth_prompt')); ws.close()
    await wait(() => f.ssh.clients.size === 0 && f.engine.connectionStatus().every(row => row.state !== 'connecting'))
    expect(f.ssh.shells).toBe(0); expect(f.ssh.challenges).toBe(1)
  } finally { await f.close() }
})

it('allows human input beyond the network timeout in each authentication round', async () => {
  const f = await fixture(); f.engine.opts.connectTimeoutMs = 250
  try {
    const start = Date.now()
    const shell = await f.engine.openShell('interactive', { cols: 80, rows: 24 }, (_name, _instruction, _lang, _prompts, finish) => {
      const answer = f.ssh.answers[f.ssh.challenges - 1]!
      setTimeout(() => finish([answer]), 350)
    })
    expect(Date.now() - start).toBeGreaterThanOrEqual(650)
    expect(f.ssh.challenges).toBe(2); expect(f.ssh.shells).toBe(1); shell.close()
  } finally { await f.close() }
})

it('refuses a stale reviewed terminal before connecting', async () => {
  const f = await fixture(), version = f.entry.updatedAt
  try {
    f.store.update('interactive', { description: 'changed' })
    const { frames } = f.open(version)
    await wait(() => frames.some(frame => frame.type === 'exit'))
    expect(frames).toEqual([{ type: 'exit', code: null, error: expect.stringContaining('no terminal was opened') }])
    expect(f.ssh.challenges).toBe(0); expect(f.ssh.clients.size).toBe(0)
  } finally { await f.close() }
})

it('cancels a pending shell ACK after authentication and ignores the abandoned request', async () => {
  const f = await fixture(true), controller = new AbortController()
  try {
    const pending = f.engine.openShell('interactive', { cols: 80, rows: 24 }, (_name, _instruction, _lang, _prompts, finish) => finish([f.ssh.answers[f.ssh.challenges - 1]!]), controller.signal)
    await wait(() => f.ssh.shellRequests === 1); controller.abort()
    await expect(pending).rejects.toThrow(); await wait(() => f.ssh.clients.size === 0)
    expect(f.ssh.shells).toBe(0)
  } finally { await f.close() }
})

it('cancels before a silent TCP endpoint sends any SSH handshake', async () => {
  const peers = new Set<import('node:net').Socket>()
  const server = createTcpServer(socket => { peers.add(socket); socket.on('data', () => {}); socket.once('close', () => peers.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const root = mkdtempSync(join(tmpdir(), 'dsh-terminal-pending-')), store = new HostStore(join(root, 'hosts.json')), engine = new SshEngine(store)
  store.create({ alias: 'silent', host: '127.0.0.1', port: (server.address() as { port: number }).port, user: 'fixture', auth: { kind: 'password' } })
  const controller = new AbortController()
  try {
    const pending = engine.openShell('silent', { cols: 80, rows: 24 }, undefined, controller.signal)
    await wait(() => peers.size === 1); controller.abort()
    await expect(pending).rejects.toThrow(); await wait(() => peers.size === 0)
    expect(engine.connectionStatus()[0]?.state).not.toBe('connecting')
  } finally { engine.dispose(); for (const peer of peers) peer.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }) }
})

it('identifies the jump host that asks for input and uses the target password only at the target', async () => {
  const f = await fixture(), target = await TestSshServer.start()
  try {
    f.store.create({ alias: 'target', host: '127.0.0.1', port: target.port, user: TEST_USER, auth: { kind: 'password', password: TEST_PASSWORD }, proxyJump: ['interactive'] })
    const owners: string[] = []
    const shell = await f.engine.openShell('target', { cols: 80, rows: 24 }, (_name, _instruction, _lang, _prompts, finish, owner) => {
      owners.push(owner!.alias); finish([f.ssh.answers[f.ssh.challenges - 1]!])
    })
    expect(owners).toEqual(['interactive', 'interactive']); expect(shell.target).toMatchObject({ alias: 'target', port: target.port, user: TEST_USER })
    shell.close(); await wait(() => f.ssh.clients.size === 0)
  } finally { target.killAllClients(); await target.stop(); await f.close() }
})
