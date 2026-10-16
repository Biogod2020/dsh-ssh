/** Canonical terminal state; parsing never sends replies or input to SSH. */
import headless from '@xterm/headless'
import serializer from '@xterm/addon-serialize'
import type { ITerminalAddon } from '@xterm/headless'
import { TerminalOperationQueue } from './terminal-operation-queue.ts'
import { captureTerminalContinuity, type TerminalContinuityState } from './terminal-continuity.ts'

const SCREEN_CELLS = 250000
const MAX_SCROLLBACK = 10000
const MAX_SEQUENCE = 2 * 1024 * 1024

/** Alternate buffers retain off-screen columns on shrink. Do not serialize them into new rows. */
class VisibleSerializeAddon extends serializer.SerializeAddon {
  override activate(terminal: Parameters<serializer.SerializeAddon['activate']>[0]): void {
    const visibleBuffer = (buffer: typeof terminal.buffer.active) => new Proxy(buffer, {
      get(target, key) {
        if (key === 'getLine') return (index: number) => {
          const line = target.getLine(index)
          if (!line || line.length <= terminal.cols) return line
          return new Proxy(line, { get(target, key) {
            if (key === 'length') return terminal.cols
            const value = Reflect.get(target, key, target)
            return typeof value === 'function' ? value.bind(target) : value
          } })
        }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const buffers = new Proxy(terminal.buffer, { get(target, key) {
      if (key === 'active' || key === 'normal' || key === 'alternate') return visibleBuffer(target[key])
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    super.activate(new Proxy(terminal, { get: (target, key) => key === 'buffer' ? buffers : Reflect.get(target, key, target) }))
  }
}

/** Keep unfinished VT controls outside both parsers until a complete boundary. */
export class TerminalEscapeBuffer {
  private state: 'ground' | 'escape' | 'csi' | 'osc' | 'string' | 'oscEscape' | 'stringEscape' = 'ground'
  private pending = ''
  truncated = false
  push(data: string): string {
    let end = 0
    for (let index = 0; index < data.length; index++) {
      const code = data.charCodeAt(index)
      if (code === 0x18 || code === 0x1a || code === 0x9c) this.state = 'ground'
      else if (this.state === 'oscEscape' || this.state === 'stringEscape') {
        if (code === 0x5c) this.state = 'ground'
        else { this.state = 'escape'; this.escape(code) }
      } else if (code === 0x1b) this.state = this.state === 'osc' ? 'oscEscape' : this.state === 'string' ? 'stringEscape' : 'escape'
      else if (this.state === 'osc') { if (code === 7) this.state = 'ground' }
      else if (this.state === 'string') { /* DCS / APC / PM / SOS end with ST. */ }
      else if (this.state === 'escape') this.escape(code)
      else if (code === 0x9b) this.state = 'csi'
      else if (code === 0x9d) this.state = 'osc'
      else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) this.state = 'string'
      else if (this.state === 'csi' && code >= 0x40 && code <= 0x7e) this.state = 'ground'
      if (this.state === 'ground') end = index + 1
    }
    const complete = end > 0 ? this.pending + data.slice(0, end) : ''
    this.pending = end > 0 ? data.slice(end) : this.pending + data
    if (this.pending.length > MAX_SEQUENCE) {
      // Cancel an oversized unfinished control, not the remote process.
      const cancelled = complete + this.pending + '\x18'
      this.pending = ''; this.state = 'ground'; this.truncated = true
      return cancelled
    }
    return complete
  }
  finish(): string {
    const tail = this.pending ? this.pending + '\x18' : ''
    this.pending = ''; this.state = 'ground'
    return tail
  }
  private escape(code: number): void {
    if (code === 0x5b) this.state = 'csi'
    else if (code === 0x5d) this.state = 'osc'
    else if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) this.state = 'string'
    else if (code >= 0x30 && code <= 0x7e) this.state = 'ground'
  }
}

export class TerminalScreen {
  private terminal: headless.Terminal
  private serialize = new VisibleSerializeAddon()
  private queue: TerminalOperationQueue
  private boundary = new TerminalEscapeBuffer()
  private firstLine: ReturnType<headless.Terminal['registerMarker']>
  private pendingBytes = 0
  private paused = false
  private disposed = false
  private lostHistory = false
  private cursorVisible = true
  private mouseEncoding: 1006 | 1016 | undefined
  constructor(cols: number, rows: number, private maxBytes: number,
    private pressure: (paused: boolean) => void = () => {}) {
    this.terminal = new headless.Terminal({ cols, rows, scrollback: this.scrollback(cols, rows), allowProposedApi: true })
    // Upstream types name the browser Terminal; runtime uses the shared public buffer/mode APIs.
    this.terminal.loadAddon(this.serialize as unknown as ITerminalAddon)
    // SerializeAddon omits cursor visibility and mouse encoding. Observe without consuming.
    for (const [final, visible] of [['h', true], ['l', false]] as const) {
      this.terminal.parser.registerCsiHandler({ prefix: '?', final }, params => {
        if (params.includes(25)) this.cursorVisible = visible
        for (const param of params) {
          if (param === 1006 || param === 1016) this.mouseEncoding = visible ? param : undefined
        }
        return false
      })
    }
    this.terminal.parser.registerEscHandler({ final: 'c' }, () => { this.cursorVisible = true; this.mouseEncoding = undefined; return false })
    this.terminal.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => { this.cursorVisible = true; return false })
    this.queue = new TerminalOperationQueue(this.terminal)
    this.firstLine = this.terminal.registerMarker(0)
  }
  write(data: string, applied: (data: string) => void): void {
    if (this.disposed) return
    const complete = this.boundary.push(data)
    if (!complete) return
    const bytes = Buffer.byteLength(complete)
    this.pendingBytes += bytes; this.updatePressure()
    void this.queue.write(complete, () => {
      this.pendingBytes -= bytes; this.updatePressure()
      this.lostHistory ||= this.firstLine?.isDisposed ?? false
      applied(complete)
    })
  }
  resize(cols: number, rows: number, applied: () => void): void {
    void this.queue.run(() => {
      this.terminal.options.scrollback = this.scrollback(cols, rows)
      this.terminal.resize(cols, rows)
      this.lostHistory ||= this.firstLine?.isDisposed ?? false
      applied()
    })
  }
  snapshot(applied: (state: { output: string; cols: number; rows: number; truncated: boolean; continuity: TerminalContinuityState }) => void): Promise<void> {
    return this.queue.run(() => {
      let scrollback = this.scrollback(this.terminal.cols, this.terminal.rows)
      // Upstream's forced-wrap cleanup emits zero horizontal offsets for an erased line.
      // CSI 0 C/D means one cell in VT, so omit these serializer-generated no-ops.
      const serialize = (): string => this.serialize.serialize({ scrollback }).replace(/\x1b\[0[CD]/g, '')
        + (this.mouseEncoding === undefined ? '' : `\x1b[?${this.mouseEncoding}h`)
        + (this.cursorVisible ? '' : '\x1b[?25l')
      let output = serialize()
      while (Buffer.byteLength(output) > this.maxBytes && scrollback > 0) {
        scrollback = Math.floor(scrollback / 2); output = serialize(); this.lostHistory = true
      }
      if (Buffer.byteLength(output) > this.maxBytes) throw new Error('Terminal screen exceeds the restore limit. The original shell remains running.')
      applied({ output, cols: this.terminal.cols, rows: this.terminal.rows, truncated: this.lostHistory || this.boundary.truncated,
        continuity: captureTerminalContinuity(this.terminal) })
    })
  }
  finish(applied: () => void): void {
    const tail = this.boundary.finish()
    if (tail) this.write(tail, () => {})
    void this.queue.run(applied)
  }
  dispose(): void { this.disposed = true; this.queue.dispose(); this.terminal.dispose() }
  private scrollback(cols: number, rows: number): number { return Math.max(0, Math.min(MAX_SCROLLBACK, Math.floor(SCREEN_CELLS / cols) - rows)) }
  private updatePressure(): void {
    const paused = this.paused ? this.pendingBytes > 512 * 1024 : this.pendingBytes > 1024 * 1024
    if (paused !== this.paused) { this.paused = paused; this.pressure(paused) }
  }
}
