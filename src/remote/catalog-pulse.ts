import type { WebSocket } from 'ws'
import { CatalogReadError } from './catalog-json.ts'

/** HTTP health does not prove an already-open WS carrier still responds.
 * Probe only the read-only observer, leaving user terminals untouched. */
export function watchCatalogPulse(socket: Pick<WebSocket, 'on' | 'off' | 'ping'>, failed: (error: Error) => void): () => void {
  let closed = false, deadline: ReturnType<typeof setTimeout> | undefined
  const pong = () => { clearTimeout(deadline); deadline = undefined }
  const stop = () => {
    if (closed) return
    closed = true; clearInterval(interval); clearTimeout(deadline); socket.off('pong', pong)
  }
  const fail = () => { if (closed) return; stop(); failed(new CatalogReadError('stream-timeout')) }
  const interval = setInterval(() => {
    if (closed) return
    deadline = setTimeout(fail, 10000); deadline.unref()
    try { socket.ping() } catch { fail() }
  }, 30000)
  interval.unref(); socket.on('pong', pong)
  return stop
}
