import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostStore } from '../src/store.ts'
import { SshEngine, type ShellSession, type KeyboardInteractiveHandler } from '../src/engine.ts'
import { TerminalSessions, type TerminalView } from '../src/terminal-sessions.ts'
import { makeRoutes } from '../src/routes.ts'
import type { TerminalServerFrame } from '../src/protocol.ts'
import { TestSshd } from './helpers/sshd.ts'
import { InteractiveSsh } from './helpers/interactive-ssh.ts'
import { TerminalScreen } from '../src/terminal-screen.ts'
import { TERMINAL_CONTINUITY_BYTES } from '../src/terminal-continuity.ts'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.useRealTimers() })
const owner = 'owner-fixture-12345678', id = 'session-fixture-12345678'
function view() {
  const frames: TerminalServerFrame[] = []
  return { frames, send: (frame: TerminalServerFrame) => frames.push(frame), close: vi.fn() } satisfies TerminalView & { frames: TerminalServerFrame[] }
}
async function fixture(limits?: { outputBytes: number; detachedMs: number; maxSessions: number }) {
  const root = mkdtempSync(join(tmpdir(), 'terminal-resume-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const store = new HostStore(join(root, 'hosts.json')), host = store.create({ alias: 'fixture', host: '127.0.0.1', port: 22, user: 'fixture', auth: { kind: 'password', password: 'private-fixture-password' } })
  const shell: ShellSession = { send: vi.fn(), close: vi.fn(), resize: vi.fn(), pause: vi.fn(), resume: vi.fn() }
  const openShell = vi.fn(async () => shell), service = new TerminalSessions({ openShell } as unknown as SshEngine, store, limits)
  cleanup.push(() => service.dispose())
  const first = view()
  service.create(owner, id, host.alias, 80, 24, first, '/fixture cwd', host.updatedAt)
  await Promise.resolve()
  return { service, first, shell, openShell, store, host }
}

it('reattaches the same shell, frozen target and output; cwd/input is dispatched only once', async () => {
  const f = await fixture()
  f.service.message(owner, id, f.first, { type: 'input', data: 'one command\r' })
  f.shell.onData?.(Buffer.from('before refresh\r\n'))
  f.service.detach(owner, id, f.first)
  expect(f.shell.close).not.toHaveBeenCalled()
  f.shell.onData?.(Buffer.from('while detached\r\n'))
  f.store.update('fixture', { port: 2222, user: 'changed-user' })
  const second = view(); await f.service.attach(owner, id, second)
  expect(second.frames[0]).toMatchObject({ type: 'snapshot', format: 'state-v1', session: { target: { user: 'fixture', port: 22 }, phase: 'connected' }, output: expect.stringContaining('before refresh\r\nwhile detached') })
  expect(second.frames.filter(frame => frame.type === 'output')).toEqual([])
  const state = second.frames[0]; if (state.type !== 'snapshot') throw new Error('Missing snapshot')
  expect(state.continuity?.version).toBe(1)
  expect(Buffer.byteLength(JSON.stringify(state.continuity))).toBeLessThanOrEqual(TERMINAL_CONTINUITY_BYTES)
  expect(f.openShell).toHaveBeenCalledOnce()
  expect(f.shell.send).toHaveBeenCalledTimes(2)
  expect(f.shell.send).toHaveBeenNthCalledWith(1, "cd -- '/fixture cwd' || exit\r")
  expect(f.shell.send).toHaveBeenNthCalledWith(2, 'one command\r')
  expect(JSON.stringify(f.service.list(owner))).not.toContain('private-fixture-password')
})
it('keeps the original PTY and command count when display restoration fails, then attaches it again', async () => {
  const f = await fixture()
  f.service.message(owner, id, f.first, { type: 'input', data: 'once\r' })
  f.service.detach(owner, id, f.first)
  const spy = vi.spyOn(TerminalScreen.prototype, 'snapshot').mockRejectedValueOnce(new Error('Incompatible renderer'))
  const failed = view(); await expect(f.service.attach(owner, id, failed)).rejects.toThrow('Incompatible')
  f.service.detach(owner, id, failed); spy.mockRestore()
  expect(f.shell.close).not.toHaveBeenCalled()
  expect(f.service.list(owner)[0]?.phase).toBe('connected')
  const restored = view(); await f.service.attach(owner, id, restored)
  expect(restored.frames.at(-1)?.type).toBe('ready')
  expect(f.openShell).toHaveBeenCalledOnce(); expect(f.shell.send).toHaveBeenCalledTimes(2)
})
it('superseded views cannot send input, resize, auth or stop', async () => {
  const f = await fixture(), second = view()
  await f.service.attach(owner, id, second)
  expect(f.first.frames.at(-1)).toEqual({ type: 'detached', reason: 'replaced' })
  for (const frame of [{ type: 'input', data: 'stale' }, { type: 'resize', cols: 99, rows: 40 }, { type: 'stop' }] as const) f.service.message(owner, id, f.first, frame)
  f.service.detach(owner, id, f.first)
  expect(f.shell.send).toHaveBeenCalledOnce(); expect(f.shell.resize).not.toHaveBeenCalled(); expect(f.shell.close).not.toHaveBeenCalled()
  f.service.message(owner, id, second, { type: 'input', data: 'current' })
  expect(f.shell.send).toHaveBeenLastCalledWith('current')
})
it('unknown owner or expired ID never opens SSH, and duplicate creation never dispatches again', async () => {
  const f = await fixture()
  expect(() => f.service.attach('another-owner-123456', id, view())).toThrow('unavailable')
  expect(f.service.list('another-owner-123456')).toEqual([])
  expect(() => f.service.attach(owner, 'missing-session-12345', view())).toThrow('unavailable')
  expect(() => f.service.create(owner, id, 'fixture', 80, 24, view())).toThrow('not replayed')
  expect(f.openShell).toHaveBeenCalledOnce()
})
it('keeps complete UTF-8 cells in a bounded state snapshot and ignores output after exit', async () => {
  const f = await fixture({ outputBytes: 2048, detachedMs: 1000, maxSessions: 32 })
  const bytes = Buffer.from('中文🙂')
  f.shell.onData?.(bytes.subarray(0, 2)); f.shell.onData?.(bytes.subarray(2))
  f.shell.onData?.(Buffer.from('\r\n' + Array.from({ length: 300 }, (_, index) => `ROW${index} 中文🙂\r\n`).join('') + '尾部'))
  f.service.detach(owner, id, f.first)
  const second = view(); await f.service.attach(owner, id, second)
  const snapshot = second.frames[0]
  expect(snapshot.type).toBe('snapshot')
  if (snapshot.type !== 'snapshot') throw new Error('Missing snapshot')
  expect(Buffer.byteLength(snapshot.output)).toBeLessThanOrEqual(2048)
  expect(snapshot.output).toContain('ROW299 中文🙂'); expect(snapshot.output).toContain('尾部'); expect(snapshot.output).not.toContain('�'); expect(snapshot.session.truncated).toBe(true)
  f.shell.onExit?.(0)
  f.shell.onData?.(Buffer.from('late'))
  await wait(() => second.frames.at(-1)?.type === 'exit')
  expect(second.frames.at(-1)).toMatchObject({ type: 'exit', code: 0, error: undefined })
  const final = view(); await f.service.attach(owner, id, final)
  expect(final.frames[0]).toMatchObject({ output: snapshot.output, session: { phase: 'exited' } })
  expect(JSON.stringify(final.frames)).not.toContain('late')
  expect(f.openShell).toHaveBeenCalledOnce()
})
it('expires only detached shells and disposes each retained resource', async () => {
  vi.useFakeTimers()
  const f = await fixture({ outputBytes: 1024, detachedMs: 100, maxSessions: 32 })
  await vi.advanceTimersByTimeAsync(101); expect(f.shell.close).not.toHaveBeenCalled()
  f.service.detach(owner, id, f.first)
  await vi.advanceTimersByTimeAsync(50)
  const second = view(); await f.service.attach(owner, id, second)
  await vi.advanceTimersByTimeAsync(100); expect(f.shell.close).not.toHaveBeenCalled()
  f.service.detach(owner, id, second); await vi.advanceTimersByTimeAsync(101)
  expect(f.shell.close).toHaveBeenCalledOnce(); expect(f.service.list(owner)[0]!.error).toContain('expired')
  await vi.advanceTimersByTimeAsync(100); expect(f.service.list(owner)).toEqual([])
})
it('removes only the named shell, enforces the cap and disables without reconnecting', async () => {
  const f = await fixture({ outputBytes: 1024, detachedMs: 1000, maxSessions: 2 })
  const other = view(), otherId = 'other-session-1234567'
  f.service.create(owner, otherId, 'fixture', 80, 24, other); await Promise.resolve()
  expect(() => f.service.create(owner, 'third-session-123456', 'fixture', 80, 24, view())).toThrow('limit')
  f.service.remove(owner, id)
  expect(f.service.list(owner)).toHaveLength(1)
  f.service.setEnabled(false); expect(f.service.list(owner)[0]!.phase).toBe('error')
  f.service.setEnabled(true); await f.service.attach(owner, otherId, view())
  expect(f.openShell).toHaveBeenCalledTimes(2)
})
it('rejects stale targets and invalid sizes before dispatch', async () => {
  const f = await fixture()
  f.store.update('fixture', { description: 'edit' })
  expect(() => f.service.create(owner, 'new-session-12345678', 'fixture', 80, 24, view(), undefined, f.host.updatedAt - 1)).toThrow('no terminal')
  for (const cols of [NaN, 0, 1001, 1.5]) expect(() => f.service.create(owner, 'new-session-12345678', 'fixture', cols, 24, view())).toThrow('Invalid')
  f.service.message(owner, id, f.first, { type: 'input', data: 'x'.repeat(65537) })
  f.service.message(owner, id, f.first, { type: 'resize', cols: NaN, rows: 24 })
  expect(f.shell.send).toHaveBeenCalledOnce(); expect(f.shell.resize).not.toHaveBeenCalled(); expect(f.openShell).toHaveBeenCalledOnce()
})

async function wait(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(check()).toBe(true)
}
async function realFixture(interactive = false) {
  const root = mkdtempSync(join(tmpdir(), 'terminal-resume-real-')), home = join(root, 'remote'); mkdirSync(home)
  const ssh = interactive ? await InteractiveSsh.start() : await TestSshd.start({ home, path: '/usr/bin:/bin:/usr/sbin:/sbin' })
  const store = new HostStore(join(root, 'hosts.json')), engine = new SshEngine(store)
  const host = store.create({ alias: 'real', host: '127.0.0.1', port: ssh.port, user: interactive ? 'fixture' : process.env.USER!, auth: ssh instanceof TestSshd ? { kind: 'key', keyPath: ssh.clientKey } : { kind: 'password' } })
  const { routes, upgrade, terminals } = makeRoutes({ store, engine, stagingDir: root, requestRejection: () => undefined })
  const server = createServer((req, res) => { const route = routes.find(route => route.path === new URL(req.url!, 'http://localhost').pathname); if (route) void route.handler(req, res); else { res.writeHead(404); res.end() } })
  server.on('upgrade', (req, socket, head) => upgrade.handler(req, socket, head))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, key = randomUUID(), sockets: WebSocket[] = []
  const open = (attach = false, sid = key) => {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/api/dsh-ssh/terminal?' + new URLSearchParams({ persistent: '1', owner, session: sid, alias: 'real', cols: '80', rows: '24', expectedUpdatedAt: String(host.updatedAt), ...(attach ? { attach: '1' } : {}) }))
    const frames: TerminalServerFrame[] = []; ws.on('message', data => frames.push(JSON.parse(data.toString()))); ws.on('error', () => {}); sockets.push(ws)
    return { ws, frames, text: () => frames.flatMap(frame => frame.type === 'output' ? [frame.data] : frame.type === 'snapshot' ? [frame.output] : []).join('') }
  }
  return { root, home, ssh, host, store, terminals, open, origin, key, async close() {
    terminals.dispose(); for (const ws of sockets) ws.terminate(); engine.dispose()
    await new Promise<void>(resolve => server.close(() => resolve())); await ssh.stop()
    // A real login shell may still save .zsh_history as the SSH peer exits.
    // Async bounded retries allow that final write to finish; cleanup still
    // fails if the fixture cannot release its directory.
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } }
}

describe('real SSH resume through authenticated route family', () => {
  it('reports a failed display attachment without closing or replaying the real shell, then resumes its PID', async () => {
    const f = await realFixture()
    let spy: { mockRestore(): void } | undefined
    try {
      const first = f.open(); await wait(() => first.frames.some(frame => frame.type === 'ready'))
      first.ws.send(JSON.stringify({ type: 'input', data: 'export RESTORE_MARK=original; cd "$HOME"; echo once >> restore-failure-counter; printf "BEFORE:%s:%s\\n" "$$" "$RESTORE_MARK"\r' }))
      await wait(() => /BEFORE:\d+:original/.test(first.text()))
      const pid = first.text().match(/BEFORE:(\d+):original/)![1]
      first.ws.close(); await new Promise<void>(resolve => first.ws.once('close', () => resolve()))
      spy = vi.spyOn(TerminalScreen.prototype, 'snapshot').mockRejectedValueOnce(new Error('Incompatible renderer'))
      const failed = f.open(true); await wait(() => failed.frames.some(frame => frame.type === 'detached'))
      expect(failed.frames).toEqual([{ type: 'detached', reason: 'restore failed' }])
      expect(f.terminals.list(owner)[0]?.phase).toBe('connected')
      spy.mockRestore(); spy = undefined
      const resumed = f.open(true); await wait(() => resumed.frames.some(frame => frame.type === 'ready'))
      resumed.ws.send(JSON.stringify({ type: 'input', data: 'printf "AFTER:%s:%s\\n" "$$" "$RESTORE_MARK"\r' }))
      await wait(() => resumed.text().includes(`AFTER:${pid}:original`))
      expect(readFileSync(join(f.home, 'restore-failure-counter'), 'utf8')).toBe('once\n')
    } finally { spy?.mockRestore(); await f.close() }
  }, 15000)
  it('keeps shell PID, exported variable, cwd and a once-only write across two WebSockets', async () => {
    const f = await realFixture()
    try {
      const first = f.open(); await wait(() => first.frames.some(frame => frame.type === 'ready'))
      first.ws.send(JSON.stringify({ type: 'input', data: 'export RESUME_MARK=original; cd "$HOME"; echo once >> resume-counter; printf "BEFORE:%s:%s:%s\\n" "$$" "$RESUME_MARK" "$PWD"\r' }))
      await wait(() => /BEFORE:\d+:original:/.test(first.text()))
      const pid = first.text().match(/BEFORE:(\d+):original:/)![1]
      first.ws.close(); await new Promise<void>(resolve => first.ws.once('close', () => resolve()))
      const originalPort = f.host.port; f.store.update('real', { port: 1 })
      const second = f.open(true); await wait(() => second.frames.some(frame => frame.type === 'ready'))
      expect(second.frames[0]).toMatchObject({ type: 'snapshot', session: { target: { port: originalPort } } })
      second.ws.send(JSON.stringify({ type: 'input', data: 'printf "AFTER:%s:%s:%s\\n" "$$" "$RESUME_MARK" "$PWD"\r' }))
      await wait(() => second.text().includes(`AFTER:${pid}:original:${f.home}`))
      expect(readFileSync(join(f.home, 'resume-counter'), 'utf8')).toBe('once\n')
      second.ws.send(JSON.stringify({ type: 'input', data: 'echo final-output; exit\r' }))
      await wait(() => second.frames.some(frame => frame.type === 'exit'))
      const third = f.open(true); await wait(() => third.frames.some(frame => frame.type === 'exit'))
      expect(third.text()).toContain('final-output'); expect(third.frames.some(frame => frame.type === 'ready')).toBe(false)
      const missing = f.open(true, randomUUID()); await wait(() => missing.frames.some(frame => frame.type === 'exit'))
      expect(missing.frames).toEqual([{ type: 'exit', code: null, error: expect.stringContaining('No SSH') }])
      const list = await fetch(f.origin + '/api/dsh-ssh/terminals?owner=' + owner).then(res => res.json())
      expect(list.sessions).toHaveLength(1)
      const wrong = await fetch(f.origin + '/api/dsh-ssh/terminals?owner=another-owner-123456&id=' + f.key, { method: 'DELETE' })
      expect(wrong.status).toBe(404); expect(f.terminals.list(owner)).toHaveLength(1)
      const removed = await fetch(f.origin + '/api/dsh-ssh/terminals?owner=' + owner + '&id=' + f.key, { method: 'DELETE' })
      expect(removed.status).toBe(200); expect(f.terminals.list(owner)).toEqual([])
    } finally { await f.close() }
  }, 15000)
  it('cancels unanswered authentication on detach and preserves its failure instead of starting another SSH', async () => {
    const f = await realFixture(true)
    try {
      const first = f.open(); await wait(() => first.frames.some(frame => frame.type === 'auth_prompt'))
      first.ws.close(); await wait(() => (f.ssh as InteractiveSsh).clients.size === 0)
      const second = f.open(true); await wait(() => second.frames.some(frame => frame.type === 'exit'))
      expect((f.ssh as InteractiveSsh).challenges).toBe(1); expect((f.ssh as InteractiveSsh).shells).toBe(0)
      expect(second.frames[0]).toMatchObject({ type: 'snapshot', session: { phase: 'error' } })
      expect(JSON.stringify(second.frames)).not.toContain((f.ssh as InteractiveSsh).answers[0])
    } finally { await f.close() }
  }, 10000)
})
