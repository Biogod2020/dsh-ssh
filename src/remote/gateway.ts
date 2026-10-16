import { createServer, request, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { RemoteReceipt } from './types.ts'
import { remotePage } from './page.ts'
import { RemoteFailureError } from './errors.ts'

/** One isolated browser origin per remote Host. All native and plugin HTTP/WS traffic shares it. */
export class RemoteGateway {
  private server: Server
  private sockets = new Set<Socket>()
  private tickets = new Map<string, { expires: number; sessionId?: string }>()
  private sessions = new Map<string, { expires: number; sessionId?: string }>()
  private upstreamCookie = ''
  origin = ''
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
  private authenticated(req: IncomingMessage): { sessionId?: string } | undefined {
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
    const rpcId = randomUUID()
    const response = await fetch(`http://127.0.0.1:${this.localPort}/api/${method}`, {
      method: 'POST', headers: { Host: new URL(this.upstreamOrigin).host, Origin: this.upstreamOrigin, Cookie: this.upstreamCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }), signal: AbortSignal.timeout(30000),
    })
    if (!response.ok) throw new Error(`Remote DSH ${method} returned HTTP ${response.status}; not replayed`)
    const body = await response.json() as { rpcId?: string; result?: { ok: boolean; value?: T; error?: { message?: string; code?: string } } }
    if (body.rpcId !== rpcId || !body.result) throw new Error('Remote DSH returned an incompatible RPC response')
    if (!body.result.ok) throw new RemoteFailureError(body.result.error?.message ?? `Remote ${method} failed`, body.result.error?.code)
    return body.result.value as T
  }
  async healthy(): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${this.localPort}/`, { headers: { Host: new URL(this.upstreamOrigin).host, Cookie: this.upstreamCookie }, signal: AbortSignal.timeout(2000), redirect: 'manual' })
      await response.body?.cancel(); return response.status === 200
    } catch { return false }
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
      this.sessions.set(key, { expires: Date.now() + 86400000, sessionId: entry.sessionId })
      res.writeHead(303, { Location: '/', 'Set-Cookie': `${this.cookieName()}=${key}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`, 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' }); res.end(); return
    }
    const session = this.authenticated(req)
    if (!session) { res.writeHead(401); res.end('Reopen this remote workspace from the local DSH window.'); return }
    if (url.pathname === '/__dsh_remote/status') {
      res.writeHead(200, { 'content-type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ready: await this.healthy() })); return
    }
    await new Promise<void>((resolve, reject) => {
      const upstream = request({ hostname: '127.0.0.1', port: this.localPort, path: req.url, method: req.method, headers: this.headers(req) }, incoming => {
        const headers = { ...incoming.headers }; delete headers['set-cookie']
        headers['referrer-policy'] = 'no-referrer'
        if (headers.location?.startsWith(this.upstreamOrigin)) headers.location = headers.location.slice(this.upstreamOrigin.length) || '/'
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
            alias: this.alias, returnUrl: this.returnUrl, hostId: this.hostId, recoveryProof: this.recoveryProof, sessionId: selected,
          })
          res.writeHead(incoming.statusCode ?? 200, headers); res.end(body); resolve()
        })
      })
      upstream.once('error', reject)
      req.once('aborted', () => upstream.destroy())
      res.once('close', () => upstream.destroy())
      req.pipe(upstream)
    })
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
    this.sockets.clear(); this.sessions.clear(); this.tickets.clear(); this.upstreamCookie = ''
  }
}
