import { createServer, request, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { RemoteReceipt } from './types.ts'
import { remotePage } from './page.ts'
import { RemoteFailureError } from './errors.ts'
import { parseSessionActivity } from './session-activity.ts'
import { WebSocket } from 'ws'
import { navigationClient } from './navigation-client.ts'
import type { HistoryRecord } from './history-cache.ts'
import { LocalDraftStore, DraftConflictError, type DraftWrite } from './draft-store.ts'
import { readJsonBody } from '../http.ts'
import { draftClient, seedDraft, type DraftSeed } from './draft-client.ts'
import { createDraftReplica } from './draft-replica.ts'
import { watchCatalogPulse } from './catalog-pulse.ts'
import { WorkspaceDirectoryProjection, type WorkspaceDirectory } from './workspace-directory.ts'
import { CatalogReadError, catalogJsonLimit, catalogJsonReader, readCatalogJson, runCatalogRead, type CatalogReadPriority } from './catalog-json.ts'
import { ViewReceiptStore, type ViewReceiptInput } from './view-receipts.ts'
import { operationClient } from './operation-client.ts'
import { bootAssetPath, BootAssetCache, bootAssetEntryLimit } from './boot-assets.ts'
import type { BootArtifact, BootRead } from './boot-reader.ts'
import { gunzipSync } from 'node:zlib'

export const modelCatalogReadTimeoutMs = 15000

/** Immutable version URLs can be revalidated locally. Browser reload headers
 * must not force the native multi-megabyte representation across SSH again. */
function bootNotModified(req: IncomingMessage, etag?: string): boolean {
  const value = req.headers['if-none-match']
  if (typeof value !== 'string') return false
  return (value.match(/(?:W\/)?"[^"]*"|\*/g) ?? []).some(tag => tag === '*' || !!etag && tag.replace(/^W\//, '') === etag.replace(/^W\//, ''))
}

export interface HistoryOpening { type: 'snapshot'; cursor: number; records: HistoryRecord[]; hasMore: boolean; header: { id: string } }
const catalogMutation = (method: string) => /^(?:session\/(?:create|rename|fork|delete|prompt|cancel|command)|workspace\/)/.test(method)
interface BrowserSession { expires:number; sessionId?:string; embedded?:boolean; origin:string; pending?:number; channel?:string; unsafeSockets?:number; frozen?:string; freezeTimer?:ReturnType<typeof setTimeout>; uplinks?:Set<Duplex> }

/** The only upstream error detail allowed across the SSH plugin boundary. */
function archiveActivity(method: string, args: object, error: unknown) {
  if (method !== 'workspace/archiveSession') return undefined
  const request = args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as { request?: unknown }).request : undefined
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return undefined
  const { sessionId, stopActivity } = request as { sessionId?: unknown; stopActivity?: unknown }
  if (typeof sessionId !== 'string' || stopActivity === true || error === null || typeof error !== 'object' || Array.isArray(error)) return undefined
  const { code, details } = error as { code?: unknown; details?: unknown }
  if (code !== 'workspace/session-active' || details === null || typeof details !== 'object' || Array.isArray(details)) return undefined
  const { sessionId: refusedSessionId, activity } = details as { sessionId?: unknown; activity?: unknown }
  return refusedSessionId === sessionId ? parseSessionActivity(activity) : undefined
}

/** One isolated browser origin per remote Host. All native and plugin HTTP/WS traffic shares it. */
export class RemoteGateway {
  private server: Server
  private sockets = new Set<Socket>()
  private tickets = new Map<string, { expires: number; sessionId?: string; origin: string }>()
  private sessions = new Map<string, BrowserSession>()
  private upstreamCookie = ''
  private requests = new Map<number, Set<Promise<void>>>()
  private drainWaiters = new Set<() => void>()
  private streams = new Map<number, Set<() => void>>()
  private retired = new Map<number, { stop(): void; drained: boolean }>()
  private healthRead?: { port: number; controller: AbortController; promise: Promise<boolean> }
  private healthSnapshot?: {port:number;at:number}
  private disposed = false
  private bootReads = new Map<string, Promise<BootArtifact>>()
  private bootActive = 0
  private bootWaiters: Array<() => void> = []
  private catalogLifetime = new AbortController()
  private workspaceFollower?: { projection: WorkspaceDirectoryProjection; first: Promise<WorkspaceDirectory>; lifetime: AbortController; priority: CatalogReadPriority }
  origin = ''
  onCatalogChange: () => void = () => {}
  get upstreamOrigin(): string { return `http://127.0.0.1:${this.localPort}` }
  constructor(public localPort: number, readonly receipt: RemoteReceipt, readonly alias: string, readonly returnUrl: string,
    readonly hostId: string, readonly recoveryProof: string, private readonly drafts?: LocalDraftStore, private readonly viewReceipts?: ViewReceiptStore,
    private readonly bootAssets?: BootAssetCache, private readonly readBoot?: (input: BootRead) => Promise<BootArtifact>) {
    // Browser cookies are scoped to a hostname, not a port. Native DSH
    // sessions on other loopback ports therefore accompany this gateway's
    // own cookie. Leave bounded room for them plus the official batched
    // plugin URL; the default 16 KiB parser limit can reject that batch
    // before authentication/routing and force dozens of serial fallbacks.
    this.server = createServer({ maxHeaderSize: 64 * 1024 }, (req, res) => { void this.handle(req, res).catch(() => {
      if (res.headersSent) { res.destroy(); return }
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('Remote DSH is unavailable. The request was not replayed.')
    }) })
    this.server.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)) })
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head))
  }
  async start(preferredPort?: number): Promise<void> {
    if (preferredPort !== undefined && (!Number.isInteger(preferredPort) || preferredPort < 1024 || preferredPort > 65535)) throw Error('Invalid saved gateway port')
    await this.replaceTunnel(this.localPort)
    const listen = (port: number) => new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, '127.0.0.1', () => { this.server.off('error', reject); resolve() })
    })
    try { await listen(preferredPort ?? 0) }
    catch (error) { if (preferredPort === undefined || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; await listen(0) }
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
    if (this.disposed) throw new DOMException('Remote gateway was disposed', 'AbortError')
    // Publish the complete carrier before notifying observers. Detach the
    // old follower first so its synchronous abort cannot erase a rebuilt one.
    const follower = this.workspaceFollower
    this.workspaceFollower = undefined
    this.localPort = port; this.upstreamCookie = cookie
    this.healthSnapshot = undefined
    follower?.lifetime.abort()
    this.onCatalogChange()
  }
  /** Bound retained carriers without evicting live terminals to make room. */
  canReplaceTunnel(): boolean { return this.retired.size < 2 || !this.streams.get(this.localPort)?.size }
  private releaseRetired(port: number): void {
    const old = this.retired.get(port)
    if (!old || !old.drained || this.streams.get(port)?.size) return
    this.retired.delete(port); old.stop()
  }
  /** HTTP writes have a bounded grace period; live upgraded streams own their
   * original carrier until they close. Nothing is migrated or replayed. */
  async retireTunnel(port: number, stop: () => void): Promise<void> {
    if (this.disposed) { stop(); return }
    const old = { stop, drained: false }
    this.retired.set(port, old)
    await this.drainRequests(port)
    if (this.retired.get(port) !== old) return
    old.drained = true; this.releaseRetired(port)
  }
  private retainStream(port: number): () => void {
    let entries = this.streams.get(port)
    if (!entries) this.streams.set(port, entries = new Set())
    const release = () => {
      if (!entries.delete(release)) return
      if (!entries.size) this.streams.delete(port)
      this.releaseRetired(port)
    }
    entries.add(release); return release
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
  launch(sessionId?: string, hostname: '127.0.0.1' | 'localhost' = '127.0.0.1'): string {
    this.prune()
    if (hostname !== '127.0.0.1' && hostname !== 'localhost') throw new Error('Invalid gateway hostname')
    const target = new URL(this.origin); target.hostname = hostname
    const ticket = randomBytes(32).toString('base64url')
    this.tickets.set(ticket, { expires: Date.now() + 60000, sessionId, origin: target.origin })
    return `${target.origin}/?dsh-remote-ticket=${ticket}`
  }
  private prune(): void {
    for (const map of [this.tickets, this.sessions]) for (const [key, item] of map) if (item.expires < Date.now()) map.delete(key)
  }
  private cookieName(): string { return `dsh-remote-${new URL(this.origin).port}` }
  private async prepareBoot(input: BootRead): Promise<BootArtifact> {
    await new Promise<void>(resolve => {
      const begin = () => { this.bootActive++; resolve() }
      if (this.bootActive < 2) begin(); else this.bootWaiters.push(begin)
    })
    try { if (this.disposed) throw Error('Static view released'); return await this.readBoot!(input) }
    finally { this.bootActive--; this.bootWaiters.shift()?.() }
  }
  private requestOrigin(req: IncomingMessage): string | undefined {
    const target = new URL(this.origin)
    if (req.headers.host === target.host) return target.origin
    target.hostname = 'localhost'
    return req.headers.host === target.host ? target.origin : undefined
  }
  private authenticated(req: IncomingMessage): BrowserSession | undefined {
    const origin = this.requestOrigin(req)
    if (!origin || (req.headers.origin && req.headers.origin !== origin)
      || req.headers['sec-fetch-site'] === 'cross-site') return undefined
    const value = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(this.cookieName() + '='))?.split('=')[1]
    const session = value ? this.sessions.get(value) : undefined
    return session && session.origin === origin && session.expires > Date.now() ? session : undefined
  }
  private headers(req?: IncomingMessage, identity = false): Record<string, string | string[] | undefined> {
    const headers: Record<string, string | string[] | undefined> = { ...req?.headers, host: new URL(this.upstreamOrigin).host, origin: this.upstreamOrigin, cookie: this.upstreamCookie }
    delete headers.authorization; delete headers['proxy-authorization']
    // Only the rewritten HTML needs identity bytes. Static assets and RPC
    // bodies pass through unchanged, including their compression headers.
    if (identity) delete headers['accept-encoding']
    delete headers['forwarded']; delete headers['x-forwarded-host']; delete headers['x-forwarded-for']
    return headers
  }
  async rpc<T>(method: string, args: object, timeoutMs = 30000, priority: boolean | CatalogReadPriority = false): Promise<T> {
    if (method === 'session/list') return runCatalogRead(this.hostId, this.catalogLifetime.signal, () => this.rpcRequest<T>(method, args).catch(error => {
      if (error instanceof TypeError) throw new CatalogReadError('transport')
      throw error
    }), priority)
    return this.rpcRequest<T>(method, args, timeoutMs)
  }
  private async rpcRequest<T>(method: string, args: object, timeoutMs = 30000): Promise<T> {
    const port = this.localPort, release = this.retainRequest(port)
    const changesCatalog = catalogMutation(method)
    if (changesCatalog) this.onCatalogChange()
    try {
      const rpcId = randomUUID()
      const readOnlyCatalog = method === 'session/list'
      const signal = readOnlyCatalog ? AbortSignal.any([this.catalogLifetime.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(timeoutMs)
      const response = await fetch(`http://127.0.0.1:${port}/api/${method}`, {
        method: 'POST', headers: { Host: new URL(this.upstreamOrigin).host, Origin: this.upstreamOrigin, Cookie: this.upstreamCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }), signal,
      })
      if (!response.ok) {
        await response.body?.cancel()
        if (readOnlyCatalog && [401,403].includes(response.status)) throw new CatalogReadError('auth')
        if (readOnlyCatalog && [502,503,504].includes(response.status)) throw new CatalogReadError('transport')
        throw new Error(`Remote DSH ${method} returned HTTP ${response.status}; not replayed`)
      }
      const body = (readOnlyCatalog ? await readCatalogJson(response, signal) : await response.json()) as { rpcId?: string; result?: { ok: boolean; value?: T; error?: { message?: string; code?: string; details?: unknown } } }
      if (body.rpcId !== rpcId || !body.result) throw new Error('Remote DSH returned an incompatible RPC response')
      if (!body.result.ok) {
        const activity = archiveActivity(method, args, body.result.error)
        throw new RemoteFailureError(body.result.error?.message ?? `Remote ${method} failed`, body.result.error?.code, activity)
      }
      this.noteTraffic(port)
      return body.result.value as T
    } finally { if (changesCatalog) this.onCatalogChange(); release() }
  }
  /** Model secrets cross this private SSH carrier only; errors never echo bodies. */
  async modelBridge<T>(payload: object): Promise<T> {
    const port = this.localPort, release = this.retainRequest(port)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/dsh-ssh-model-follow`, {
        method: 'POST', headers: { Host: this.upstreamOrigin.slice(7), Origin: this.upstreamOrigin, Cookie: this.upstreamCookie, 'content-type': 'application/json' },
        body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(60000),
      })
      if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error('Model bridge request was not confirmed'), { status: response.status }) }
      const body = await response.text()
      if (body.length > 512 * 1024) throw new Error('Invalid model sync response')
      return JSON.parse(body) as T
    } finally { release() }
  }
  private noteTraffic(port: number): void {
    if (!this.disposed && this.localPort === port) this.healthSnapshot = { port, at: Date.now() }
  }
  healthy(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    const port = this.localPort
    if(this.healthSnapshot?.port===port&&Date.now()-this.healthSnapshot.at<2500)return Promise.resolve(true)
    if (this.healthRead?.port === port) return this.healthRead.promise
    const controller = new AbortController()
    const started = Date.now()
    const trafficDuringProbe = () => !this.disposed && this.localPort === port && this.healthSnapshot?.port === port && this.healthSnapshot.at >= started
    const read = { port, controller, promise: undefined as unknown as Promise<boolean> }
    read.promise = (async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { Host: `127.0.0.1:${port}`, Cookie: this.upstreamCookie }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]), redirect: 'manual' })
        await response.body?.cancel()
        if(response.status===200)this.noteTraffic(port)
        return response.status === 200 || trafficDuringProbe()
      } catch { return trafficDuringProbe() }
      finally { if (this.healthRead === read) this.healthRead = undefined }
    })()
    this.healthRead = read; return read.promise
  }
  /** Read one baseline and release the observer; never activate a Session. */
  async workspaceSnapshot(): Promise<{ items: Array<{ workspaceId: string; sessionIds: string[] }>; archivedSessionIds: string[] }> {
    return this.baseline('workspace/follow', {}, frame => frame?.type === 'baseline' && Array.isArray(frame.value?.items)
      && Array.isArray(frame.value?.archivedSessionIds) ? frame.value : undefined)
  }
  /** One read-only live membership feed per Host. The read lane is released
   * after its baseline, while later snapshots reuse ordered increments. */
  prioritizeCatalog(): void { if (this.workspaceFollower) this.workspaceFollower.priority.foreground = true }
  workspaceCatalogSnapshot(priority: CatalogReadPriority = { foreground: false }): Promise<WorkspaceDirectory> {
    if (this.disposed) return Promise.reject(new DOMException('Remote gateway was disposed', 'AbortError'))
    const current = this.workspaceFollower
    if (current) { if (priority.foreground) current.priority.foreground = true; return current.projection.snapshot() ? Promise.resolve(current.projection.snapshot()!) : current.first }
    const lifetime = new AbortController(), projection = new WorkspaceDirectoryProjection()
    const follower = { projection, lifetime, priority, first: undefined as unknown as Promise<WorkspaceDirectory> }
    this.workspaceFollower = follower
    const signal = AbortSignal.any([lifetime.signal, this.catalogLifetime.signal])
    const closed = () => {
      if (this.workspaceFollower !== follower) return
      this.workspaceFollower = undefined
      if (!this.disposed) this.onCatalogChange()
    }
    follower.first = runCatalogRead(this.hostId, signal, () => this.baselineRequest('workspace/follow', {}, frame => projection.accept(frame), {
      signal, changed: () => { if (this.workspaceFollower === follower) this.onCatalogChange() }, closed,
    }), priority).catch(error => { closed(); throw error })
    return follower.first
  }
  /** Cold-safe history reads never start an Agent or replay an operation. */
  async historySnapshot(sessionId: string): Promise<HistoryOpening> {
    return this.baseline('session/follow', { request: { address: { kind: 'session', sessionId }, maxMessages: 500 } },
      frame => frame?.type === 'snapshot' && frame.header?.id === sessionId && Number.isSafeInteger(frame.cursor)
        && Array.isArray(frame.records) && typeof frame.hasMore === 'boolean' ? frame : undefined)
  }
  private baseline<T>(endpoint: string, args: object, read: (frame: any) => T | undefined): Promise<T> {
    return runCatalogRead(this.hostId, this.catalogLifetime.signal, () => this.baselineRequest(endpoint, args, read), endpoint === 'session/follow')
  }
  private baselineRequest<T>(endpoint: string, args: object, read: (frame: any) => T | undefined, follow?: { signal: AbortSignal; changed(): void; closed(): void }): Promise<T> {
    return new Promise((resolve, reject) => {
      const streamId = randomUUID(), port = this.localPort, release = this.retainStream(port)
      const origin = `http://127.0.0.1:${port}`
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/remote.mux`, {
        headers: { Host: new URL(origin).host, Origin: origin, Cookie: this.upstreamCookie },
        handshakeTimeout: 5000, maxPayload: 8 * 1024 * 1024,
      })
      let settled = false, delivered = false
      let stopPulse: (() => void) | undefined
      const signal = follow?.signal ?? this.catalogLifetime.signal
      let decoding = false, buffered = 0
      const frames: Buffer[] = []
      const parsing = new AbortController()
      const disposed = () => finish(new DOMException('Remote catalog observer was disposed', 'AbortError'))
      const finish = (cause?: Error, value?: Parameters<typeof resolve>[0]) => {
        if (settled) return
        settled = true; clearTimeout(deadline); parsing.abort(); signal.removeEventListener('abort', disposed)
        stopPulse?.(); frames.length = 0; buffered = 0
        if (socket.readyState === WebSocket.OPEN) {
          // Resume the transport for its close handshake after decoding. A
          // paused observer must not keep the retired SSH carrier alive.
          socket.resume()
          const closing = setTimeout(() => socket.terminate(), 1000); closing.unref()
          socket.once('close', () => clearTimeout(closing))
          socket.send(JSON.stringify({ type: 'cancel', streamId })); socket.close()
        } else socket.terminate()
        follow?.closed()
        if (!delivered) { if (cause) reject(cause); else resolve(value!) }
      }
      const deadline = setTimeout(() => finish(new Error('Remote workspace catalog timed out')), 8000)
      signal.addEventListener('abort', disposed, { once: true })
      socket.once('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } })))
      const decode = async () => {
        if (decoding || settled) return
        decoding = true
        try { while (frames.length && !settled) {
          const bytes = frames.shift()!
          const frame = await catalogJsonReader.parse(bytes, AbortSignal.any([parsing.signal, signal])) as any
          buffered = Math.max(0, buffered - bytes.length)
          if (settled) return
          if (frame.streamId !== streamId) continue
          const value = frame.type === 'item' ? read(frame.value) : undefined
          if (value !== undefined) {
            this.noteTraffic(port)
            if (!follow) finish(undefined, value)
            else if (!delivered) { delivered = true; clearTimeout(deadline); stopPulse = watchCatalogPulse(socket, error => finish(error)); resolve(value) }
            else follow.changed()
          }
          else if (frame.type === 'error' || frame.type === 'end') finish(new RemoteFailureError(
            `Remote ${endpoint} is unavailable${typeof frame.error?.code === 'string' ? ' (' + frame.error.code.slice(0, 80) + ')' : ''}`, frame.error?.code))
        } } catch(error) { finish(error instanceof Error ? error : new Error('Remote workspace catalog is incompatible')) }
        finally { decoding = false; if (!settled) socket.resume() }
      }
      socket.on('message', bytes => {
        if (settled) return
        const frame = Buffer.isBuffer(bytes) ? bytes : Array.isArray(bytes) ? Buffer.concat(bytes) : Buffer.from(bytes)
        if (buffered + frame.length > 2 * catalogJsonLimit || frames.length >= 256) {
          finish(new CatalogReadError('backlog')); return
        }
        buffered += frame.length; frames.push(frame)
        socket.pause()
        void decode()
      })
      socket.once('unexpected-response', (_request, response) => {
        response.resume(); release(); socket.terminate()
        finish(new CatalogReadError([401,403].includes(response.statusCode ?? 0) ? 'auth' : 'transport'))
      })
      socket.once('error', () => { release(); finish(new CatalogReadError('transport')) })
      socket.once('close', () => { release(); finish(new CatalogReadError('transport')) })
      if (signal.aborted) disposed()
    })
  }
  private async handle(req: IncomingMessage, res: ServerResponse, bootRecovery = 0): Promise<void> {
    const origin = this.origin && this.requestOrigin(req)
    if (!origin) { res.writeHead(403); res.end(); return }
    const url = new URL(req.url ?? '/', origin)
    const ticket = url.searchParams.get('dsh-remote-ticket')
    if (ticket && req.method === 'GET' && url.pathname === '/') {
      this.prune()
      const entry = this.tickets.get(ticket)
      if (!entry || entry.origin !== origin) { res.writeHead(401); res.end('Remote launch link expired. Reopen the workspace.'); return }
      this.tickets.delete(ticket)
      const key = randomBytes(32).toString('base64url')
      this.sessions.set(key, { expires: Date.now() + 86400000, sessionId: entry.sessionId, embedded: url.searchParams.get('dsh-remote-view') === 'desktop', origin })
      res.writeHead(303, { Location: '/', 'Set-Cookie': `${this.cookieName()}=${key}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`, 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' }); res.end(); return
    }
    const session = this.authenticated(req)
    if (!session) { res.writeHead(401); res.end('Reopen this remote workspace from the local DSH window.'); return }
    const assetRead = req.method === 'GET' && !req.headers.range && !req.headers['if-match'] && !req.headers['if-unmodified-since'] && bootAssetPath(url)
    const assetScope = `${this.hostId}:${this.receipt.version}:compact-images-1`, assetEncoding = String(req.headers['accept-encoding'] ?? '')
    if (assetRead && this.bootAssets) {
      const asset = await this.bootAssets.read(assetScope, url, assetEncoding)
      if (asset) {
        const headers = { ...asset.headers, 'x-content-type-options': 'nosniff' }
        if (bootNotModified(req, asset.headers.etag)) { res.writeHead(304, headers); res.end() }
        else { res.writeHead(200, { ...headers, 'content-length': asset.body.length }); res.end(asset.body) }
        return
      }
    }
    const image = /^\/__dsh_remote\/boot-image\/([a-f0-9]{64})\.png$/.exec(url.pathname)
    if (this.readBoot && req.method === 'GET' && (image || assetRead && url.pathname === '/plugins/' && url.search.includes('/dsh-client-ui-settings-account/client.js'))) {
      let input: BootRead | undefined
      if (image) {
        const encoded = url.searchParams.get('source') ?? '', path = Buffer.from(encoded, 'base64url').toString('utf8'), source = new URL(path, this.origin)
        if (/^[A-Za-z0-9_-]{1,12000}$/.test(encoded) && url.searchParams.size === 1 && bootAssetPath(source) && source.pathname === '/plugins/' && path === source.pathname + source.search) input = { source: path, image: image[1] }
      } else input = { source: url.pathname + url.search }
      if (!input) { res.writeHead(400); res.end(); return }
      const key = JSON.stringify(input)
      let read = this.bootReads.get(key)
      if (!read && this.bootReads.size < 32) { read = this.prepareBoot(input); this.bootReads.set(key, read) }
      try {
        if (!read) throw Error('Static read limit')
        const artifact = await read
        let bytes = Buffer.from(artifact.body, 'base64')
        if (bytes.length > bootAssetEntryLimit || artifact.kind !== (image ? 'image' : 'code') || artifact.mime !== (image ? 'image/png' : 'text/javascript; charset=utf-8')) throw Error('Invalid static artifact')
        const raw = image ? bytes : gunzipSync(bytes, { maxOutputLength: 24 * 1024 * 1024 })
        if (raw.length !== artifact.rawBytes || createHash('sha256').update(raw).digest('hex') !== artifact.hash || image && artifact.hash !== image[1]) throw Error('Static artifact integrity mismatch')
        const gzip = !image && /(?:^|[,\s])gzip(?:[,\s;]|$)/.test(assetEncoding)
        if (!image && !gzip) bytes = raw
        const headers = { 'content-type': artifact.mime, 'cache-control': 'public, max-age=31536000, immutable', vary: 'Accept-Encoding', etag: `"${artifact.hash}"`, ...(gzip ? { 'content-encoding': 'gzip' } : {}) }
        if (bootNotModified(req, headers.etag)) { res.writeHead(304, { ...headers, 'x-content-type-options': 'nosniff' }); res.end() }
        else { res.writeHead(200, { ...headers, 'content-length': bytes.length, 'x-content-type-options': 'nosniff' }); res.end(bytes) }
        if (!image) void this.bootAssets?.save(assetScope, url, assetEncoding, headers, bytes)
        return
      } catch (error) {
        if (error instanceof RemoteFailureError) throw error
        if (this.disposed || res.destroyed) return
        if (image) { res.writeHead(502, { 'cache-control': 'no-store' }); res.end('The native illustration could not be read.'); return }
        // A failed, one-shot export is not replayed. The ordinary native GET
        // remains available for compatibility with an unsupported runtime.
      }
    }
    if (url.pathname === '/__dsh_remote/release') {
      res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store')
      if (!session.embedded || req.method !== 'POST') { res.writeHead(403); res.end('{}'); return }
      const body = await readJsonBody(req, { maxBytes: 1024, objectOnly: true }) as { action?:string; token?:string }
      if(!body||!['freeze','check','thaw'].includes(body.action??'')||Object.keys(body).some(key=>!['action','token'].includes(key))){res.writeHead(400);res.end('{"ok":false}');return}
      const thaw = () => { clearTimeout(session.freezeTimer); session.frozen = undefined; for (const socket of session.uplinks ?? []) socket.resume() }
      if (body.action === 'check') { res.end(JSON.stringify({ok:!!session.frozen && body.token === session.frozen && !session.pending})); return }
      if (body.action === 'thaw' && body.token === session.frozen) { thaw(); res.end('{"ok":true}'); return }
      if (body.action !== 'freeze' || session.frozen || session.pending || session.unsafeSockets) { res.writeHead(409); res.end(JSON.stringify({ok:false,reason:session.unsafeSockets?'unsupported-socket':session.pending?'pending-http':session.frozen?'already-frozen':'invalid-action'})); return }
      const tasks = await this.rpc<{items:Array<{running?:boolean}>}>('session/list',{_request:{}})
      if (!Array.isArray(tasks?.items) || tasks.items.some(row=>row.running) || session.frozen || session.pending || session.unsafeSockets) { res.writeHead(409);res.end(JSON.stringify({ok:false,reason:session.unsafeSockets?'unsupported-socket':session.pending?'pending-http':session.frozen?'already-frozen':'running-agent'}));return }
      // Browser writes are gated; controller metadata/history readers remain
      // independent. Pause existing multiplexed uplinks without ending tasks.
      session.frozen = randomUUID(); for (const socket of session.uplinks ?? []) socket.pause()
      session.freezeTimer = setTimeout(thaw, 10000); session.freezeTimer.unref()
      res.end(JSON.stringify({ ok:true, token:session.frozen })); return
    }
    if (url.pathname === '/__dsh_remote/observations') {
      const reply = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        res.end(JSON.stringify(value))
      }
      if (!session.embedded) { reply(403, { error: 'Embedded view ownership is required' }); return }
      if (req.method !== 'PUT') { reply(405, { error: 'Unsupported observation method' }); return }
      if (!this.viewReceipts) { reply(503, { error: 'Local observation storage is unavailable' }); return }
      try {
        const body = await readJsonBody(req, { maxBytes: 128 * 1024, objectOnly: true }) as { records?: ViewReceiptInput[] }
        if (!body || Object.keys(body).some(name => name !== 'records') || !Array.isArray(body.records)) throw new Error('Invalid observation batch')
        const receipts = await this.viewReceipts.saveMany(this.hostId, body.records)
        reply(200, { receipts })
      } catch { reply(507, { error: 'Observation metadata was not confirmed on disk. Keep this view open.', code: 'view-observations/storage' }) }
      return
    }
    if (url.pathname === '/__dsh_remote/draft') {
      const reply = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        res.end(JSON.stringify(value))
      }
      if (!this.drafts) { reply(404, { error: 'Local draft storage is unavailable' }); return }
      const sessionId = url.searchParams.get('sessionId') ?? ''
      if (!sessionId || sessionId.length > 256 || /[\u0000-\u001f\u007f]/.test(sessionId)) { reply(400, { error: 'Invalid draft session' }); return }
      try {
        if (req.method === 'GET') {
          reply(200, { draft: await this.drafts.read(this.hostId, sessionId), issue: this.drafts.writeIssue }); return
        }
        if (req.method !== 'PUT') { reply(405, { error: 'Unsupported draft method' }); return }
        const body = await readJsonBody(req, { maxBytes: 64 * 1024 * 1024, objectOnly: true })
        if (!body || typeof body !== 'object') { reply(400, { error: 'Invalid draft snapshot' }); return }
        reply(200, { draft: await this.drafts.write(this.hostId, sessionId, body as DraftWrite) })
      } catch (error) {
        if (error instanceof DraftConflictError) reply(409, { error: error.message, code: 'draft/conflict' })
        else reply(507, { error: 'Local draft save could not be confirmed. Keep this view open to retain the current input.', code: 'draft/storage-unavailable' })
      }
      return
    }
    if (url.pathname === '/__dsh_remote/navigation-client.js' && req.method === 'GET' && session.embedded) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      res.end(`(${navigationClient.toString()})();`); return
    }
    if (url.pathname === '/__dsh_remote/operation-client.js') {
      if (!session.embedded) { res.writeHead(403); res.end(); return }
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      res.end(`(${operationClient.toString()})();`); return
    }
    if (url.pathname === '/__dsh_remote/draft-client.js' && req.method === 'GET' && session.embedded) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      res.end(`(${draftClient.toString()})(${JSON.stringify(this.hostId)},(${createDraftReplica.toString()}),(${seedDraft.toString()}));`); return
    }
    if (url.pathname === '/__dsh_remote/status') {
      res.writeHead(200, { 'content-type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ready: await this.healthy() })); return
    }
    const initialSessionId = url.pathname === '/' && req.method === 'GET' ? session.sessionId : undefined
    let draftSeed: DraftSeed | undefined
    if (initialSessionId && this.drafts) {
      draftSeed = { hostId: this.hostId, sessionId: initialSessionId }
      try { draftSeed.draft = await this.drafts.read(this.hostId, initialSessionId); draftSeed.issue = this.drafts.writeIssue }
      catch { draftSeed.issue = 'Saved draft could not be read. Keep existing browser text; no saved file was replaced.' }
    }
    if (session.frozen) { res.writeHead(409, { 'content-type':'application/json' }); res.end('{"error":"View is being suspended; no operation was dispatched"}'); return }
    session.pending = (session.pending ?? 0) + 1
    let browserPending=true
    const finishBrowserRequest=()=>{if(browserPending){browserPending=false;session.pending!--}}
    const port = this.localPort, release = this.retainRequest(port)
    const upstreamOrigin = `http://127.0.0.1:${port}`
    const changesCatalog = req.method === 'POST' && catalogMutation(url.pathname.replace(/^\/api\//, ''))
    if (changesCatalog) this.onCatalogChange()
    let readDeadline: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        const upstream = request({ hostname: '127.0.0.1', port, path: req.url, method: req.method, headers: this.headers(req, url.pathname === '/' && req.method === 'GET') }, incoming => {
          const headers = { ...incoming.headers }; delete headers['set-cookie']
          if (incoming.statusCode && incoming.statusCode >= 200 && incoming.statusCode < 400) this.noteTraffic(port)
          // The official hot-module graph is a perpetual read-only SSE feed,
          // not a dispatched operation. Recognize its exact method/path/type;
          // all other HTTP (including unknown streams) remains protected.
          if(req.method==='GET'&&url.pathname==='/plugins/events'&&incoming.statusCode===200
            &&String(headers['content-type']).toLowerCase().startsWith('text/event-stream')){finishBrowserRequest();release()}
          if (session.embedded && new URL(this.returnUrl).protocol==='http:' && ['localhost','127.0.0.1'].includes(new URL(this.returnUrl).hostname)) {
            const parent = new URL(this.returnUrl); if (parent.protocol === 'http:') parent.hostname = new URL(origin).hostname
            delete headers['x-frame-options']
            // The authenticated controller is the sole permitted frame owner.
            headers['content-security-policy'] = (String(headers['content-security-policy'] ?? '').replace(/frame-ancestors[^;]*(;|$)/gi, '') + `; frame-ancestors ${parent.origin}`).replace(/^;\s*/, '')
          }
          headers['referrer-policy'] = 'no-referrer'
          if (headers.location?.startsWith(upstreamOrigin)) headers.location = headers.location.slice(upstreamOrigin.length) || '/'
          const html = url.pathname === '/' && req.method === 'GET' && incoming.statusCode === 200 && String(headers['content-type']).includes('text/html')
          if (!html) {
            let assetChunks: Buffer[] | undefined = assetRead && this.bootAssets && incoming.statusCode === 200 && this.bootAssets.storable(incoming.headers) ? [] : undefined
            let assetBytes = 0
            if (assetChunks) incoming.on('data', (chunk: Buffer) => {
              assetBytes += chunk.length
              if (assetBytes > bootAssetEntryLimit) assetChunks = undefined
              else assetChunks?.push(chunk)
            })
            res.writeHead(incoming.statusCode ?? 502, headers); incoming.pipe(res)
            incoming.once('end', () => {
              if (assetChunks && incoming.complete) void this.bootAssets!.save(assetScope, url, assetEncoding, incoming.headers, Buffer.concat(assetChunks))
              resolve()
            }); incoming.once('error', reject); return
          }
          const chunks: Buffer[] = []; let size = 0
          incoming.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 8 * 1024 * 1024) incoming.destroy(new Error('Remote HTML exceeded limit')); else chunks.push(chunk) })
          incoming.once('error', reject)
          incoming.once('end', () => {
            try {
            delete headers['content-length']; delete headers['content-encoding']; delete headers.etag
            headers['cache-control'] = 'no-store'
            // Consume navigation once; later reloads preserve the remote client's current session.
            const selected = initialSessionId
            if (session.sessionId === selected) delete session.sessionId
            const returnUrl = new URL(this.returnUrl)
            if (returnUrl.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(returnUrl.hostname)) returnUrl.hostname = new URL(origin).hostname
            const body = remotePage(Buffer.concat(chunks).toString('utf8'), {
              alias: this.alias, returnUrl: returnUrl.href, hostId: this.hostId, recoveryProof: this.recoveryProof, sessionId: selected, embedded: session.embedded, draftSeed,channel:session.channel??=randomUUID(),
            })
            res.writeHead(incoming.statusCode ?? 200, headers); res.end(body); resolve()
            } catch (error) { reject(error) }
          })
        })
        upstream.once('error', reject)
        // This exact endpoint only reads provider/model metadata. A stalled
        // carrier must settle the native UI's Promise so its existing error
        // and Retry action replace Loading models. Never retry it here.
        if (req.method === 'POST' && url.pathname === '/api/session/modelCatalog') {
          readDeadline = setTimeout(() => upstream.destroy(Object.assign(new Error('Remote model list read timed out'), { code: 'DSH_MODEL_CATALOG_TIMEOUT' })), modelCatalogReadTimeoutMs)
        }
        req.once('aborted', () => { upstream.destroy(); resolve() })
        res.once('close', () => { upstream.destroy(); resolve() })
        req.pipe(upstream)
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'DSH_MODEL_CATALOG_TIMEOUT') {
        if (!res.headersSent && !res.destroyed) { res.writeHead(504, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end('The remote model list did not respond in time. Retry the model list; no request was replayed.') }
        else res.destroy()
        return
      }
      // A replacement carrier may close an initial JS/CSS read before any
      // bytes reached the browser. Only immutable hashed boot assets can
      // continue once on the new carrier. API calls, uploads, downloads and
      // writes are never replayed; partial responses are never concatenated.
      const bootAsset = req.method === 'GET' && !url.search && /^\/assets\/[^/]+[-.][A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(url.pathname)
      if (!bootRecovery && bootAsset && port !== this.localPort && !res.headersSent && !res.destroyed && !req.aborted) {
        await this.handle(req, res, 1); return
      }
      throw error
    } finally { clearTimeout(readDeadline); finishBrowserRequest(); if (changesCatalog) this.onCatalogChange(); release() }
  }
  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const session = this.authenticated(req)
    if (!session || session.frozen) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return }
    const uplinks = session.uplinks ??= new Set(); uplinks.add(socket)
    const url=new URL(req.url??'/',session.origin),unsupported=url.pathname!=='/api/remote.mux'||!session.channel||url.searchParams.get('dsh-view-channel')!==session.channel
    if(unsupported)session.unsafeSockets=(session.unsafeSockets??0)+1
    socket.once('close', () => {uplinks.delete(socket);if(unsupported)session.unsafeSockets!--})
    const port = this.localPort, release = this.retainStream(port)
    const upstream = request({ hostname: '127.0.0.1', port, path: req.url, headers: this.headers(req) })
    socket.once('error', () => socket.destroy())
    socket.once('close', () => { upstream.destroy(); release() })
    upstream.on('upgrade', (response, remote, remoteHead) => {
      const close = () => { socket.destroy(); remote.destroy(); release() }
      socket.once('error', close); remote.once('error', close); socket.once('close', close); remote.once('close', close)
      if (socket.destroyed) { close(); return }
      const lines = Object.entries(response.headers).filter(([name]) => name !== 'set-cookie').flatMap(([name, values]) => (Array.isArray(values) ? values : [values]).map(value => `${name}: ${value}`))
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`)
      if (remoteHead.length) socket.write(remoteHead)
      if (head.length) remote.write(head)
      remote.pipe(socket).pipe(remote)
    })
    upstream.on('response', response => { response.resume(); release(); socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Upstream unavailable\r\nConnection: close\r\n\r\n`) })
    upstream.on('error', () => { socket.destroy(); release() })
    upstream.end()
  }
  dispose(): void {
    this.disposed = true; this.healthRead?.controller.abort()
    for (const begin of this.bootWaiters.splice(0)) begin()
    this.bootReads.clear()
    for (const session of this.sessions.values()) clearTimeout(session.freezeTimer)
    this.catalogLifetime.abort()
    this.server.close(); for (const socket of this.sockets) socket.destroy()
    for (const finish of [...this.drainWaiters]) finish()
    for (const old of this.retired.values()) old.stop()
    this.retired.clear(); this.streams.clear()
    this.sockets.clear(); this.sessions.clear(); this.tickets.clear(); this.upstreamCookie = ''
  }
}
