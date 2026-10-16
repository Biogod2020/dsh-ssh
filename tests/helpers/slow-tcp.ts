/** Local TCP pacing for visual SSH transfer tests; forwards to generated sshd only. */
import { connect, createServer, type Socket } from 'node:net'
import { Transform, type TransformCallback } from 'node:stream'

class Pace extends Transform {
  private timer?: ReturnType<typeof setTimeout>
  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    let offset = 0
    const next = (): void => {
      if (this.destroyed) return
      this.push(chunk.subarray(offset, offset + 8192)); offset += 8192
      if (offset >= chunk.length) callback()
      else this.timer = setTimeout(next, 35)
    }
    this.timer = setTimeout(next, 35)
  }
  _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    clearTimeout(this.timer); callback(error)
  }
}

export async function slowTcp(targetPort: number): Promise<{ port: number; close: () => void }> {
  const sockets = new Set<Socket>()
  const server = createServer(incoming => {
    const outgoing = connect(targetPort, '127.0.0.1'), up = new Pace(), down = new Pace()
    sockets.add(incoming); sockets.add(outgoing)
    const close = (): void => {
      up.destroy(); down.destroy(); incoming.destroy(); outgoing.destroy()
      sockets.delete(incoming); sockets.delete(outgoing)
    }
    incoming.on('error', close); outgoing.on('error', close)
    incoming.once('close', close); outgoing.once('close', close)
    incoming.pipe(up).pipe(outgoing); outgoing.pipe(down).pipe(incoming)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { port, close: () => { server.close(); for (const socket of sockets) socket.destroy() } }
}
