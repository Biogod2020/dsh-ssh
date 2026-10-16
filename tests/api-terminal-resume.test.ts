// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { SshApi, TerminalCatalogUnsupportedError } from '../src/client/api.ts'

class Socket {
  static OPEN = 1
  static sockets: Socket[] = []
  readyState = 1
  onmessage?: (event: { data: string }) => void
  onclose?: () => void
  onerror?: () => void
  sent: string[] = []
  constructor(readonly url: string) { Socket.sockets.push(this) }
  send(value: string) { this.sent.push(value) }
  close = vi.fn()
  frame(value: object) { this.onmessage?.({ data: JSON.stringify(value) }) }
}
afterEach(() => { vi.unstubAllGlobals(); Socket.sockets = [] })
it('uses attach mode and never sends queued input before readiness or after transport loss', () => {
  vi.stubGlobal('WebSocket', Socket)
  const connection = new SshApi().openTerminal('original', 80, 24, undefined, 1, { owner: 'owner-1234567890123', id: 'session-1234567890', attach: true })
  const socket = Socket.sockets[0]!, detached = vi.fn(), exit = vi.fn(), snapshot = vi.fn(), resized = vi.fn()
  connection.onDetached = detached; connection.onExit = exit; connection.onSnapshot = snapshot; connection.onResized = resized
  expect(new URL(socket.url).searchParams.get('attach')).toBe('1')
  connection.send('not ready'); expect(socket.sent).toEqual([])
  socket.frame({ type: 'snapshot', session: { id: 'session-1234567890' }, output: 'old', format: 'state-v1' })
  expect(snapshot).toHaveBeenCalledExactlyOnceWith({ id: 'session-1234567890' }, 'old', 'state-v1')
  socket.frame({ type: 'resized', cols: 32, rows: 20 }); expect(resized).toHaveBeenCalledExactlyOnceWith(32, 20)
  socket.frame({ type: 'ready', alias: 'original' }); connection.send('one input')
  socket.onerror?.(); socket.onclose?.(); connection.send('late input'); connection.resize(100, 30)
  expect(socket.sent.map(value => JSON.parse(value))).toEqual([{ type: 'input', data: 'one input' }])
  expect(detached).toHaveBeenCalledOnce(); expect(exit).not.toHaveBeenCalled(); expect(Socket.sockets).toHaveLength(1)
})
it('reports a replaced view once; stop is explicit while close only detaches', () => {
  vi.stubGlobal('WebSocket', Socket)
  const connection = new SshApi().openTerminal('original', 80, 24, undefined, undefined, { owner: 'owner-1234567890123', id: 'session-1234567890', attach: false })
  const socket = Socket.sockets[0]!, detached = vi.fn(); connection.onDetached = detached
  connection.stop?.(); connection.close(); expect(socket.sent).toEqual(['{"type":"stop"}']); expect(socket.close).toHaveBeenCalledOnce()
  socket.frame({ type: 'detached', reason: 'replaced' }); socket.onclose?.()
  expect(detached).toHaveBeenCalledExactlyOnceWith('replaced')
})
it('forwards continuation metadata before readiness and treats restore failure as detached', () => {
  vi.stubGlobal('WebSocket', Socket)
  const connection = new SshApi().openTerminal('original', 80, 24, undefined, undefined, { owner: 'owner-1234567890123', id: 'session-1234567890', attach: true })
  const socket = Socket.sockets[0]!, snapshot = vi.fn(), detached = vi.fn(), exit = vi.fn()
  connection.onSnapshot = snapshot; connection.onDetached = detached; connection.onExit = exit
  const continuity = { version: 1, normal: { scrollTop: 2, scrollBottom: 20 } }
  socket.frame({ type: 'snapshot', session: { id: 'session-1234567890' }, output: 'screen', format: 'state-v1', continuity })
  expect(snapshot).toHaveBeenCalledExactlyOnceWith({ id: 'session-1234567890' }, 'screen', 'state-v1', continuity)
  connection.send('unready'); expect(socket.sent).toEqual([])
  socket.frame({ type: 'detached', reason: 'restore failed' }); socket.onclose?.(); connection.send('late')
  expect(detached).toHaveBeenCalledExactlyOnceWith('restore failed'); expect(exit).not.toHaveBeenCalled()
  expect(socket.sent).toEqual([]); expect(Socket.sockets).toHaveLength(1)
})
it('distinguishes an old host from authentication or transport failure', async () => {
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }))
  await expect(new SshApi().listTerminals('owner')).rejects.toBeInstanceOf(TerminalCatalogUnsupportedError)
  fetchMock.mockResolvedValueOnce(new Response('{"error":"unauthorized"}', { status: 401 }))
  await expect(new SshApi().listTerminals('owner')).rejects.toThrow('unauthorized')
})
