/**
 * SerializeAddon restores cells and public modes, but omits the state used by
 * subsequent output. This adapter is specific to the pinned xterm 6.0.0 common
 * core (browser + headless); validate its layout before reading or mutating it.
 * It never invokes the parser, produces terminal replies, or sends SSH input.
 */
type Charset = Record<string, string> | null
interface BufferState {
  x: number; y: number; scrollTop: number; scrollBottom: number
  savedX: number; savedYOffset: number; savedFg: number; savedBg: number; savedCharset: Charset
}
export interface TerminalContinuityState {
  version: 1
  normal: BufferState
  alternate: BufferState
  charset: Charset
  glevel: number
  charsets: Charset[]
}
interface CoreBuffer {
  x: number; y: number; ybase: number; scrollTop: number; scrollBottom: number
  savedX: number; savedY: number; savedCurAttrData: { fg: number; bg: number }; savedCharset: unknown
}
interface Core {
  buffers: { normal: CoreBuffer; alt: CoreBuffer }
  _charsetService: { charset: unknown; glevel: number; _charsets: unknown[] }
}
interface Terminal { cols: number; rows: number; refresh?: (start: number, end: number) => void }
export const TERMINAL_CONTINUITY_BYTES = 32 * 1024
const fail = (): never => { throw new Error('Terminal continuation state is incompatible. The original shell remains running.') }
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  return value as Record<string, unknown>
}
const integer = (value: unknown, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return fail()
  return value
}
function charset(value: unknown): Charset {
  if (value === null || value === undefined) return null
  const entries = Object.entries(record(value))
  if (entries.length > 128) return fail()
  const result: Record<string, string> = Object.create(null)
  for (const [key, glyph] of entries) {
    if (!/^[\x20-\x7e]$/.test(key) || typeof glyph !== 'string' || glyph.length < 1 || glyph.length > 4) return fail()
    result[key] = glyph
  }
  return result
}
function bufferState(value: unknown, cols: number, rows: number): BufferState {
  const b = record(value)
  const scrollTop = integer(b.scrollTop, 0, rows - 1), scrollBottom = integer(b.scrollBottom, scrollTop, rows - 1)
  return {
    // x === cols is a pending wrap; converting it to CUP loses that state.
    x: integer(b.x, 0, cols), y: integer(b.y, 0, rows - 1), scrollTop, scrollBottom,
    savedX: integer(b.savedX, 0, cols), savedYOffset: integer(b.savedYOffset, -10000, rows - 1),
    // xterm uses signed bitwise attributes, including bit 31 for strikethrough.
    savedFg: integer(b.savedFg, -2147483648, 4294967295), savedBg: integer(b.savedBg, -2147483648, 4294967295),
    savedCharset: charset(b.savedCharset),
  }
}
export function validateTerminalContinuity(value: unknown, cols: number, rows: number): TerminalContinuityState {
  integer(cols, 2, 1000); integer(rows, 1, 500)
  const state = record(value)
  if (state.version !== 1 || !Array.isArray(state.charsets) || state.charsets.length > 4) return fail()
  const result: TerminalContinuityState = { version: 1, normal: bufferState(state.normal, cols, rows), alternate: bufferState(state.alternate, cols, rows),
    charset: charset(state.charset), glevel: integer(state.glevel, 0, 3), charsets: Array.from(state.charsets, charset) }
  if (new TextEncoder().encode(JSON.stringify(result)).length > TERMINAL_CONTINUITY_BYTES) return fail()
  return result
}
function core(terminal: Terminal): Core {
  const c = record(record(terminal)._core), buffers = record(c.buffers), cs = record(c._charsetService)
  if (!Array.isArray(cs._charsets) || cs._charsets.length > 4) return fail()
  integer(cs.glevel, 0, 3); charset(cs.charset)
  for (const value of [buffers.normal, buffers.alt]) {
    const b = record(value), attr = record(b.savedCurAttrData)
    integer(b.ybase, 0, 10000); integer(b.savedY, 0, 10500)
    bufferState({ ...b, savedYOffset: Number(b.savedY) - Number(b.ybase), savedFg: attr.fg, savedBg: attr.bg }, terminal.cols, terminal.rows)
  }
  return c as unknown as Core
}
export function captureTerminalContinuity(terminal: Terminal): TerminalContinuityState {
  const c = core(terminal)
  const capture = (b: CoreBuffer) => ({ x: b.x, y: b.y, scrollTop: b.scrollTop, scrollBottom: b.scrollBottom,
    savedX: b.savedX, savedYOffset: b.savedY - b.ybase, savedFg: b.savedCurAttrData.fg, savedBg: b.savedCurAttrData.bg,
    savedCharset: b.savedCharset })
  return validateTerminalContinuity({ version: 1, normal: capture(c.buffers.normal), alternate: capture(c.buffers.alt),
    charset: c._charsetService.charset, glevel: c._charsetService.glevel, charsets: c._charsetService._charsets }, terminal.cols, terminal.rows)
}
export function applyTerminalContinuity(terminal: Terminal, value: unknown): void {
  const state = validateTerminalContinuity(value, terminal.cols, terminal.rows), c = core(terminal)
  // Validate everything first. Old history may have been deliberately trimmed;
  // saved positions before that retained history clamp to its first line.
  for (const [b, saved] of [[c.buffers.normal, state.normal], [c.buffers.alt, state.alternate]] as const) {
    b.x = saved.x; b.y = saved.y; b.scrollTop = saved.scrollTop; b.scrollBottom = saved.scrollBottom
    b.savedX = saved.savedX; b.savedY = Math.max(0, b.ybase + saved.savedYOffset)
    b.savedCurAttrData.fg = saved.savedFg; b.savedCurAttrData.bg = saved.savedBg
    b.savedCharset = saved.savedCharset ?? undefined
  }
  c._charsetService.charset = state.charset ?? undefined
  c._charsetService.glevel = state.glevel
  c._charsetService._charsets = state.charsets.map(value => value ?? undefined)
  terminal.refresh?.(0, terminal.rows - 1)
}
