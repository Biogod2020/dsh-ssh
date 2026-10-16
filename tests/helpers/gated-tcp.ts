/** Hold SSH establishment before forwarding to a generated localhost sshd. */
import { connect, createServer, type Socket } from 'node:net'

export async function gatedTcp(targetPort: number) {
  interface Peer { incoming: Socket; outgoing?: Socket; initial: Buffer[]; buffer: (data: Buffer) => void }
  const peers = new Set<Peer>()
  let holding = true, accepted = 0
  const start = (peer: Peer): void => {
    if (peer.outgoing || peer.incoming.destroyed) return
    const outgoing = connect(targetPort, '127.0.0.1')
    peer.outgoing = outgoing
    peer.incoming.off('data', peer.buffer)
    for (const chunk of peer.initial) outgoing.write(chunk)
    peer.initial = []
    outgoing.on('error', () => peer.incoming.destroy())
    outgoing.once('close', () => peer.incoming.destroy())
    peer.incoming.pipe(outgoing); outgoing.pipe(peer.incoming)
  }
  const server = createServer(incoming => {
    const peer: Peer = { incoming, initial: [], buffer: data => peer.initial.push(data) }
    peers.add(peer); accepted += 1
    // Drain the client's initial identification bytes so FIN/close is
    // observable while held. Pausing a readable with unread bytes would
    // hide the peer's close and falsely report a leaked connection.
    incoming.on('data', peer.buffer)
    incoming.on('error', () => incoming.destroy())
    incoming.once('close', () => { peer.outgoing?.destroy(); peers.delete(peer) })
    if (!holding) start(peer)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as { port: number }).port,
    get activeConnections() { return peers.size },
    get acceptedConnections() { return accepted },
    get holding() { return holding },
    hold() { holding = true },
    release() { holding = false; for (const peer of peers) start(peer) },
    async close() {
      const closed = new Promise<void>(resolve => server.close(() => resolve()))
      for (const peer of peers) { peer.incoming.destroy(); peer.outgoing?.destroy() }
      await closed
      // Server close can resolve before each socket's local close listener.
      // Every owned transport is already destroyed; clear diagnostic records.
      peers.clear()
    },
  }
}
