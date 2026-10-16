import headless from '@xterm/headless'
import { afterEach, expect, it, vi } from 'vitest'
import { TerminalEscapeBuffer, TerminalScreen } from '../src/terminal-screen.ts'
import { TerminalOperationQueue } from '../src/terminal-operation-queue.ts'
import { applyTerminalContinuity, captureTerminalContinuity, type TerminalContinuityState } from '../src/terminal-continuity.ts'

const resources: Array<{ dispose(): void }> = []
afterEach(() => { for (const resource of resources.splice(0)) resource.dispose() })
function screen(cols = 80, rows = 24, bytes = 2 * 1024 * 1024, pressure?: (paused: boolean) => void) {
  const screen = new TerminalScreen(cols, rows, bytes, pressure); resources.push(screen); return screen
}
async function snapshot(screen: TerminalScreen) {
  let state!: { output: string; cols: number; rows: number; truncated: boolean; continuity: TerminalContinuityState }
  await screen.snapshot(value => { state = value }); return state
}
async function restore(state: Awaited<ReturnType<typeof snapshot>>) {
  const terminal = new headless.Terminal({ cols: state.cols, rows: state.rows, scrollback: 10000, allowProposedApi: true })
  resources.push(terminal)
  await new Promise<void>(resolve => terminal.write(state.output, resolve))
  applyTerminalContinuity(terminal, state.continuity); return terminal
}
function contents(terminal: headless.Terminal) {
  const buffer = terminal.buffer.active
  return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)!.translateToString(true)).join('\n')
}
function frame(terminal: headless.Terminal) {
  const buffer = terminal.buffer.active
  return { type: buffer.type, cursor: [buffer.cursorX, buffer.cursorY], modes: terminal.modes,
    lines: Array.from({ length: buffer.length }, (_, index) => {
      const line = buffer.getLine(index)!
      return { wrapped: line.isWrapped, text: line.translateToString(true), cells: Array.from({ length: terminal.cols }, (_, col) => {
        const cell = line.getCell(col)!
        return [cell.getChars(), cell.getWidth(), cell.getFgColor(), cell.getBgColor(), cell.isBold(), cell.isInverse(), cell.isItalic(), cell.isStrikethrough()]
      }) }
    }) }
}

it.each([
  { name: 'custom scrolling region', setup: '\x1b[?1049h\x1b[1;1HHEADER\x1b[6;1HFOOTER\x1b[2;5r\x1b[5;1HBODY', next: '\r\nNEXT' },
  { name: 'DEC saved cursor and color', setup: '\x1b[2;3H\x1b[1;34m\x1b7\x1b[6;10H\x1b[0;31mLIVE', next: '\x1b8X' },
  { name: 'ANSI saved cursor and color', setup: '\x1b[2;3H\x1b[1;34m\x1b[s\x1b[6;10H\x1b[0;31mLIVE', next: '\x1b[uX' },
  { name: 'saved DEC graphics charset', setup: '\x1b[2;3H\x1b(0\x1b7\x1b(B\x1b[6;10HLIVE', next: '\x1b8q' },
  { name: 'normal saved cursor behind an alternate buffer', setup: '\x1b[2;3H\x1b[34m\x1b7\x1b[6;10H\x1b[31mNORMAL\x1b[?47h\x1b[4;5HALTERNATE', next: '\x1b[?47l\x1b8X' },
  { name: 'origin mode cursor within scrolling region', setup: '\x1b[2;7r\x1b[?6h\x1b[3;8HX', next: 'Y\r\nNEXT' },
  { name: 'active DEC graphics charset', setup: '\x1b(0\x1b[3;5Hl', next: 'qk' },
  { name: 'shifted designated graphics charset', setup: '\x1b)0\x0e\x1b[3;5Hl', next: 'qk\x0fplain\x0eqk' },
  { name: 'pending wrap', setup: '\x1b[?1049h\x1b[2;1H' + 'x'.repeat(30), next: 'Y' },
  { name: 'signed saved strikethrough attributes', setup: '\x1b[2;3H\x1b[9;34m\x1b7\x1b[6;10H\x1b[0mLIVE', next: '\x1b8X' },
  { name: 'soft reset clears scroll and save state', setup: '\x1b[2;6r\x1b[3;5H\x1b(0\x1b7\x1b[!p', next: '\x1b8q\r\nNEXT' },
  { name: 'full reset clears scroll and save state', setup: '\x1b[2;6r\x1b[3;5H\x1b(0\x1b7\x1bc', next: '\x1b8q\r\nNEXT' },
])('continues $name after restoration', async ({ setup, next }) => {
  const original = screen(30, 8)
  const live = new headless.Terminal({ cols: 30, rows: 8, allowProposedApi: true }); resources.push(live)
  original.write(setup, () => {})
  await new Promise<void>(resolve => live.write(setup, resolve))
  const recovered = await restore(await snapshot(original))
  await new Promise<void>(resolve => live.write(next, resolve))
  await new Promise<void>(resolve => recovered.write(next, resolve))
  expect(frame(recovered)).toEqual(frame(live))
})

it('preserves saved positions while history grows and reflows on resize', async () => {
  const original = screen(30, 8), live = new headless.Terminal({ cols: 30, rows: 8, scrollback: 10000, allowProposedApi: true }); resources.push(live)
  const setup = 'start\r\n\x1b[34m\x1b7' + 'long '.repeat(20) + '\r\n' + 'history\r\n'.repeat(35)
  original.write(setup, () => {}); await new Promise<void>(resolve => live.write(setup, resolve))
  for (const cols of [24, 60, 30]) {
    original.resize(cols, 8, () => {}); live.resize(cols, 8)
    const state = await snapshot(original), recovered = await restore(state)
    const next = '\x1b8X\r\nEND'
    await new Promise<void>(resolve => recovered.write(next, resolve))
    await new Promise<void>(resolve => live.write(next, resolve))
    expect(frame(recovered)).toEqual(frame(live))
    original.write(next, () => {})
  }
})

it('clamps a saved position outside deliberately trimmed history without emitting input', async () => {
  const original = screen(30, 8, 300)
  original.write('saved\x1b7\r\n' + Array.from({ length: 80 }, (_, index) => `history ${index}\r\n`).join(''), () => {})
  const state = await snapshot(original), recovered = await restore(state), input = vi.fn(); recovered.onData(input)
  expect(state.truncated).toBe(true)
  await new Promise<void>(resolve => recovered.write('\x1b8X', resolve))
  expect(recovered.buffer.active.getLine(recovered.buffer.active.baseY)!.translateToString(true)).toContain('X')
  expect(input).not.toHaveBeenCalled()
})

it('rejects incompatible continuation data and renderer layouts before changing any state', async () => {
  const original = screen(30, 8); original.write('\x1b[2;6r\x1b[4;3Hvalid', () => {})
  const state = await snapshot(original), recovered = await restore(state), before = frame(recovered)
  expect(captureTerminalContinuity(recovered)).toEqual(state.continuity)
  for (const mutate of [
    (value: any) => { value.version = 99 },
    (value: any) => { value.normal.scrollBottom = 9 },
    (value: any) => { value.normal.savedFg = NaN },
    (value: any) => { value.charsets = new Array(5).fill(null) },
    (value: any) => { value.charset = { '__proto__': 'x', long: 'invalid' } },
  ]) {
    const invalid = structuredClone(state.continuity); mutate(invalid)
    expect(() => applyTerminalContinuity(recovered, invalid)).toThrow('original shell remains running')
    expect(frame(recovered)).toEqual(before)
  }
  expect(() => applyTerminalContinuity({ cols: 30, rows: 8 }, state.continuity)).toThrow('incompatible')
})

it.each(['\x1b[31m', '\x1b]0;title\x07', '\x1b]8;;https://fixture.invalid\x1b\\', '\x1bPignored\x1b\\', '\x1b(B', '\x9b2J'])('holds split VT controls at every boundary: %j', control => {
  for (let split = 1; split < control.length; split++) {
    const boundary = new TerminalEscapeBuffer()
    expect(boundary.push('before' + control.slice(0, split))).toBe('before')
    expect(boundary.push(control.slice(split) + 'after')).toBe(control + 'after')
    expect(boundary.finish()).toBe('')
  }
})
it('cancels a malformed oversized control and can parse the next complete output', () => {
  const boundary = new TerminalEscapeBuffer()
  expect(boundary.push('\x1b]unfinished')).toBe('')
  expect(boundary.push('x'.repeat(2 * 1024 * 1024)).endsWith('\x18')).toBe(true)
  expect(boundary.truncated).toBe(true)
  expect(boundary.push('normal')).toBe('normal')
})
it('restores colored Unicode cells, cursor and modes after shrinking and widening', async () => {
  const original = screen(88, 6)
  original.write('FIRST history\r\n\x1b[1;31m中文🙂 colored\x1b[0m\r\n' + 'long '.repeat(23) + '\r\nLAST\x1b[2D', () => {})
  const first = await snapshot(original), live = await restore(first)
  for (const cols of [32, 88, 40]) {
    original.resize(cols, 6, () => {}); live.resize(cols, 6)
    const state = await snapshot(original), recovered = await restore(state)
    expect(frame(recovered)).toEqual(frame(live))
    expect(contents(recovered)).toContain('FIRST history')
    expect(contents(recovered)).toContain('中文🙂 colored')
  }
})
it('restores alternate-screen content and the hidden normal buffer without sending SSH input', async () => {
  const original = screen(40, 6)
  original.write('NORMAL history\r\nPROMPT', () => {})
  original.write('\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[2J\x1b[3;4H\x1b[1;32mTUI 7\x1b[0m', () => {})
  const state = await snapshot(original), first = await restore(state), second = await restore(state)
  expect(state.output.endsWith('\x1b[?25l')).toBe(true)
  const input = vi.fn(); first.onData(input)
  expect(first.buffer.active.type).toBe('alternate')
  expect(contents(first)).toContain('TUI 7')
  expect(first.modes.bracketedPasteMode).toBe(true)
  expect(frame(first)).toEqual(frame(second))
  await new Promise<void>(resolve => first.write('\x1b[?1049l', resolve))
  expect(contents(first)).toContain('NORMAL history'); expect(contents(first)).toContain('PROMPT')
  expect(input).not.toHaveBeenCalled()
  original.write('\x1b[?25h', () => {})
  expect((await snapshot(original)).output.endsWith('\x1b[?25l')).toBe(false)
})
it('restores only visible columns of an alternate screen after a split-pane resize', async () => {
  const original = screen(117, 22)
  original.write('\x1b[?1049h\x1b[10;1H' + '─'.repeat(117) + '\x1b[21;1HSTATUS', () => {})
  const live = await restore(await snapshot(original))
  original.resize(34, 21, () => {}); live.resize(34, 21)
  const redraw = '\x1b[10;1H' + '─'.repeat(34) + '\x1b[11;1HLESS reading position\x1b[21;1HTMUX status\x1b[20;2H'
  original.write(redraw, () => {})
  await new Promise<void>(resolve => live.write(redraw, resolve))
  const recovered = await restore(await snapshot(original))
  const visible = (terminal: headless.Terminal) => ({ ...frame(terminal), lines: frame(terminal).lines.map((line, index) => ({
    ...line, text: terminal.buffer.active.getLine(index)!.translateToString(true, 0, terminal.cols),
  })) })
  expect(visible(recovered)).toEqual(visible(live))
})
it('cleans a forced wrap after an erased full-width line without leaving a placeholder', async () => {
  const original = screen(20, 4)
  original.write('\x1b[?1049h' + 'x'.repeat(20) + 'Y\x1b[1;1H\x1b[2K\x1b[2;2H', () => {})
  const first = await snapshot(original), live = await restore(first)
  expect(live.buffer.active.getLine(0)!.translateToString(true)).toBe('')
  expect(live.buffer.active.getLine(1)!.translateToString(true)).toBe('Y')
  expect(live.buffer.active.getLine(1)!.isWrapped).toBe(true)
  expect([live.buffer.active.cursorX, live.buffer.active.cursorY]).toEqual([1, 1])
})
it.each(['\x1bc', '\x1b[!p'])('restores cursor visibility after a terminal reset %j', async reset => {
  const original = screen(40, 6)
  original.write('\x1b[?25l', () => {})
  expect((await snapshot(original)).output.endsWith('\x1b[?25l')).toBe(true)
  original.write(reset, () => {})
  expect((await snapshot(original)).output.endsWith('\x1b[?25l')).toBe(false)
})
it.each([
  ['SGR cells', '\x1b[?1002h\x1b[?1006h', 1006, 'drag'],
  ['SGR pixels', '\x1b[?1003;1016h', 1016, 'any'],
  ['last enabled encoding wins', '\x1b[?1002;1006;1016h', 1016, 'drag'],
  ['default after encoding reset', '\x1b[?1002;1016h\x1b[?1006l', 0, 'drag'],
  ['default after full reset', '\x1b[?1002;1006h\x1bc', 0, 'none'],
  ['encoding survives soft reset', '\x1b[?1002;1006h\x1b[!p', 1006, 'drag'],
] as const)('restores mouse encoding as well as tracking: %s', async (_name, controls, expected, tracking) => {
  const original = screen(40, 6)
  original.write(controls + 'MOUSE fixture', () => {})
  const state = await snapshot(original)
  const recovered = new headless.Terminal({ cols: state.cols, rows: state.rows, allowProposedApi: true }); resources.push(recovered)
  let encoding = 0
  for (const [final, enabled] of [['h', true], ['l', false]] as const) recovered.parser.registerCsiHandler({ prefix: '?', final }, params => {
    for (const param of params) if (param === 1006 || param === 1016) encoding = enabled ? param : 0
    return false
  })
  const input = vi.fn(); recovered.onData(input)
  await new Promise<void>(resolve => recovered.write(state.output, resolve))
  expect(encoding).toBe(expected)
  expect(recovered.modes.mouseTrackingMode).toBe(tracking)
  expect(contents(recovered)).toContain('MOUSE fixture')
  expect(input).not.toHaveBeenCalled()
})
it('attaches while a color sequence is incomplete, then delivers the complete sequence to both renderers', async () => {
  const original = screen(40, 4), forwarded: string[] = []
  original.write('PREFIX\x1b[3', value => forwarded.push(value))
  const recovered = await restore(await snapshot(original))
  expect(contents(recovered)).toContain('PREFIX'); expect(forwarded).toEqual(['PREFIX'])
  original.write('1mRED\x1b[0m', value => forwarded.push(value))
  await snapshot(original)
  await new Promise<void>(resolve => recovered.write(forwarded[1]!, resolve))
  expect(frame(recovered)).toEqual(frame(await restore(await snapshot(original))))
})
it('bounds serialized history at complete Unicode cell boundaries and marks omitted history', async () => {
  const original = screen(20, 3, 240)
  original.write(Array.from({ length: 200 }, (_, index) => `ROW${index} 中文🙂\r\n`).join('') + 'LAST', () => {})
  const state = await snapshot(original), recovered = await restore(state)
  expect(Buffer.byteLength(state.output)).toBeLessThanOrEqual(240)
  expect(state.truncated).toBe(true); expect(state.output).not.toContain('�')
  expect(contents(recovered)).toContain('ROW199 中文🙂'); expect(contents(recovered)).toContain('LAST')
})
it('fails a too-small visible-screen restore cap explicitly, retaining the original screen', async () => {
  const original = screen(20, 3, 4)
  original.write('VISIBLE', () => {})
  await expect(snapshot(original)).rejects.toThrow('original shell remains running')
  original.write('\r\x1b[2Kok', () => {})
  expect((await snapshot(original)).output).toBe('ok')
})
it('applies output, resize acknowledgement, redraw and snapshot in one order', async () => {
  const original = screen(40, 4), events: string[] = []
  original.write('before', () => events.push('output before'))
  original.resize(20, 4, () => events.push('resized'))
  original.write('\r\x1b[2Kafter', () => events.push('redraw'))
  await original.snapshot(state => { events.push('snapshot'); expect(state.cols).toBe(20); expect(state.output).toContain('after') })
  expect(events).toEqual(['output before', 'resized', 'redraw', 'snapshot'])
})
it('pauses incoming output while the parser is busy and resumes only after it applies', async () => {
  const pressure = vi.fn(), original = screen(80, 6, 2 * 1024 * 1024, pressure)
  original.write('x'.repeat(1024 * 1024 + 1), () => {})
  expect(pressure.mock.calls).toEqual([[true]])
  await snapshot(original)
  expect(pressure.mock.calls).toEqual([[true], [false]])
})
it('waits for asynchronous writes before resizing and releases a pending write on disposal', async () => {
  let finish!: () => void
  const order: string[] = []
  const queue = new TerminalOperationQueue({ write: (_data, callback) => { order.push('write'); finish = callback }, resize: () => { order.push('resize') } })
  const write = queue.write('old', () => order.push('output')), resize = queue.resize(20, 4), snapshot = queue.run(() => order.push('snapshot'))
  await Promise.resolve(); expect(order).toEqual(['write'])
  finish(); await Promise.all([write, resize, snapshot]); expect(order).toEqual(['write', 'output', 'resize', 'snapshot'])
  const pending = queue.write('pending'), ignored = queue.resize(30, 4)
  await Promise.resolve(); queue.dispose(); await Promise.all([pending, ignored])
  expect(order).toEqual(['write', 'output', 'resize', 'snapshot', 'write'])
})
