/**
 * The /api/dsh-ssh route family: host CRUD, exec, cluster, SFTP transfer
 * (NDJSON progress stream for uploads, binary stream for downloads), remote
 * listing, tunnels, and the WebSocket PTY terminal upgrade. Every route
 * carries a loopback-only trust fence (plus browser same-origin markers) —
 * these endpoints execute commands on remote servers, so LAN-exposed dsh web
 * deployments must not serve them.
 */

import { createWriteStream, mkdirSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SshEngine, ShellSession, KeyboardInteractiveHandler } from './engine.ts'
import { terminalTargetOf } from './engine/connection-pool.ts'
import { readJsonBody, writeJson } from './http.ts'
import { isLoopbackRequest } from './loopback.ts'
import { SSH_API, type ClusterRequest, type ClusterStreamFrame, type HostPayload, type TerminalClientFrame, type TerminalServerFrame } from './protocol.ts'
import type { ExecFlow } from './engine/connection-pool.ts'
import type { HostStore } from './store.ts'
import type { SshWorkspaces } from './workspaces.ts'
import { shellQuote } from './remote/transport.ts'
import { TerminalSessions, terminalKeyValid, terminalSizeValid, type TerminalView } from './terminal-sessions.ts'

/** Cap on declared upload bodies (staged to disk before SFTP). */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024

/**
 * One noServer WebSocket server for terminal upgrades: the browser half uses
 * a standards-compliant WebSocket, so the host must speak real RFC 6455
 * frames (the webserver hands us the raw upgraded socket).
 */
const terminalWss = new WebSocketServer({ noServer: true, maxPayload: 131072 })

/** Pause the shell when the socket's send buffer exceeds this… */
const BACKPRESSURE_HIGH_WATER = 1024 * 1024

/** …and resume once it drains below this. */
const BACKPRESSURE_LOW_WATER = 512 * 1024

/** URL query helper (first value, decoded). */
function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/** Route family dependencies. */
export interface SshRoutesDeps {
  legacyReadOnly?: boolean
  workspaces?: SshWorkspaces
  workspaceRegistry?: () => { list(): Array<{ path: string; title: string; id: string }>; create(path: string, title?: string): Promise<unknown> } | undefined
  /** Official DSH browser authentication + Origin fence. Missing auth fails closed. */
  requestRejection?: (req: IncomingMessage) => 401 | 403 | undefined
  /** The host store (CRUD). */
  store: HostStore
  /** The engine (ops). */
  engine: SshEngine
  /** Temp dir for upload/download staging (tests inject a sandbox). */
  stagingDir?: string
/** Upload byte cap override (tests); defaults to MAX_UPLOAD_BYTES. */
maxUploadBytes?: number
}

/**
 * Build every /api/dsh-ssh route (exact paths) plus the terminal upgrade.
 * @param deps - store, engine, staging dir.
 * @returns routes and the upgrade route.
 */
export function makeRoutes(deps: SshRoutesDeps): { routes: WebRoute[]; upgrade: WebUpgradeRoute; terminals: TerminalSessions } {
  const { store, engine } = deps
  const terminals = new TerminalSessions(engine, store)
  const clusterRuns = new Map<string, AbortController>()
  const reviewedTransfer = (url: URL, alias: string, res: ServerResponse): { version?: number } | undefined => {
    const value = url.searchParams.get('expectedUpdatedAt')
    if (value === null) return {}
    const version = Number(value)
    if (!Number.isSafeInteger(version) || version <= 0) { writeJson(res, 400, { error: 'Invalid host configuration version' }); return }
    if (store.find(alias)?.updatedAt !== version) { writeJson(res, 409, { error: 'Host configuration changed; no transfer was dispatched. Choose the host again' }); return }
    return { version }
  }
  const staging = deps.stagingDir ?? join(tmpdir(), 'dsh-ssh-uploads')
const maxUploadBytes = deps.maxUploadBytes ?? MAX_UPLOAD_BYTES
  // The upload route stages request bodies here; it must exist before the
  // first request (a missing dir would hang the first upload forever).
  // 0700 keeps in-flight transfers unreadable to other local users (the
  // staged files below are 0600; downloads are pre-created 0600 as well).
  mkdirSync(staging, { recursive: true, mode: 0o700 })

  /** Guard helper: fence + method check. */
  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }

  const routes: WebRoute[] = [
    {
      kind: 'exact', path: SSH_API.terminals,
      handler: async (req, res) => {
        if (!guard(req, res, req.method === 'DELETE' ? 'DELETE' : 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost'), owner = queryParam(url, 'owner')
        if (!terminalKeyValid(owner)) { writeJson(res, 400, { error: 'Invalid terminal owner' }); return }
        if (req.method === 'GET') { writeJson(res, 200, { sessions: terminals.list(owner) }); return }
        const id = queryParam(url, 'id')
        if (!terminalKeyValid(id)) { writeJson(res, 400, { error: 'Invalid terminal session' }); return }
        try { terminals.remove(owner, id); writeJson(res, 200, { ok: true }) }
        catch (error) { writeJson(res, 404, { error: error instanceof Error ? error.message : String(error) }) }
      },
    },
    {
      kind: 'exact', path: SSH_API.workspaces,
      handler: async (req, res) => {
        if (!guard(req, res, req.method === 'POST' ? 'POST' : 'GET')) return
        if (req.method === 'POST' && deps.legacyReadOnly) { writeJson(res, 409, { error: 'SSH workspaces now use remote DSH. Create one through /api/dsh-ssh/remote/connect.' }); return }
        if (!deps.workspaces) { writeJson(res, 503, { error: 'SSH workspaces are unavailable' }); return }
        try {
          if (req.method === 'GET') {
            const registered = deps.workspaceRegistry?.()?.list()
            const workspaces = deps.workspaces.list().flatMap(item => {
              const workspace = registered?.find(entry => entry.path === item.localPath)
              return workspace ? [{ ...item, title: workspace.title, workspaceId: workspace.id }] : []
            })
            writeJson(res, 200, { workspaces })
          } else {
            const body = await readJsonBody(req) as { alias?: unknown; remotePath?: unknown } | null
            if (typeof body?.alias !== 'string' || typeof body.remotePath !== 'string' || !body.remotePath.trim()) {
              writeJson(res, 400, { error: 'alias and remotePath are required' }); return
            }
            const registry = deps.workspaceRegistry?.()
            if (!registry) throw new Error('Workspace registry is unavailable')
            const workspace = await deps.workspaces.create(body.alias, body.remotePath)
            await registry.create(workspace.localPath, workspace.title)
            writeJson(res, 201, { workspace })
          }
        } catch (error) { writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) }) }
      },
    },
    {
      kind: 'exact',
      path: SSH_API.connections,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        writeJson(res, 200, { connections: engine.connectionStatus() })
      },
    },
    // ------------------------------------------------------------ hosts
    {
      kind: 'exact',
      path: SSH_API.hosts,
      handler: async (req, res) => {
        // One handler per path (the webserver keyed route registry rejects
        // duplicate (kind, path)); dispatch by HTTP method here.
        const method = req.method ?? 'GET'
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (method === 'GET') {
          writeJson(res, 200, { hosts: engine.list(queryParam(url, 'query')) })
          return
        }
        if (method === 'POST') {
          const body = (await readJsonBody(req)) as Record<string, unknown> | null
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          try {
            const entry = store.create(body as unknown as HostPayload)
            writeJson(res, 201, { host: store.summarize(entry) })
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (method !== 'PATCH' && method !== 'DELETE') {
          writeJson(res, 405, { error: `method not allowed: ${method}` })
          return
        }
        const alias = queryParam(url, 'alias')
        if (alias === undefined || alias === '') {
          writeJson(res, 400, { error: 'alias query parameter is required' })
          return
        }
        if (method === 'PATCH') {
          const body = (await readJsonBody(req)) as Record<string, unknown> | null
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          try {
            const entry = store.update(alias, body as unknown as Partial<HostPayload>)
            // Connection-relevant changes invalidate the pooled connection:
            // without this the pool would keep running commands on the old
            // host/credentials until the idle sweep (up to 30 min later).
            const patch = body as Record<string, unknown>
            if (['host', 'port', 'user', 'auth', 'proxyJump', 'proxyCommand'].some(key => patch[key] !== undefined)) {
              engine.dropAlias(alias)
            }
            writeJson(res, 200, { host: store.summarize(entry) })
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (method === 'DELETE') {
          try {
            engine.dropAlias(alias)
            store.delete(alias)
            writeJson(res, 200, { ok: true })
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        writeJson(res, 405, { error: `method not allowed: ${method}` })
      },
    },
    {
      kind: 'exact',
      path: SSH_API.importSshConfig,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          writeJson(res, 200, { result: store.importFromSshConfig() })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ------------------------------------------------------------ ops
    {
      kind: 'exact',
      path: SSH_API.test,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = (await readJsonBody(req)) as Record<string, unknown> | null
        const alias = typeof body?.alias === 'string' ? body.alias : ''
        if (alias === '') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        try {
          writeJson(res, 200, { result: await engine.test(alias) })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: SSH_API.exec,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = (await readJsonBody(req)) as Record<string, unknown> | null
        const alias = typeof body?.alias === 'string' ? body.alias : ''
        const command = typeof body?.command === 'string' ? body.command : ''
        if (alias === '' || command === '') {
          writeJson(res, 400, { error: 'alias and command are required' })
          return
        }
        const timeoutMs = typeof body?.timeoutMs === 'number' ? body.timeoutMs : undefined
        try {
          writeJson(res, 200, { result: await engine.exec(alias, command, timeoutMs) })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: SSH_API.cluster,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = (await readJsonBody(req)) as Record<string, unknown> | null
        const command = typeof body?.command === 'string' ? body.command : ''
        if (command === '') {
          writeJson(res, 400, { error: 'command is required' })
          return
        }
        const aliases = Array.isArray(body?.aliases) ? body.aliases.filter((x): x is string => typeof x === 'string') : undefined
        const tags = Array.isArray(body?.tags) ? body.tags.filter((x): x is string => typeof x === 'string') : undefined
        const environment = typeof body?.environment === 'string' ? body.environment : undefined
        const timeoutMs = typeof body?.timeoutMs === 'number' ? body.timeoutMs : undefined
        const maxWorkers = typeof body?.maxWorkers === 'number' ? body.maxWorkers : undefined
        const hasAliases = aliases?.some(alias => alias.trim() !== '') === true
        const hasEnvironment = typeof environment === 'string' && environment.trim() !== ''
        const hasTags = tags?.some(tag => tag.trim() !== '') === true
        if (!hasAliases && !hasEnvironment && !hasTags) {
          writeJson(res, 400, { error: 'ssh_cluster requires aliases, environment, or tags to limit the target set' })
          return
        }
        try {
          writeJson(res, 200, { results: await engine.cluster({ command, aliases, environment, tags, timeoutMs, maxWorkers }) })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact', path: SSH_API.clusterCancel,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req) as { runId?: unknown } | null
        const controller = typeof body?.runId === 'string' ? clusterRuns.get(body.runId) : undefined
        if (!controller) { writeJson(res, 404, { error: 'Cluster run is no longer active' }); return }
        controller.abort()
        writeJson(res, 200, { accepted: true })
      },
    },
    {
      kind: 'exact', path: SSH_API.clusterStream,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req) as Record<string, unknown> | null
        if (typeof body?.command !== 'string' || !body.command.trim()) { writeJson(res, 400, { error: 'command is required' }); return }
        const expected = body.expectedTargets
        if (expected !== undefined && (!Array.isArray(expected) || !expected.every(row => row && typeof row.alias === 'string' && typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt)))) {
          writeJson(res, 400, { error: 'Invalid reviewed target identities' }); return
        }
        if (clusterRuns.size >= 32) { writeJson(res, 429, { error: 'Too many active cluster runs' }); return }
        if (req.aborted || res.destroyed) return
        const runId = randomUUID(), controller = new AbortController(), paused = new Set<ExecFlow>()
        clusterRuns.set(runId, controller)
        const cancel = (): void => { if (!res.writableEnded) controller.abort() }
        const resume = (): void => { for (const flow of paused) flow.resume(); paused.clear() }
        req.once('aborted', cancel); res.once('close', cancel); res.once('error', cancel); res.on('drain', resume)
        const emit = (frame: ClusterStreamFrame, flow?: ExecFlow): void => {
          if (res.destroyed || res.writableEnded) { controller.abort(); return }
          try {
            if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8',
              'cache-control': 'no-store, no-transform', 'x-content-type-options': 'nosniff' })
            if (!res.write(JSON.stringify(frame) + '\n') && flow) { flow.pause(); paused.add(flow) }
          } catch { controller.abort(); res.destroy() }
        }
        try {
          await engine.cluster({ command: body.command,
            aliases: Array.isArray(body.aliases) ? body.aliases.filter((v): v is string => typeof v === 'string') : undefined,
            environment: typeof body.environment === 'string' ? body.environment : undefined,
            tags: Array.isArray(body.tags) ? body.tags.filter((v): v is string => typeof v === 'string') : undefined,
            timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
            maxWorkers: typeof body.maxWorkers === 'number' ? body.maxWorkers : undefined,
            expectedTargets: expected as ClusterRequest['expectedTargets'], signal: controller.signal,
            onEvent: (event, flow) => {
              if (event.type === 'plan') emit({ ...event, runId })
              else if (event.type === 'result') {
                // Output was already streamed once. Avoid duplicating megabytes
                // in result / completion frames or breaking backpressure.
                const { stdout: _stdout, stderr: _stderr, ...result } = event.result
                emit({ type: 'result', result })
              } else emit(event, flow)
            },
          })
          emit({ type: 'complete', cancelled: controller.signal.aborted })
          if (!res.destroyed) res.end()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!res.headersSent && !res.destroyed) writeJson(res, 400, { error: message })
          else { emit({ type: 'error', error: message }); if (!res.destroyed) res.end() }
        } finally {
          clusterRuns.delete(runId); paused.clear()
          req.off('aborted', cancel); res.off('close', cancel); res.off('error', cancel); res.off('drain', resume)
        }
      },
    },
    // ------------------------------------------------------------- ls
    {
      kind: 'exact',
      path: SSH_API.directories,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = queryParam(url, 'alias')
        const path = queryParam(url, 'path') ?? '~'
        const prefix = queryParam(url, 'prefix') ?? ''
        if (!alias) { writeJson(res, 400, { error: 'alias query parameter is required' }); return }
        try { writeJson(res, 200, await engine.browseDirectories(alias, path, prefix)) }
        catch (error) { writeJson(res, 400, { error: error instanceof Error ? error.message : 'Remote directory listing failed' }) }
      },
    },
    {
      kind: 'exact',
      path: SSH_API.ls,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = queryParam(url, 'alias')
        const path = queryParam(url, 'path') ?? '/'
        if (alias === undefined || alias === '') {
          writeJson(res, 400, { error: 'alias query parameter is required' })
          return
        }
        try {
          writeJson(res, 200, { entries: await engine.ls(alias, path) })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: SSH_API.transferDestination,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost'), alias = queryParam(url, 'alias'), path = queryParam(url, 'path')
        const rawVersion = queryParam(url, 'expectedUpdatedAt'), version = Number(rawVersion)
        if (!alias || !path?.startsWith('/') || path.length > 4096 || /[\0\r\n]/.test(path)) { writeJson(res, 400, { error: 'alias and an absolute remote file path are required' }); return }
        if (!rawVersion || !Number.isSafeInteger(version) || version <= 0) { writeJson(res, 400, { error: 'A valid host configuration version is required' }); return }
        const changed = (): boolean => store.find(alias)?.updatedAt !== version
        const changedMessage = 'Host configuration changed; destination was not checked. Keep the original receipt and review the host'
        if (changed()) { writeJson(res, 409, { error: changedMessage }); return }
        if (req.aborted || res.destroyed) return
        const controller = new AbortController(), cancel = (): void => { if (!res.writableEnded) controller.abort() }
        req.once('aborted', cancel); res.once('close', cancel); res.once('error', cancel)
        res.setHeader('cache-control', 'no-store')
        try { const result = await engine.inspectDestination(alias, path, version, controller.signal); if (!res.destroyed) writeJson(res, 200, result) }
        catch (error) { if (!res.destroyed) writeJson(res, changed() ? 409 : 400, { error: changed() ? changedMessage : error instanceof Error ? error.message : String(error) }) }
        finally { req.off('aborted', cancel); res.off('close', cancel); res.off('error', cancel) }
      },
    },
    // --------------------------------------------------------- tunnel
    {
      kind: 'exact',
      path: SSH_API.tunnel,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = (await readJsonBody(req)) as Record<string, unknown> | null
        const action = typeof body?.action === 'string' ? body.action : ''
        if (action === 'list') {
          writeJson(res, 200, { tunnels: engine.listTunnels() })
          return
        }
        if (action === 'start') {
          const alias = typeof body?.alias === 'string' ? body.alias : ''
          const remotePort = typeof body?.remotePort === 'number' ? body.remotePort : undefined
          if (alias === '' || remotePort === undefined) {
            writeJson(res, 400, { error: 'alias and remotePort are required' })
            return
          }
          try {
            const tunnel = await engine.startTunnel(alias, {
              remotePort,
              remoteHost: typeof body?.remoteHost === 'string' && body.remoteHost !== '' ? body.remoteHost : undefined,
              localPort: typeof body?.localPort === 'number' ? body.localPort : undefined,
            })
            writeJson(res, 200, { tunnel })
          } catch (error) {
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (action === 'stop') {
          const id = typeof body?.tunnelId === 'string' ? body.tunnelId : ''
          if (id === '') {
            writeJson(res, 400, { error: 'tunnelId is required' })
            return
          }
          writeJson(res, 200, { ok: engine.stopTunnel(id) })
          return
        }
        if (action === 'stop-all') {
          const alias = typeof body?.alias === 'string' ? body.alias : undefined
          writeJson(res, 200, { stopped: engine.stopAllTunnels(alias === '' ? undefined : alias) })
          return
        }
        writeJson(res, 400, { error: `unknown action '${action}'` })
      },
    },
    // --------------------------------------------------------- upload
    {
      kind: 'exact',
      path: SSH_API.upload,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = queryParam(url, 'alias')
        const remotePath = queryParam(url, 'remotePath')
        if (alias === undefined || remotePath === undefined) {
          writeJson(res, 400, { error: 'alias and remotePath query parameters are required' })
          return
        }
        const reviewed = reviewedTransfer(url, alias, res)
        if (!reviewed) return
        const declared = Number(req.headers['content-length'])
        if (Number.isFinite(declared) && declared > maxUploadBytes) {
          writeJson(res, 413, { error: 'upload body too large' })
          return
        }
        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store, no-transform',
          'referrer-policy': 'no-referrer',
        })
        const emit = (line: unknown): void => {
          try { res.write(JSON.stringify(line) + '\n') } catch { /* client gone */ }
        }
        // Stage the uploaded bytes, then SFTP them out with progress frames.
        const tmp = join(staging, `upload-${randomBytes(6).toString('hex')}`)
        const controller = new AbortController()
        const sink = createWriteStream(tmp, { mode: 0o600 })
        let settled = false
        // Every terminal path (sink error, client abort, response loss) must
        // emit a result frame, end the response, and remove the tmp file.
        const fail = (error: unknown): void => {
          if (settled) return
          settled = true
          controller.abort()
          emit({ type: 'result', ok: false, error: error instanceof Error ? error.message : String(error) })
          // End the response only after the tmp file is gone, and unlink only
          // after the sink is fully closed: destroying a WriteStream whose
          // fs.open is still pending lets the open RE-CREATE the file after
          // an early unlink, leaving staging populated (this raced the
          // response end and made the byte-cap test flaky).
          const cleanup = (): void => {
            void unlink(tmp).catch(() => undefined).finally(() => {
              try { res.end() } catch { /* closed */ }
            })
          }
          if (sink.destroyed) {
            cleanup()
          } else {
            sink.once('close', cleanup)
            try { sink.destroy() } catch { cleanup() }
          }
        }
        const done = (): void => {
          if (settled) return
          settled = true
          try { res.end() } catch { /* closed */ }
        }
        sink.on('error', (error) => fail(error))
        req.on('error', (error) => fail(error))
        req.on('aborted', () => fail('upload aborted by the client'))
        res.on('error', () => fail('response stream closed'))
        res.on('close', () => { if (!res.writableEnded) fail('connection closed') })
        // The content-length pre-check above can be bypassed by chunked or
        // header-less requests: count the bytes as they actually arrive and
        // abort the moment the cap is exceeded.
        let received = 0
        let capped = false
        req.on('data', (chunk: Buffer) => {
          received += chunk.byteLength
          if (received > maxUploadBytes && !capped) {
            capped = true
            fail('upload body too large')
            // Keep the socket alive until the response flush finishes:
            // destroying the request here races res.end() and the client
            // sees a hang-up instead of the result frame. Drain the rest of
            // the body so the socket can close cleanly afterwards.
            res.on('finish', () => { try { req.destroy() } catch { /* closed */ } })
            req.resume()
          }
        })
        req.pipe(sink)
        sink.on('finish', async () => {
          if (settled) return
          emit({ type: 'progress', progress: { phase: 'connecting', file: remotePath, transferred: 0, total: 0, percent: 0 } })
          try {
            const outcome = await engine.upload(alias, tmp, remotePath, false, progress => {
              if (!settled) emit({ type: 'progress', progress })
            }, controller.signal, reviewed.version)
            if (!settled) emit({ type: 'result', ok: true, transferredBytes: outcome.bytes })
          } catch (error) {
            if (!settled) emit({ type: 'result', ok: false, error: error instanceof Error ? error.message : String(error) })
          } finally {
            await unlink(tmp).catch(() => undefined)
            done()
          }
        })
      },
    },
    // ------------------------------------------------------- download
    {
      kind: 'exact',
      path: SSH_API.download,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = queryParam(url, 'alias')
        const remotePath = queryParam(url, 'remotePath')
        if (alias === undefined || remotePath === undefined) {
          writeJson(res, 400, { error: 'alias and remotePath query parameters are required' })
          return
        }
        const reviewed = reviewedTransfer(url, alias, res)
        if (!reviewed) return
        const controller = new AbortController()
        const cancel = (): void => {
          if (res.writableEnded) return
          controller.abort()
        }
        req.once('aborted', cancel)
        res.once('close', cancel)
        res.once('error', cancel)
        try {
          await engine.downloadStream(alias, remotePath, res, bytes => {
            res.writeHead(200, {
              'content-type': 'application/octet-stream',
              'content-length': String(bytes),
              // DSH 0.2 compresses binary responses too. Keep identity bytes
              // and Content-Length so the browser can verify and show progress.
              'cache-control': 'no-store, no-transform',
              'content-disposition': `attachment; filename="${basename(remotePath).replace(/["\r\n]/g, '')}"`,
              'referrer-policy': 'no-referrer',
            })
          }, controller.signal, reviewed.version)
        } catch (error) {
          if (!res.headersSent && !res.destroyed) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          } else {
            // Mid-stream failure after headers: destroy so the browser does
            // not hang waiting for the promised content-length bytes.
            res.destroy()
          }
        } finally {
          req.off('aborted', cancel)
          res.off('close', cancel)
          res.off('error', cancel)
        }
      },
    },
  ]

  // ---------------------------------------------- terminal (upgrade)
  const upgrade: WebUpgradeRoute = {
    path: SSH_API.terminal,
    handler: (req, socket, head) => {
      const rejection = deps.requestRejection ? deps.requestRejection(req) : 401
      if (rejection !== undefined) {
        socket.write(`HTTP/1.1 ${rejection} ${rejection === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\n\r\n`)
        socket.destroy()
        return
      }
      if (!isLoopbackRequest(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      // Opt-in durable shell protocol. Legacy clients retain close-on-socket semantics.
      if (url.searchParams.get('persistent') === '1') {
        const owner = queryParam(url, 'owner'), id = queryParam(url, 'session')
        const attach = url.searchParams.get('attach') === '1'
        const alias = queryParam(url, 'alias'), cwd = queryParam(url, 'cwd')
        const cols = Number(url.searchParams.get('cols') ?? '80'), rows = Number(url.searchParams.get('rows') ?? '24')
        const versionValue = queryParam(url, 'expectedUpdatedAt'), version = versionValue === undefined ? undefined : Number(versionValue)
        if (!terminalKeyValid(owner) || !terminalKeyValid(id) || (!attach && (!alias || !terminalSizeValid(cols, rows))) ||
          (cwd !== undefined && (!cwd.startsWith('/') || cwd.length > 4096 || /[\0\r\n]/.test(cwd)))) {
          socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); socket.destroy(); return
        }
        terminalWss.handleUpgrade(req, socket, head, ws => {
          let paused = false
          const view: TerminalView = {
            send: frame => {
              if (ws.readyState !== WebSocket.OPEN) return
              ws.send(JSON.stringify(frame), () => {
                if (paused && ws.bufferedAmount < BACKPRESSURE_LOW_WATER) { paused = false; terminals.pause(owner, id, view, false) }
              })
              if (!paused && ws.bufferedAmount > BACKPRESSURE_HIGH_WATER) { paused = true; terminals.pause(owner, id, view, true) }
            },
            close: () => { if (ws.readyState === WebSocket.OPEN) ws.close(1000) },
          }
          ws.on('close', () => terminals.detach(owner, id, view))
          ws.on('error', () => terminals.detach(owner, id, view))
          ws.on('message', bytes => {
            if (bytes.toString().length > 131072) { ws.close(1009); return }
            try { const frame = JSON.parse(bytes.toString()) as TerminalClientFrame; if (frame && typeof frame === 'object') terminals.message(owner, id, view, frame) }
            catch { /* Ignore malformed frames; never retry. */ }
          })
          try {
            if (attach) void terminals.attach(owner, id, view).catch(() => { view.send({ type: 'detached', reason: 'restore failed' }); view.close() })
            else terminals.create(owner, id, alias!, cols, rows, view, cwd, version)
          } catch (error) { view.send({ type: 'exit', code: null, error: error instanceof Error ? error.message : String(error) }); view.close() }
        })
        return
      }
      const alias = queryParam(url, 'alias')
      if (alias === undefined) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const cwd = queryParam(url, 'cwd')
      if (cwd !== undefined && (!cwd.startsWith('/') || cwd.length > 4096 || /[\0\r\n]/.test(cwd))) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const cols = Number.parseInt(queryParam(url, 'cols') ?? '80', 10)
      const rows = Number.parseInt(queryParam(url, 'rows') ?? '24', 10)
      terminalWss.handleUpgrade(req, socket, head, (ws) => {
        const controller = new AbortController()
        let session: ShellSession | undefined
        let closed = false
        let paused = false
        let pendingAuthFinish: ((responses: string[]) => void) | undefined
        // Resume the shell once the socket's send buffer drains below the
        // low-water mark (transport backpressure).
        const resume = (): void => {
          if (paused && ws.bufferedAmount < BACKPRESSURE_LOW_WATER) {
            paused = false
            session?.resume()
          }
        }
        const sendFrame = (frame: TerminalServerFrame): void => {
          if (closed || ws.readyState !== WebSocket.OPEN) return
          ws.send(JSON.stringify(frame), resume)
          if (!paused && ws.bufferedAmount > BACKPRESSURE_HIGH_WATER) {
            paused = true
            session?.pause()
          }
        }
        const closeSession = (): void => {
          controller.abort()
          if (pendingAuthFinish !== undefined) {
            const fn = pendingAuthFinish
            pendingAuthFinish = undefined
            try { fn([]) } catch { /* ignore */ }
          }
          const opened = session
          session = undefined
          if (opened !== undefined) opened.close()
        }

        const onKeyboardInteractive: KeyboardInteractiveHandler = (name, instructions, _lang, prompts, finish, target) => {
          if (closed) return
          // Interactive 2FA prompt sent to the client terminal
          pendingAuthFinish = finish
          sendFrame({
            type: 'auth_prompt',
            name,
            instructions,
            target,
            prompts: prompts.map(p => ({ prompt: p.prompt, echo: p.echo })),
          })
        }

        const entry = store.find(alias), versionText = queryParam(url, 'expectedUpdatedAt')
        const version = versionText === undefined ? undefined : Number(versionText)
        if (entry === undefined || (version !== undefined && (!Number.isSafeInteger(version) || version <= 0 || entry.updatedAt !== version))) {
          sendFrame({ type: 'exit', code: null, error: entry === undefined ? 'Configured host no longer exists' : 'Host configuration changed; no terminal was opened. Choose the host again' })
          closed = true; ws.close(1000); return
        }
        sendFrame({ type: 'target', target: terminalTargetOf(entry) })
        engine.openShell(alias, {
          cols: Number.isFinite(cols) ? cols : 80,
          rows: Number.isFinite(rows) ? rows : 24,
        }, onKeyboardInteractive, controller.signal, version).then((opened) => {
          if (ws.readyState !== WebSocket.OPEN) {
            opened.close()
            return
          }
          session = opened
          opened.onData = (data) => sendFrame({ type: 'output', data: data.toString('utf8') })
          opened.onExit = (code, error) => {
            sendFrame({ type: 'exit', code, error })
            closed = true
            try { ws.close(1000) } catch { /* already closed */ }
          }
          // A failed cd exits the shell, so this workspace never silently
          // falls back to the account's home directory. This is sent once;
          // an interrupted session is never replayed.
          if (cwd !== undefined) opened.send(`cd -- ${shellQuote(cwd)} || exit\r`)
          sendFrame({ type: 'ready', alias, target: opened.target })
        }).catch((error) => {
          sendFrame({ type: 'exit', code: null, error: error instanceof Error ? error.message : String(error) })
          closed = true
          try { ws.close(1000) } catch { /* already closed */ }
        })
        ws.on('message', (data) => {
          let frame: TerminalClientFrame
          try {
            frame = JSON.parse(String(data)) as TerminalClientFrame
          } catch {
            return
          }
          if (frame.type === 'input') {
            session?.send(frame.data)
          } else if (frame.type === 'resize') {
            session?.resize(Math.max(2, frame.cols), Math.max(1, frame.rows))
          } else if (frame.type === 'auth_response') {
            if (pendingAuthFinish !== undefined) {
              const fn = pendingAuthFinish
              pendingAuthFinish = undefined
              fn(frame.responses)
            }
          }
        })
        ws.on('close', () => {
          closed = true
          closeSession()
        })
        ws.on('error', () => {
          closed = true
          closeSession()
        })
      })
    },
  }

  return { routes: routes.map(route => ({ ...route,
    handler: async (req, res) => {
      const rejection = deps.requestRejection ? deps.requestRejection(req) : 401
      if (rejection !== undefined) {
        writeJson(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
        return
      }
      await route.handler(req, res)
    },
  })), upgrade, terminals }
}
