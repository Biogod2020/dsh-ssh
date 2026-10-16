/**
 * PTY shell sessions for the web terminal: a standalone (non-pooled)
 * ssh2 connection with a long-lived shell channel, resize, and pausable
 * output delivery.
 */

import { connectChain, terminalTargetOf, type KeyboardInteractiveHandler, type PoolEngine } from './connection-pool.ts'
import type { TerminalTarget } from '../protocol.ts'

/** A live PTY shell session. */
export interface ShellSession {
  target?: TerminalTarget
  /** Assign to receive remote output. */
  onData?: (data: Buffer) => void
  /** Assign to be notified when the channel closes. */
  onExit?: (code: number | null, error?: string) => void
  /** Write raw input to the shell. */
  send(data: string): void
  /** Resize the remote PTY. */
  resize(cols: number, rows: number): void
  /** Close the session and its channel. */
  close(): void
  /** Pause remote output delivery (transport backpressure). */
  pause(): void
  /** Resume remote output delivery. */
  resume(): void
}

/**
 * Open a PTY shell session for the web terminal (standalone connection).
 * The shell is a long-lived exclusive stream: it uses its own connection so
 * closing it can never tear down a pooled exec/tunnel sharing the alias.
 */
export async function openShell(
  engine: PoolEngine,
  alias: string,
  size: { cols: number; rows: number },
  onKeyboardInteractive?: KeyboardInteractiveHandler,
  signal?: AbortSignal,
  expectedUpdatedAt?: number,
): Promise<ShellSession> {
  signal?.throwIfAborted()
  const configured = engine.store.find(alias)
  if (configured === undefined) throw new Error('alias \'' + alias + '\' not found — add it first')
  if (expectedUpdatedAt !== undefined && configured.updatedAt !== expectedUpdatedAt) throw new Error('Host configuration changed; no terminal was opened. Choose the host again')
  const entry = structuredClone(configured)
  const { client, hops } = await connectChain(engine, entry, onKeyboardInteractive, signal)
  return await new Promise<ShellSession>((resolve, reject) => {
    let settled = false, tornDown = false
    let session: ShellSession | undefined
    const teardown = (): void => {
      if (tornDown) return
      tornDown = true
      signal?.removeEventListener('abort', cancel)
      try { client.destroy() } catch { /* closed */ }
      for (const hop of hops) { try { hop.destroy() } catch { /* closed */ } }
    }
    const cancel = (): void => {
      if (!settled) { settled = true; reject(signal?.reason ?? new Error('Terminal connection cancelled')) }
      session?.close(); teardown()
    }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) { cancel(); return }
    try { client.shell({ term: 'xterm-256color', cols: size.cols, rows: size.rows }, (error, stream) => {
      if (settled || signal?.aborted) { stream?.destroy(); teardown(); return }
      if (error !== undefined) { settled = true; teardown(); reject(error); return }
      settled = true
      session = {
        target: terminalTargetOf(entry),
        send: (data) => { try { stream.write(data) } catch { /* channel gone */ } },
        resize: (cols, rows) => { try { stream.setWindow(rows, cols, rows, cols) } catch { /* channel gone */ } },
        close: () => {
          try { stream.close() } catch { /* channel gone */ }
          teardown()
        },
        pause: () => { try { stream.pause() } catch { /* channel gone */ } },
        resume: () => { try { stream.resume() } catch { /* channel gone */ } },
      }
      stream.on('data', (chunk: Buffer) => { session?.onData?.(chunk) })
      stream.on('close', (code: number | null) => {
        teardown()
        session?.onExit?.(code)
      })
      stream.on('error', (streamError: Error) => {
        teardown()
        session?.onExit?.(null, streamError instanceof Error ? streamError.message : String(streamError))
      })
      resolve(session)
    }) } catch (error) { settled = true; teardown(); reject(error) }
  })
}
