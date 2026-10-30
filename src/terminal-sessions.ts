/** Host-owned PTYs. Attaching a view never acquires SSH or replays input. */
import { StringDecoder } from 'node:string_decoder'
import type { SshEngine, ShellSession, KeyboardInteractiveHandler } from './engine.ts'
import { terminalTargetOf } from './engine/connection-pool.ts'
import type { HostStore } from './store.ts'
import type { TerminalClientFrame, TerminalServerFrame, TerminalSessionInfo } from './protocol.ts'
import { TerminalScreen } from './terminal-screen.ts'
import { shellQuote } from './remote/transport.ts'

export const TERMINAL_DETACHED_MS = 30 * 60 * 1000
export const TERMINAL_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_SESSIONS = 32
export const terminalKeyValid = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value)
export const terminalSizeValid = (cols: unknown, rows: unknown): boolean => Number.isInteger(cols) && Number.isInteger(rows) && Number(cols) >= 2 && Number(cols) <= 1000 && Number(rows) >= 1 && Number(rows) <= 500
export interface TerminalView { send(frame: TerminalServerFrame): void; close(): void }
interface Entry {
  owner: string; info: TerminalSessionInfo; controller: AbortController; shell?: ShellSession
  view?: TerminalView; attaching?: TerminalView; pendingAuth?: (responses: string[]) => void
  screen: TerminalScreen; viewPaused: boolean; screenPaused: boolean; decoder: StringDecoder; timer?: ReturnType<typeof setTimeout>
}

export class TerminalSessions {
  private entries = new Map<string, Entry>()
  private nextNumber = 1
  private enabled = true
  constructor(private engine: SshEngine, private store: HostStore,
    private limits = { outputBytes: TERMINAL_OUTPUT_BYTES, detachedMs: TERMINAL_DETACHED_MS, maxSessions: MAX_SESSIONS }) {}

  hasActive(): boolean {
    return [...this.entries.values()].some(entry => ['connecting', 'connected'].includes(entry.info.phase))
  }
  list(owner: string): TerminalSessionInfo[] {
    return [...this.entries.values()].filter(entry => entry.owner === owner).map(entry => structuredClone(entry.info))
  }
  private find(owner: string, id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry || entry.owner !== owner) throw new Error('Terminal session is unavailable. No SSH connection was opened.')
    return entry
  }
  create(owner: string, id: string, alias: string, cols: number, rows: number, view: TerminalView, cwd?: string, version?: number): void {
    if (!this.enabled) throw new Error('SSH terminals are disabled')
    if (!terminalKeyValid(owner) || !terminalKeyValid(id) || !terminalSizeValid(cols, rows)) throw new Error('Invalid terminal request')
    if (this.entries.has(id)) throw new Error('Terminal already exists. Attach to the existing session; creation was not replayed.')
    if (this.entries.size >= this.limits.maxSessions) throw new Error('Terminal limit reached (32). Close an existing terminal first.')
    const host = this.store.find(alias)
    if (!host) throw new Error('Host is not configured')
    if (version !== undefined && (!Number.isSafeInteger(version) || version <= 0 || host.updatedAt !== version)) throw new Error('Host configuration changed; no terminal was opened. Choose the host again.')
    const entry: Entry = { owner, info: { id, number: this.nextNumber++, target: terminalTargetOf(host), phase: 'connecting', createdAt: Date.now(), cols, rows, truncated: false },
      controller: new AbortController(), view, screen: new TerminalScreen(cols, rows, this.limits.outputBytes, paused => { entry.screenPaused = paused; this.applyPressure(entry) }),
      viewPaused: false, screenPaused: false, decoder: new StringDecoder('utf8') }
    this.entries.set(id, entry)
    void this.snapshot(entry, view).catch(error => this.finish(entry, null, String(error)))
    const auth: KeyboardInteractiveHandler = (name, instructions, _lang, prompts, finish, target) => {
      if (entry.info.phase !== 'connecting' || !entry.view) { finish([]); return }
      entry.pendingAuth?.([])
      entry.pendingAuth = finish
      entry.view.send({ type: 'auth_prompt', name, instructions, prompts, target })
    }
    void this.engine.openShell(alias, { cols, rows }, auth, entry.controller.signal, host.updatedAt).then(shell => {
      if (entry.controller.signal.aborted || this.entries.get(id) !== entry || !entry.view) { shell.close(); return }
      entry.shell = shell
      if (shell.target) entry.info.target = shell.target
      shell.onData = data => { const text = entry.decoder.write(data); if (text) this.output(entry, text) }
      shell.onExit = (code, error) => { this.finish(entry, code, error) }
      entry.info.phase = 'connected'
      this.applyPressure(entry)
      // Initial cwd is sent exactly once, only on creation, never on attachment.
      if (cwd !== undefined) shell.send(`cd -- ${shellQuote(cwd)} || exit\r`)
      entry.view.send({ type: 'ready', alias, target: entry.info.target })
    }).catch(cause => this.finish(entry, null, cause instanceof Error ? cause.message : String(cause)))
  }
  attach(owner: string, id: string, view: TerminalView): Promise<void> {
    if (!this.enabled) throw new Error('SSH terminals are disabled')
    const entry = this.find(owner, id), old = entry.view ?? entry.attaching
    entry.view = undefined; entry.attaching = view; entry.viewPaused = false
    if (old && old !== view) {
      old.send({ type: 'detached', reason: 'replaced' }); old.close()
      if (entry.info.phase === 'connecting') this.finish(entry, null, 'Authentication or connection was interrupted. No new shell was opened.')
    }
    clearTimeout(entry.timer); entry.timer = undefined
    this.applyPressure(entry)
    return this.snapshot(entry, view, () => {
      if (entry.attaching !== view || !this.enabled || this.entries.get(id) !== entry) return false
      entry.attaching = undefined; entry.view = view
      return true
    }, () => {
      if (entry.info.phase === 'connected') view.send({ type: 'ready', alias: entry.info.target.alias, target: entry.info.target })
      else if (entry.info.phase !== 'connecting') { this.sendExit(entry, view); view.close(); this.expire(entry) }
    })
  }
  detach(owner: string, id: string, view: TerminalView): void {
    const entry = this.entries.get(id)
    if (!entry || entry.owner !== owner || (entry.view !== view && entry.attaching !== view)) return
    if (entry.view === view) entry.view = undefined
    if (entry.attaching === view) entry.attaching = undefined
    entry.viewPaused = false; this.applyPressure(entry)
    if (entry.info.phase === 'connecting') this.finish(entry, null, 'Authentication or connection was interrupted. No new shell was opened.')
    this.expire(entry)
  }
  message(owner: string, id: string, view: TerminalView, frame: TerminalClientFrame): void {
    const entry = this.find(owner, id)
    if (entry.view !== view) return // A superseded socket can never write to the shell.
    if (frame.type === 'stop') { this.finish(entry, null, undefined, 'Disconnected by user; output kept.'); return }
    if (frame.type === 'input' && entry.info.phase === 'connected' && typeof frame.data === 'string' && Buffer.byteLength(frame.data) <= 65536) entry.shell?.send(frame.data)
    if (frame.type === 'resize' && terminalSizeValid(frame.cols, frame.rows)) {
      entry.screen.resize(frame.cols, frame.rows, () => {
        entry.info.cols = frame.cols; entry.info.rows = frame.rows
        if (entry.view === view) view.send({ type: 'resized', cols: frame.cols, rows: frame.rows })
        entry.shell?.resize(frame.cols, frame.rows)
      })
    }
    if (frame.type === 'auth_response' && entry.pendingAuth && Array.isArray(frame.responses) && frame.responses.length <= 32 && frame.responses.every(value => typeof value === 'string' && value.length <= 4096)) {
      const finish = entry.pendingAuth; entry.pendingAuth = undefined; finish(frame.responses)
    }
  }
  pause(owner: string, id: string, view: TerminalView, paused: boolean): void {
    const entry = this.entries.get(id)
    if (entry?.owner !== owner || entry.view !== view) return
    entry.viewPaused = paused; this.applyPressure(entry)
  }
  remove(owner: string, id: string): void {
    const entry = this.find(owner, id)
    this.finish(entry, null, undefined, 'Terminal closed by user.')
    entry.view?.close(); entry.attaching?.close(); clearTimeout(entry.timer); this.entries.delete(id); entry.screen.dispose()
  }
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    if (!enabled) for (const entry of this.entries.values()) { this.finish(entry, null, 'SSH terminals were disabled.'); entry.attaching?.close() }
  }
  dispose(): void {
    this.setEnabled(false)
    for (const entry of this.entries.values()) { clearTimeout(entry.timer); entry.view?.close(); entry.attaching?.close(); entry.screen.dispose() }
    this.entries.clear()
  }
  private snapshot(entry: Entry, view: TerminalView, before?: () => boolean, after?: () => void): Promise<void> {
    return entry.screen.snapshot(state => {
      if (this.entries.get(entry.info.id) !== entry || (before && !before())) return
      entry.info.cols = state.cols; entry.info.rows = state.rows; entry.info.truncated = state.truncated
      view.send({ type: 'snapshot', session: structuredClone(entry.info), output: state.output, format: 'state-v1', continuity: state.continuity })
      after?.()
    })
  }
  private output(entry: Entry, text: string): void {
    if (entry.info.phase !== 'connected') return
    entry.screen.write(text, data => { entry.view?.send({ type: 'output', data }) })
  }
  private applyPressure(entry: Entry): void {
    if (entry.screenPaused || entry.viewPaused) entry.shell?.pause?.()
    else entry.shell?.resume?.()
  }
  private sendExit(entry: Entry, view: TerminalView): void { view.send({ type: 'exit', code: entry.info.code ?? null, error: entry.info.error, detail: entry.info.detail }) }
  private finish(entry: Entry, code: number | null, error?: string, detail?: string): void {
    if (entry.info.phase === 'exited' || entry.info.phase === 'error') return
    const tail = entry.decoder.end(); if (tail) this.output(entry, tail)
    entry.info.phase = error === undefined ? 'exited' : 'error'; entry.info.code = code; entry.info.error = error; entry.info.detail = detail
    entry.controller.abort(); const answer = entry.pendingAuth; entry.pendingAuth = undefined; answer?.([])
    const shell = entry.shell; entry.shell = undefined; shell?.close()
    entry.screen.finish(() => { if (entry.view) { this.sendExit(entry, entry.view); entry.view.close() } })
    this.expire(entry)
  }
  private expire(entry: Entry): void {
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      if (entry.info.phase === 'connected' || entry.info.phase === 'connecting') { this.finish(entry, null, 'Detached terminal expired after 30 minutes.'); return }
      if (this.entries.get(entry.info.id) === entry) { this.entries.delete(entry.info.id); entry.screen.dispose() }
    }, this.limits.detachedMs)
    entry.timer.unref?.()
  }
}
