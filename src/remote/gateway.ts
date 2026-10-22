import { createServer, request, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { RemoteReceipt } from './types.ts'
import { remotePage } from './page.ts'
import { RemoteFailureError } from './errors.ts'
import { WebSocket } from 'ws'
import { navigationClient } from './navigation-client.ts'
import type { HistoryRecord } from './history-cache.ts'

export interface HistoryOpening { type: 'snapshot'; cursor: number; records: HistoryRecord[]; hasMore: boolean; header: { id: string } }
const catalogMutation = (method: string) => /^(?:session\/(?:create|rename|fork|delete|prompt|cancel|command)|workspace\/)/.test(method)

/** One isolated browser origin per remote Host. All native and plugin HTTP/WS traffic shares it. */
export class RemoteGateway {
  private server: Server
  private sockets = new Set<Socket>()
  private tickets = new Map<string, { expires: number; sessionId?: string }>()
  private sessions = new Map<string, { expires: number; sessionId?: string; embedded?: boolean }>()
  private upstreamCookie = ''
  private requests = new Map<number, Set<Promise<void>>>()
  private drainWaiters = new Set<() => void>()
  origin = ''
  onCatalogChange: () => void = () => {}
  get upstreamOrigin(): string { return `http://127.0.0.1:${this.localPort}` }
  constructor(public localPort: number, readonly receipt: RemoteReceipt, readonly alias: string, readonly returnUrl: string,
    readonly hostId: string, readonly recoveryProof: string) {
    this.server = createServer((req, res) => { void this.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('Remote DSH is unavailable. The request was not replayed.')
    }) })
    this.server.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)) })
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head))
  }
  async start(): Promise<void> {
    await this.replaceTunnel(this.localPort)
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve() })
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Remote gateway did not start')
    this.origin = `http://127.0.0.1:${address.port}`
  }
  /** Reconnect only the carrier. The browser origin, session and pending-operation semantics stay stable. */
  async replaceTunnel(port: number): Promise<void> {
    const login = new URL(this.receipt.url); login.port = String(port)
    const response = await fetch(login, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    await response.body?.cancel()
    if (response.status !== 303) throw new Error('Remote DSH authentication handshake failed')
    const cookie = response.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')
    if (!cookie) throw new Error('Remote DSH did not issue an authenticated session')
    this.localPort = port; this.upstreamCookie = cookie
  }
  private retainRequest(port: number): () => void {
    let resolve!: () => void
    const settled = new Promise<void>(done => { resolve = done })
    let pending = this.requests.get(port)
    if (!pending) this.requests.set(port, pending = new Set())
    pending.add(settled)
    return () => {
      if (!pending.delete(settled)) return
      if (!pending.size) this.requests.delete(port)
      resolve()
    }
  }
  /** After switching the carrier, let already-dispatched HTTP operations finish
   * before retiring its old tunnel. A dead carrier still fails normally; no
   * request is retried. Disposal and a deadline bound the wait. */
  async drainRequests(port: number, timeoutMs = 30000): Promise<void> {
    const pending = [...(this.requests.get(port) ?? [])]
    if (!pending.length) return
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); this.drainWaiters.delete(finish); resolve() }
      const timer = setTimeout(finish, timeoutMs)
      this.drainWaiters.add(finish)
      void Promise.all(pending).then(finish)
    })
  }
  /** Only the authenticated local controller issues short-lived, single-use launch tickets. */
  launch(sessionId?: string): string {
    this.prune()
    const ticket = randomBytes(32).toString('base64url')
    this.tickets.set(ticket, { expires: Date.now() + 60000, sessionId })
    return `${this.origin}/?dsh-remote-ticket=${ticket}`
  }
  private prune(): void {
    for (const map of [this.tickets, this.sessions]) for (const [key, item] of map) if (item.expires < Date.now()) map.delete(key)
  }
  private cookieName(): string { return `dsh-remote-${new URL(this.origin).port}` }
  private authenticated(req: IncomingMessage): { sessionId?: string; embedded?: boolean } | undefined {
    if (req.headers.host !== new URL(this.origin).host || (req.headers.origin && req.headers.origin !== this.origin)
      || req.headers['sec-fetch-site'] === 'cross-site') return undefined
    const value = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(this.cookieName() + '='))?.split('=')[1]
    const session = value ? this.sessions.get(value) : undefined
    return session && session.expires > Date.now() ? session : undefined
  }
  private headers(req?: IncomingMessage): Record<string, string | string[] | undefined> {
    const headers: Record<string, string | string[] | undefined> = { ...req?.headers, host: new URL(this.upstreamOrigin).host, origin: this.upstreamOrigin, cookie: this.upstreamCookie }
    delete headers.authorization; delete headers['proxy-authorization']; delete headers['accept-encoding']
    delete headers['forwarded']; delete headers['x-forwarded-host']; delete headers['x-forwarded-for']
    return headers
  }
  async rpc<T>(method: string, args: object): Promise<T> {
    const port = this.localPort, release = this.retainRequest(port)
    const changesCatalog = catalogMutation(method)
    if (changesCatalog) this.onCatalogChange()
    try {
      const rpcId = randomUUID()
      const response = await fetch(`http://127.0.0.1:${port}/api/${method}`, {
        method: 'POST', headers: { Host: new URL(this.upstreamOrigin).host, Origin: this.upstreamOrigin, Cookie: this.upstreamCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }), signal: AbortSignal.timeout(30000),
      })
      if (!response.ok) throw new Error(`Remote DSH ${method} returned HTTP ${response.status}; not replayed`)
      const body = await response.json() as { rpcId?: string; result?: { ok: boolean; value?: T; error?: { message?: string; code?: string } } }
      if (body.rpcId !== rpcId || !body.result) throw new Error('Remote DSH returned an incompatible RPC response')
      if (!body.result.ok) throw new RemoteFailureError(body.result.error?.message ?? `Remote ${method} failed`, body.result.error?.code)
      return body.result.value as T
    } finally { if (changesCatalog) this.onCatalogChange(); release() }
  }
  async healthy(): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${this.localPort}/`, { headers: { Host: new URL(this.upstreamOrigin).host, Cookie: this.upstreamCookie }, signal: AbortSignal.timeout(2000), redirect: 'manual' })
      await response.body?.cancel(); return response.status === 200
    } catch { return false }
  }
  /** Read one baseline and release the observer; never activate a Session. */
  async workspaceSnapshot(): Promise<{ items: Array<{ workspaceId: string; sessionIds: string[] }>; archivedSessionIds: string[] }> {
    return this.baseline('workspace/follow', {}, frame => frame?.type === 'baseline' && Array.isArray(frame.value?.items)
      && Array.isArray(frame.value?.archivedSessionIds) ? frame.value : undefined)
  }
  /** Cold-safe history reads never start an Agent or replay an operation. */
  async historySnapshot(sessionId: string): Promise<HistoryOpening> {
    return this.baseline('session/follow', { request: { address: { kind: 'session', sessionId }, maxMessages: 500 } },
      frame => frame?.type === 'snapshot' && frame.header?.id === sessionId && Number.isSafeInteger(frame.cursor)
        && Array.isArray(frame.records) && typeof frame.hasMore === 'boolean' ? frame : undefined)
  }
  private baseline<T>(endpoint: string, args: object, read: (frame: any) => T | undefined): Promise<T> {
    return new Promise((resolve, reject) => {
      const streamId = randomUUID()
      const socket = new WebSocket(`ws://127.0.0.1:${this.localPort}/api/remote.mux`, {
        headers: { Host: new URL(this.upstreamOrigin).host, Origin: this.upstreamOrigin, Cookie: this.upstreamCookie },
        handshakeTimeout: 5000, maxPayload: 8 * 1024 * 1024,
      })
      let settled = false
      const finish = (cause?: Error, value?: Parameters<typeof resolve>[0]) => {
        if (settled) return
        settled = true; clearTimeout(deadline)
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'cancel', streamId })); socket.close()
        } else socket.terminate()
        if (cause) reject(cause); else resolve(value!)
      }
      const deadline = setTimeout(() => finish(new Error('Remote workspace catalog timed out')), 8000)
      socket.once('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } })))
      socket.on('message', bytes => {
        try {
          const frame = JSON.parse(bytes.toString())
          if (frame.streamId !== streamId) return
          const value = frame.type === 'item' ? read(frame.value) : undefined
          if (value !== undefined) finish(undefined, value)
          else if (frame.type === 'error' || frame.type === 'end') finish(new RemoteFailureError(
            `Remote ${endpoint} is unavailable${typeof frame.error?.code === 'string' ? ' (' + frame.error.code.slice(0, 80) + ')' : ''}`, frame.error?.code))
        } catch { finish(new Error('Remote workspace catalog is incompatible')) }
      })
      socket.once('error', () => finish(new Error('Remote workspace catalog is unavailable')))
      socket.once('close', () => finish(new Error('Remote workspace catalog disconnected')))
    })
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.origin || req.headers.host !== new URL(this.origin).host) { res.writeHead(403); res.end(); return }
    const url = new URL(req.url ?? '/', this.origin)
    const ticket = url.searchParams.get('dsh-remote-ticket')
    if (ticket && req.method === 'GET' && url.pathname === '/') {
      this.prune()
      const entry = this.tickets.get(ticket); this.tickets.delete(ticket)
      if (!entry) { res.writeHead(401); res.end('Remote launch link expired. Reopen the workspace.'); return }
      const key = randomBytes(32).toString('base64url')
      this.sessions.set(key, { expires: Date.now() + 86400000, sessionId: entry.sessionId, embedded: url.searchParams.get('dsh-remote-view') === 'desktop' })
      res.writeHead(303, { Location: '/', 'Set-Cookie': `${this.cookieName()}=${key}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`, 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' }); res.end(); return
    }
    const session = this.authenticated(req)
    if (!session) { res.writeHead(401); res.end('Reopen this remote workspace from the local DSH window.'); return }
    if (url.pathname === '/__dsh_remote/navigation-client.js' && req.method === 'GET' && session.embedded) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      res.end(`(${navigationClient.toString()})();`); return
    }
    if (url.pathname === '/__dsh_remote/status') {
      res.writeHead(200, { 'content-type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ready: await this.healthy() })); return
    }
    const port = this.localPort, release = this.retainRequest(port)
    const upstreamOrigin = `http://127.0.0.1:${port}`
    const changesCatalog = req.method === 'POST' && catalogMutation(url.pathname.replace(/^\/api\//, ''))
    if (changesCatalog) this.onCatalogChange()
    try {
      await new Promise<void>((resolve, reject) => {
        const upstream = request({ hostname: '127.0.0.1', port, path: req.url, method: req.method, headers: this.headers(req) }, incoming => {
          const headers = { ...incoming.headers }; delete headers['set-cookie']
          headers['referrer-policy'] = 'no-referrer'
          if (headers.location?.startsWith(upstreamOrigin)) headers.location = headers.location.slice(upstreamOrigin.length) || '/'
          const html = url.pathname === '/' && req.method === 'GET' && incoming.statusCode === 200 && String(headers['content-type']).includes('text/html')
          if (!html) { res.writeHead(incoming.statusCode ?? 502, headers); incoming.pipe(res); incoming.once('end', resolve); incoming.once('error', reject); return }
          const chunks: Buffer[] = []; let size = 0
          incoming.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 8 * 1024 * 1024) incoming.destroy(new Error('Remote HTML exceeded limit')); else chunks.push(chunk) })
          incoming.once('error', reject)
          incoming.once('end', () => {
            delete headers['content-length']; delete headers['content-encoding']; delete headers.etag
            headers['cache-control'] = 'no-store'
            // Consume navigation once; later reloads preserve the remote client's current session.
            const selected = session.sessionId; delete session.sessionId
            const body = remotePage(Buffer.concat(chunks).toString('utf8'), {
              alias: this.alias, returnUrl: this.returnUrl, hostId: this.hostId, recoveryProof: this.recoveryProof, sessionId: selected, embedded: session.embedded,
            })
            res.writeHead(incoming.statusCode ?? 200, headers); res.end(body); resolve()
          })
        })
        upstream.once('error', reject)
        req.once('aborted', () => { upstream.destroy(); resolve() })
        res.once('close', () => { upstream.destroy(); resolve() })
        req.pipe(upstream)
      })
    } finally { if (changesCatalog) this.onCatalogChange(); release() }
  }
  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.authenticated(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return }
    const upstream = request({ hostname: '127.0.0.1', port: this.localPort, path: req.url, headers: this.headers(req) })
    upstream.on('upgrade', (response, remote, remoteHead) => {
      const lines = Object.entries(response.headers).filter(([name]) => name !== 'set-cookie').flatMap(([name, values]) => (Array.isArray(values) ? values : [values]).map(value => `${name}: ${value}`))
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`)
      if (remoteHead.length) socket.write(remoteHead)
      if (head.length) remote.write(head)
      const close = () => { socket.destroy(); remote.destroy() }
      socket.once('error', close); remote.once('error', close); socket.once('close', close); remote.once('close', close)
      remote.pipe(socket).pipe(remote)
    })
    upstream.on('response', response => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Upstream unavailable\r\nConnection: close\r\n\r\n`) })
    upstream.on('error', () => socket.destroy())
    socket.once('close', () => upstream.destroy()); upstream.end()
  }
  dispose(): void {
    this.server.close(); for (const socket of this.sockets) socket.destroy()
    for (const finish of [...this.drainWaiters]) finish()
    this.sockets.clear(); this.sessions.clear(); this.tickets.clear(); this.upstreamCookie = ''
  }
}
