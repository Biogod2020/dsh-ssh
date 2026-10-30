/**
 * Local port-forward tunnels: one loopback-only listener per tunnel, pinned
 * to a pooled connection so an idle sweep never closes it, with per-tunnel
 * socket tracking and stop (single / alias-scoped / all).
 */

import { createServer, type Server as NetServer, type Socket } from 'node:net'
import type { ClientChannel } from 'ssh2'
import type { TunnelInfo } from '../protocol.ts'
import { acquire, disposeRecord, endRecordChain, type PoolEngine, type PoolRecord } from './connection-pool.ts'

/** One active tunnel record (server + pinned connection + live sockets). */
export interface TunnelRecord {
  workspace: boolean
  info: TunnelInfo
  server: NetServer
  alias: string
  /** The pooled connection this tunnel pins; siblings on one alias may share it. */
  record: PoolRecord
  sockets: Set<Socket>
}

/** The engine slice the tunnel module needs (adds the tunnel registry). */
export interface TunnelEngine extends PoolEngine {
  readonly tunnels: Map<string, TunnelRecord>
  nextTunnelId: number
}

/** Start a local port-forward tunnel (listens on 127.0.0.1 only). */
export async function startTunnel(
  engine: TunnelEngine,
  alias: string,
  options: { remotePort: number; remoteHost?: string; localPort?: number },
  workspace = false,
  expectedUpdatedAt?: number,
): Promise<TunnelInfo> {
  if (!Number.isInteger(options.remotePort) || options.remotePort < 1 || options.remotePort > 65535) {
    throw new Error('remotePort must be an integer in 1..65535')
  }
  if (options.localPort !== undefined && (!Number.isInteger(options.localPort) || options.localPort < 1 || options.localPort > 65535)) {
    throw new Error('localPort must be an integer in 1..65535')
  }
  const entry = engine.store.find(alias)
  if (entry === undefined) throw new Error('alias \'' + alias + '\' not found — add it first')
  const reviewedUpdatedAt = expectedUpdatedAt ?? entry.updatedAt
  const checkOwner = () => {
    if (engine.disposed) throw new Error('SSH engine is closed; no tunnel was opened')
    if (engine.store.find(alias)?.updatedAt !== reviewedUpdatedAt) throw new Error('Host settings changed; no tunnel was opened')
  }
  checkOwner()
  const remoteHost = options.remoteHost ?? '127.0.0.1'
  const id = 'tun-' + engine.nextTunnelId
  engine.nextTunnelId += 1
  const info: TunnelInfo = {
    id,
    alias,
    localPort: 0,
    remoteHost,
    remotePort: options.remotePort,
    state: 'connecting',
    startedAt: Date.now(),
  }
  // Reuse the live pooled connection when one exists so sibling tunnels on
  // one alias multiplex over it (and no orphaned connection leaks); recycle
  // a broken one first.
  const existing = engine.pool.get(alias)
  if (existing !== undefined && existing.broken) disposeRecord(engine, alias, existing)
  const record = engine.pool.get(alias) ?? (await acquire(engine, alias))
  checkOwner()
  const client = record.client
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    socket.setNoDelay(true)
    sockets.add(socket)
    let channel: ClientChannel | undefined
    const destroy = (): void => {
      try { socket.destroy() } catch { /* gone */ }
      const current = channel
      channel = undefined
      try { current?.close() } catch { /* gone */ }
    }
    // The local peer may fail while forwardOut is still waiting for SSH.
    socket.on('error', destroy)
    socket.on('close', () => { sockets.delete(socket); destroy() })
    try {
      client.forwardOut('127.0.0.1', 0, remoteHost, options.remotePort, (error, stream) => {
        if (error !== undefined) { destroy(); return }
        channel = stream
        stream.on('error', destroy)
        stream.on('close', destroy)
        if (socket.destroyed) { destroy(); return }
        stream.pipe(socket).pipe(stream)
      })
    } catch {
      // ssh2 throws synchronously when its transport closes before this
      // accept callback. Fail only this socket; never replay its request.
      destroy()
    }
  })
  const closeListener = (): void => {
    try { server.close() } catch { /* not listening or already closed */ }
    for (const socket of sockets) {
      try { socket.destroy() } catch { /* already closed */ }
    }
    sockets.clear()
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.localPort ?? 0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    // Binding is asynchronous. Disposal, host edits or record replacement can
    // occur while this listener is not yet registered in engine.tunnels.
    checkOwner()
    if (record.broken || engine.pool.get(alias) !== record) throw new Error('SSH connection changed while opening tunnel; no tunnel was opened')
  } catch (error) {
    closeListener()
    // Roll back: never leave an unpinned orphan connection behind.
    if (!record.pinned && record.inFlight === 0) disposeRecord(engine, alias, record)
    throw error
  }
  record.pinned = true
  const address = server.address()
  info.localPort = typeof address === 'object' && address !== null ? address.port : 0
  info.state = 'forwarding'
  engine.tunnels.set(id, { info, server, alias, record, sockets, workspace })
  return info
}

/** All active tunnels. */
export function listTunnels(engine: TunnelEngine): TunnelInfo[] {
  return [...engine.tunnels.values()].filter(tunnel => !tunnel.workspace).map(tunnel => ({ ...tunnel.info }))
}

/** Stop one tunnel (closes the listener, live sockets, and the pinned connection). */
export function stopTunnel(engine: TunnelEngine, id: string, includeWorkspace = false): boolean {
  const tunnel = engine.tunnels.get(id)
  if (tunnel === undefined || (tunnel.workspace && !includeWorkspace)) return false
  engine.tunnels.delete(id)
  try { tunnel.server.close() } catch { /* already closed */ }
  for (const socket of tunnel.sockets) {
    try { socket.destroy() } catch { /* already closed */ }
  }
  tunnel.sockets.clear()
  // Sibling tunnels on the same alias share the pinned connection: release it
  // only once the last tunnel using it is gone. A record the pool has since
  // replaced (e.g. after a broken-connection recycle) is ended directly.
  const shared = [...engine.tunnels.values()].some(candidate => candidate.record === tunnel.record)
  if (!shared) {
    tunnel.record.pinned = false
    if (engine.pool.get(tunnel.alias) === tunnel.record && tunnel.record.inFlight > 0) tunnel.record.idleAt = Date.now()
    else if (engine.pool.get(tunnel.alias) === tunnel.record) disposeRecord(engine, tunnel.alias, tunnel.record)
    else endRecordChain(tunnel.record)
  }
  return true
}

/** Stop all tunnels (optionally for one alias). */
export function stopAllTunnels(engine: TunnelEngine, alias?: string, includeWorkspace = false): number {
  let count = 0
  for (const [id, tunnel] of [...engine.tunnels]) {
    if ((alias === undefined || tunnel.alias === alias) && (includeWorkspace || !tunnel.workspace)) {
      stopTunnel(engine, id, includeWorkspace)
      count += 1
    }
  }
  return count
}
