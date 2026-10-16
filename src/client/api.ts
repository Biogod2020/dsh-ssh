/**
 * Browser-side API client for the /api/dsh-ssh route family. The only data
 * access path the panel components use — plain fetch/WebSocket, same origin.
 */

import {
  SSH_API,
  type ClusterResult,
  type ClusterRequest,
  type ClusterStreamFrame,
  type ConnectionStatus,
  type ExecResult,
  type HostPayload,
  type ImportResult,
  type RemoteDirEntry,
  type RemoteDirectoryListing,
  type SshHostSummary,
  type TerminalSessionInfo,
  type TerminalClientFrame,
  type TerminalServerFrame,
  type TestResult,
  type TransferProgress,
  type TransferDestinationInfo,
  type TransferStreamLine,
  type TunnelInfo,
} from '../protocol.ts'
import { tt } from './panel/helpers.ts'
import type { SshWorkspace } from '../workspaces.ts'
import { sameClusterTargets } from '../cluster-targets.ts'
import type { TerminalContinuityState } from '../terminal-continuity.ts'

/** Minimal File System Access API surface (not in all lib.dom versions). */
interface WindowWithFileSystemAccess {
  showSaveFilePicker?: (options: { suggestedName?: string }) => Promise<{
    name?: string
    createWritable: () => Promise<DownloadWriter>
  }>
}

interface DownloadWriter {
  write: (data: Uint8Array) => Promise<void>
  close: () => Promise<void>
  abort: () => Promise<void>
}

/** Chosen during the user's click, without opening or writing the file yet. */
export interface DownloadDestination {
  createWritable?: () => Promise<DownloadWriter>
  filename?: string
}

/** Saving is a browser disk-commit stage, separate from SFTP progress. */
export type DownloadProgress = TransferProgress | (Omit<TransferProgress, 'phase'> & { phase: 'saving' })

export async function prepareDownload(remotePath: string, saveMode: 'picker' | 'browser'): Promise<DownloadDestination> {
  const picker = saveMode === 'picker' && typeof window !== 'undefined'
    ? (window as WindowWithFileSystemAccess).showSaveFilePicker : undefined
  if (!picker) return {}
  try {
    // Choosing an existing save target can truncate it before any writer or SSH
    // request exists. Aborting the later writer cannot restore that old content.
    const handle = await picker.call(window, { suggestedName: remotePath.split('/').pop() || 'download' })
    const filename = typeof handle.name === 'string' && handle.name.length > 0 && handle.name.length <= 512 && !/[\/\0\r\n]/.test(handle.name) ? handle.name : undefined
    return { createWritable: () => handle.createWritable(), ...(filename ? { filename } : {}) }
  } catch (cause) {
    if (typeof cause === 'object' && cause !== null && 'name' in cause && cause.name === 'AbortError') throw new TransferCancelledError(false)
    throw cause
  }
}

/** Error carrying the route's JSON error message. */
export class TerminalCatalogUnsupportedError extends Error {}

export class SshApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SshApiError'
  }
}

/** This endpoint's 409 always means the receipt's frozen host has changed. */
export class TransferDestinationHostChangedError extends SshApiError {}

/** Whether cancelling occurred before or after the HTTP operation was sent. */
export class ClusterNotStartedError extends SshApiError {
  readonly dispatched = false
}

export class TransferCancelledError extends Error {
  constructor(readonly dispatched: boolean) {
    super(dispatched ? 'Transfer stopped; check the destination before starting another transfer' : 'No transfer was started')
    this.name = 'AbortError'
  }
}

/** Extract the `.error` message from a JSON error body; undefined when absent. */
function extractError(text: string): string | undefined {
  if (text === '') return undefined
  try {
    const parsed = JSON.parse(text) as { error?: unknown } | null
    return typeof parsed?.error === 'string' ? parsed.error : undefined
  } catch {
    return undefined
  }
}

/** Parse a JSON response or throw an SshApiError. */
async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    if (response.status === 404) {
      throw new SshApiError(tt('error.disabled'))
    }
    throw new SshApiError(`HTTP ${response.status}: invalid JSON response`)
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : (response.status === 404 ? tt('error.disabled') : `HTTP ${response.status}`)
    throw new SshApiError(message)
  }
  return body as T
}

/** Query-string helper. */
function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? '' : '?' + text
}

/** One open terminal connection (WebSocket JSON frames). */
export interface TerminalConnection {
  onSnapshot?: ((session: TerminalSessionInfo, output: string, format?: 'state-v1', continuity?: TerminalContinuityState) => void) | undefined
  onResized?: ((cols: number, rows: number) => void) | undefined
  onDetached?: ((reason: string) => void) | undefined
  /** Stop the remote shell explicitly (durable connections detach on close). */
  stop?: (() => void) | undefined
  /** Public identity captured by the server for this connection. */
  onTarget?: ((target: import('../protocol.ts').TerminalTarget) => void) | undefined
  /** Fired on the ready frame (shell is up). */
  onReady: (() => void) | undefined
  /** Fired on every output frame. */
  onOutput: ((data: string) => void) | undefined
  /** Fired on the exit frame (or transport error). */
  onExit: ((code: number | null, error?: string, detail?: string) => void) | undefined
  /** Fired when the server requests keyboard-interactive 2FA. */
  onAuthPrompt: ((name: string, instructions: string, prompts: Array<{ prompt: string; echo: boolean }>, target?: import('../protocol.ts').TerminalTarget) => void) | undefined
  /** Send raw input to the remote shell. */
  send(data: string): void
  /** Resize the remote PTY. */
  resize(cols: number, rows: number): void
  /** Send interactive 2FA response codes to the remote server. */
  sendAuthResponse(responses: string[]): void
  /** Close this view. Persistent sessions keep the remote shell running. */
  close(): void
}

/** The browser half's only data entry point. */
export class SshApi {
  async listWorkspaces(): Promise<SshWorkspace[]> {
    return (await readJson<{ workspaces: SshWorkspace[] }>(await fetch(SSH_API.workspaces, { signal: AbortSignal.timeout(8000) }))).workspaces
  }

  async createWorkspace(alias: string, remotePath: string): Promise<SshWorkspace> {
    return (await readJson<{ workspace: SshWorkspace }>(await fetch(SSH_API.workspaces, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alias, remotePath }),
    }))).workspace
  }
  async connectionStatus(): Promise<ConnectionStatus[]> {
    return (await readJson<{ connections: ConnectionStatus[] }>(await fetch(SSH_API.connections, {
      signal: AbortSignal.timeout(8000),
    }))).connections
  }
  // -------------------------------------------------------------- hosts
  async listHosts(queryText?: string): Promise<SshHostSummary[]> {
    const response = await fetch(SSH_API.hosts + query({ query: queryText }))
    const body = await readJson<{ hosts: SshHostSummary[] }>(response)
    return body.hosts
  }

  async createHost(payload: HostPayload): Promise<SshHostSummary> {
    const response = await fetch(SSH_API.hosts, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await readJson<{ host: SshHostSummary }>(response)
    return body.host
  }

  async updateHost(alias: string, patch: HostPayload): Promise<SshHostSummary> {
    const response = await fetch(SSH_API.hosts + query({ alias }), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    const body = await readJson<{ host: SshHostSummary }>(response)
    return body.host
  }

  async deleteHost(alias: string): Promise<void> {
    const response = await fetch(SSH_API.hosts + query({ alias }), { method: 'DELETE' })
    await readJson<{ ok: boolean }>(response)
  }

  async importSshConfig(): Promise<ImportResult> {
    const response = await fetch(SSH_API.importSshConfig, { method: 'POST' })
    const body = await readJson<{ result: ImportResult }>(response)
    return body.result
  }

  // ---------------------------------------------------------------- ops
  async testHost(alias: string): Promise<TestResult> {
    const response = await fetch(SSH_API.test, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias }),
    })
    const body = await readJson<{ result: TestResult }>(response)
    return body.result
  }

  async exec(alias: string, command: string, timeoutMs?: number): Promise<ExecResult> {
    const response = await fetch(SSH_API.exec, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias, command, timeoutMs }),
    })
    const body = await readJson<{ result: ExecResult }>(response)
    return body.result
  }

  async cluster(options: {
    command: string
    aliases?: string[]
    environment?: string
    tags?: string[]
    timeoutMs?: number
    maxWorkers?: number
  }): Promise<ClusterResult[]> {
    const response = await fetch(SSH_API.cluster, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(options),
    })
    const body = await readJson<{ results: ClusterResult[] }>(response)
    return body.results
  }

  /** Stop requests keep the result stream open for authoritative final states. */
  async cancelCluster(runId: string): Promise<void> {
    await readJson(await fetch(SSH_API.clusterCancel, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId }) }))
  }

  async clusterStream(options: ClusterRequest, onEvent: (frame: ClusterStreamFrame) => void,
    signal?: AbortSignal): Promise<ClusterResult[]> {
    signal?.throwIfAborted()
    const response = await fetch(SSH_API.clusterStream, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(options), signal })
    if (!response.ok) {
      const message = extractError(await response.text()) ?? `Cluster failed: HTTP ${response.status}`
      if ([400, 401, 403, 405, 429].includes(response.status)) throw new ClusterNotStartedError(message)
      throw new SshApiError(message + '; remote outcome unknown; not retried')
    }
    if (!response.body) throw new SshApiError('Missing cluster stream; remote outcome unknown; not retried')
    const reader = response.body.getReader(), decoder = new TextDecoder(), results = new Map<string, ClusterResult>(), done = new Set<string>()
    let buffer = '', planned = false, complete = false, retained = 0
    const truncated = new Set<string>()
    const parse = (line: string): void => {
      if (!line.trim()) return
      if (line.length > 1024 * 1024) throw new SshApiError('Cluster stream frame exceeded the limit; remote outcome unknown; not retried')
      let frame: ClusterStreamFrame
      try { frame = JSON.parse(line) as ClusterStreamFrame } catch { throw new SshApiError('Invalid cluster stream; remote outcome unknown; not retried') }
      if (!frame || typeof frame !== 'object') throw new SshApiError('Invalid cluster stream; remote outcome unknown; not retried')
      if (frame.type === 'error') throw new SshApiError(frame.error)
      if (complete) throw new SshApiError('Unexpected data after cluster completion')
      if (frame.type === 'plan') {
        if (planned || typeof frame.runId !== 'string' || !Array.isArray(frame.targets)
          || !frame.targets.every(host => typeof host.alias === 'string' && typeof host.host === 'string' && typeof host.user === 'string' && Number.isInteger(host.port) && Number.isFinite(host.updatedAt))
          || new Set(frame.targets.map(host => host.alias)).size !== frame.targets.length) throw new SshApiError('Invalid cluster target plan; remote outcome unknown')
        if (!sameClusterTargets(frame.targets, options.expectedTargets)) throw new SshApiError('Unexpected cluster target scope; remote outcome unknown; not retried')
        planned = true
        frame.targets.forEach(host => results.set(host.alias, { alias: host.alias, ok: false, stdout: '', stderr: '' }))
      } else if (frame.type === 'complete') {
        if (!planned || done.size !== results.size) throw new SshApiError('Cluster ended without every host result; remote outcome unknown; not retried')
        complete = true
      } else {
        const alias = frame.type === 'result' ? frame.result?.alias : frame.alias
        const previous = results.get(alias)
        if (!previous || done.has(alias)) throw new SshApiError('Unexpected cluster host event; remote outcome unknown; not retried')
        if (frame.type === 'output') {
          if ((frame.stream !== 'stdout' && frame.stream !== 'stderr') || typeof frame.data !== 'string') throw new SshApiError('Invalid cluster output')
          const key = alias + ':' + frame.stream
          if (truncated.has(key)) return
          const allowance = Math.max(0, Math.min(128 * 1024 - (previous[frame.stream]?.length ?? 0), 8 * 1024 * 1024 - retained))
          let data = frame.data.slice(0, allowance)
          if (/[\uD800-\uDBFF]$/.test(data)) data = data.slice(0, -1)
          retained += data.length
          if (data.length < frame.data.length) { data += '\n…[browser output truncated]'; truncated.add(key) }
          previous[frame.stream] = (previous[frame.stream] ?? '') + data
          frame = { ...frame, data }
        } else if (frame.type === 'result') {
          if (typeof frame.result.ok !== 'boolean') throw new SshApiError('Invalid cluster result')
          results.set(alias, { ...frame.result, stdout: previous.stdout, stderr: previous.stderr }); done.add(alias)
        } else if (frame.type !== 'state' || (frame.state !== 'connecting' && frame.state !== 'running')) throw new SshApiError('Invalid cluster state')
      }
      onEvent(frame)
    }
    try {
      for (;;) {
        signal?.throwIfAborted()
        const { done: ended, value } = await reader.read()
        buffer += ended ? decoder.decode() : decoder.decode(value, { stream: true })
        const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
        for (const line of lines) parse(line)
        if (buffer.length > 1024 * 1024) throw new SshApiError('Cluster stream frame exceeded the limit; remote outcome unknown; not retried')
        if (ended) { parse(buffer); break }
      }
      if (!complete) throw new SshApiError('Cluster connection ended before confirmation; remote outcome unknown; not retried')
      return [...results.values()]
    } catch (cause) {
      await reader.cancel().catch(() => undefined)
      throw cause
    } finally { reader.releaseLock() }
  }

  // ----------------------------------------------------------------- ls
  async ls(alias: string, path: string): Promise<RemoteDirEntry[]> {
    const response = await fetch(SSH_API.ls + query({ alias, path }))
    const body = await readJson<{ entries: RemoteDirEntry[] }>(response)
    return body.entries
  }

  async inspectDestination(alias: string, path: string, expectedUpdatedAt: number, signal?: AbortSignal): Promise<TransferDestinationInfo> {
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20000)])
    const response = await fetch(SSH_API.transferDestination + query({ alias, path, expectedUpdatedAt }), { cache: 'no-store', signal: bounded })
    if (response.status === 404) throw new SshApiError(tt('transfer.checkUnavailable'))
    if (response.status === 409) {
      const body = await response.json() as { error?: unknown }
      throw new TransferDestinationHostChangedError(typeof body?.error === 'string' ? body.error : 'Host configuration changed')
    }
    const value = await readJson<TransferDestinationInfo>(response)
    if (!value || typeof value.exists !== 'boolean' || !Number.isSafeInteger(value.checkedAt) || value.checkedAt <= 0 || value.exists &&
      (!['file', 'dir', 'symlink', 'other'].includes(value.type) || !Number.isSafeInteger(value.size) || value.size < 0 || !Number.isSafeInteger(value.mtimeMs) || value.mtimeMs < 0)) {
      throw new SshApiError(tt('transfer.checkInvalid'))
    }
    return value
  }

  async browseDirectories(alias: string, path: string, prefix = ''): Promise<RemoteDirectoryListing> {
    return readJson<RemoteDirectoryListing>(await fetch(SSH_API.directories + query({ alias, path, prefix }), { cache: 'no-store', signal: AbortSignal.timeout(15000) }))
  }

  // ------------------------------------------------------------- tunnel
  async listTunnels(): Promise<TunnelInfo[]> {
    const response = await fetch(SSH_API.tunnel, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'list' }),
    })
    const body = await readJson<{ tunnels: TunnelInfo[] }>(response)
    return body.tunnels
  }

  async startTunnel(options: { alias: string; remotePort: number; remoteHost?: string; localPort?: number }): Promise<TunnelInfo> {
    const response = await fetch(SSH_API.tunnel, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start', ...options }),
    })
    const body = await readJson<{ tunnel: TunnelInfo }>(response)
    return body.tunnel
  }

  async stopTunnel(tunnelId: string): Promise<boolean> {
    const response = await fetch(SSH_API.tunnel, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'stop', tunnelId }),
    })
    const body = await readJson<{ ok: boolean }>(response)
    return body.ok
  }

  async stopAllTunnels(alias?: string): Promise<number> {
    const response = await fetch(SSH_API.tunnel, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'stop-all', alias }),
    })
    const body = await readJson<{ stopped: number }>(response)
    return body.stopped
  }

  // ------------------------------------------------------------ transfer
  /**
   * Upload one file (raw bytes) to a remote path. Progress arrives through
   * the NDJSON response stream; resolves when the result frame lands.
   */
  async uploadFile(
    file: File,
    alias: string,
    remotePath: string,
    onProgress?: (progress: TransferProgress) => void,
    signal?: AbortSignal,
    expectedUpdatedAt?: number,
  ): Promise<{ transferredBytes: number }> {
    if (signal?.aborted) throw new TransferCancelledError(false)
    // XHR exposes browser -> host bytes as well as the streamed SFTP frames.
    // fetch has no upload progress event. Neither layer retries a dispatch.
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest()
      let offset = 0, buffer = '', settled = false, dispatched = false
      let result: Extract<TransferStreamLine, { type: 'result' }> | undefined
      const finish = (error?: unknown): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', cancel)
        request.onload = request.onerror = request.onabort = request.onprogress = null
        request.upload.onprogress = null
        if (error !== undefined) reject(error)
        else resolve({ transferredBytes: result?.transferredBytes ?? 0 })
      }
      const cancel = (): void => { request.abort(); finish(new TransferCancelledError(dispatched)) }
      const parse = (flush = false): void => {
        buffer += request.responseText.slice(offset)
        offset = request.responseText.length
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        if (flush && buffer.trim()) { lines.push(buffer); buffer = '' }
        for (const line of lines) {
          if (!line.trim()) continue
          let frame: TransferStreamLine
          try { frame = JSON.parse(line) as TransferStreamLine } catch { continue }
          if (frame.type === 'progress') onProgress?.(frame.progress)
          else if (frame.type === 'result') result = frame
        }
      }
      request.open('POST', SSH_API.upload + query({ alias, remotePath, expectedUpdatedAt }))
      request.upload.onprogress = event => {
        if (!settled) onProgress?.({ phase: 'staging', file: file.name, transferred: event.loaded,
          total: file.size, percent: file.size > 0 ? event.loaded / file.size * 100 : 0 })
      }
      request.onprogress = () => { if (!settled) parse() }
      request.onerror = () => finish(new SshApiError('Upload connection lost; remote outcome unknown; not retried'))
      request.onabort = () => finish(new TransferCancelledError(dispatched))
      request.onload = () => {
        if (settled) return
        parse(true)
        if (request.status < 200 || request.status >= 300) {
          finish(new SshApiError(extractError(request.responseText) ?? `Upload failed: HTTP ${request.status}`))
        } else if (!result) {
          finish(new SshApiError('Upload ended without a result frame; remote outcome unknown; not retried'))
        } else if (!result.ok) finish(new SshApiError(result.error ?? 'Upload failed'))
        else finish()
      }
      signal?.addEventListener('abort', cancel, { once: true })
      try { dispatched = true; request.send(file) } catch (cause) { finish(cause) }
    })
  }

  /**
   * Download a remote file with client-side progress. Streams straight to
   * disk when the File System Access API is available (no full-file RAM
   * copy); otherwise falls back to an in-memory Blob.
   */
  async downloadFile(
    alias: string,
    remotePath: string,
    onProgress?: (progress: DownloadProgress) => void,
    signal?: AbortSignal,
    saveMode: 'picker' | 'browser' = 'picker',
    destination?: DownloadDestination,
    expectedUpdatedAt?: number,
  ): Promise<{ blob?: Blob; filename: string; streamed: boolean; bytes: number }> {
    let writable: DownloadWriter | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let received = 0
    let dispatched = false
    const cancelRead = (): void => { void reader?.cancel(signal?.reason).catch(() => undefined) }
    signal?.addEventListener('abort', cancelRead, { once: true })
    try {
      signal?.throwIfAborted()
      const chosen = destination ?? await prepareDownload(remotePath, saveMode)
      signal?.throwIfAborted()
      if (chosen.createWritable) writable = await chosen.createWritable()
      onProgress?.({ phase: 'connecting', file: remotePath, transferred: 0, total: 0, percent: 0 })
      signal?.throwIfAborted()
      dispatched = true
      const response = await fetch(SSH_API.download + query({ alias, remotePath, expectedUpdatedAt }), { signal })
      if (!response.ok || response.body === null) {
        const text = await response.text().catch(() => '')
        const error = extractError(text)
        throw new SshApiError(error ?? `download failed: HTTP ${response.status}`)
      }
      const total = Number(response.headers.get('content-length') ?? '0')
      const disposition = response.headers.get('content-disposition') ?? ''
      const match = /filename="([^"]+)"/.exec(disposition)
      const filename = match?.[1] ?? remotePath.split('/').pop() ?? 'download'
      reader = response.body.getReader()
      const started = Date.now()
      for (;;) {
        signal?.throwIfAborted()
        const { done, value } = await reader.read()
        signal?.throwIfAborted()
        if (done) break
        if (writable !== undefined) await writable.write(value)
        else chunks.push(value as Uint8Array<ArrayBuffer>)
        received += value.length
        const elapsed = Date.now() - started
        onProgress?.({ phase: 'transferring', file: remotePath, transferred: received, total,
          percent: total > 0 ? Math.round((received / total) * 1000) / 10 : 0,
          speedBps: elapsed >= 500 ? received / (elapsed / 1000) : undefined })
      }
      if (total > 0 && received !== total) throw new SshApiError('Download ended before all bytes were received')
      signal?.throwIfAborted()
      if (writable !== undefined) {
        onProgress?.({ phase: 'saving', file: remotePath, transferred: received, total: received, percent: 100 })
        signal?.throwIfAborted()
        await writable.close()
      }
      signal?.throwIfAborted()
      onProgress?.({ phase: 'done', file: remotePath, transferred: received, total: received > 0 ? received : total, percent: 100 })
      return { blob: writable === undefined ? new Blob(chunks) : undefined, filename,
        streamed: writable !== undefined, bytes: received }
    } catch (cause) {
      await reader?.cancel().catch(() => undefined)
      await writable?.abort().catch(() => undefined)
      if (signal?.aborted || (typeof cause === 'object' && cause !== null && 'name' in cause && cause.name === 'AbortError')) {
        throw new TransferCancelledError(dispatched)
      }
      throw cause
    } finally {
      signal?.removeEventListener('abort', cancelRead)
      reader?.releaseLock()
    }
  }

  // ------------------------------------------------------------ terminal
  async listTerminals(owner: string): Promise<TerminalSessionInfo[]> {
    const response = await fetch(SSH_API.terminals + query({ owner }), { signal: AbortSignal.timeout(8000) })
    if (response.status === 404) throw new TerminalCatalogUnsupportedError('Host terminal service requires reload')
    return (await readJson<{ sessions: TerminalSessionInfo[] }>(response)).sessions
  }
  async removeTerminal(owner: string, id: string): Promise<void> {
    await readJson(await fetch(SSH_API.terminals + query({ owner, id }), { method: 'DELETE', signal: AbortSignal.timeout(8000) }))
  }
  /** Open once or attach an existing shell; no automatic WebSocket retry. */
  openTerminal(alias: string, cols: number, rows: number, cwd?: string, expectedUpdatedAt?: number, persistent?: { owner: string; id: string; attach: boolean }): TerminalConnection {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = scheme + '://' + window.location.host + SSH_API.terminal + query({ alias, cols, rows, cwd, expectedUpdatedAt, persistent: persistent ? 1 : undefined, owner: persistent?.owner, session: persistent?.id, attach: persistent?.attach ? 1 : undefined })
    const socket = new WebSocket(url)
    let settled = false
    let ready = false
    const connection: TerminalConnection = {
      onReady: undefined,
      onOutput: undefined,
      onExit: undefined,
      onAuthPrompt: undefined,
      send: (data) => {
        if (ready && !settled && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'input', data } satisfies TerminalClientFrame))
        }
      },
      resize: (cols, rows) => {
        if (!settled && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'resize', cols, rows } satisfies TerminalClientFrame))
        }
      },
      sendAuthResponse: (responses) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'auth_response', responses } satisfies TerminalClientFrame))
        }
      },
      stop: () => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' } satisfies TerminalClientFrame))
      },
      close: () => {
        try { socket.close() } catch { /* already closed */ }
      },
    }
    socket.onmessage = (event: MessageEvent<string>) => {
      let frame: TerminalServerFrame
      try {
        frame = JSON.parse(event.data) as TerminalServerFrame
      } catch {
        return
      }
      if (frame.type === 'snapshot') {
        if (frame.continuity === undefined) connection.onSnapshot?.(frame.session, frame.output, frame.format)
        else connection.onSnapshot?.(frame.session, frame.output, frame.format, frame.continuity)
      }
      else if (frame.type === 'resized') connection.onResized?.(frame.cols, frame.rows)
      else if (frame.type === 'detached') { settled = true; ready = false; connection.onDetached?.(frame.reason) }
      else if (frame.type === 'target') connection.onTarget?.(frame.target)
      else if (frame.type === 'ready') { ready = true; if (frame.target) connection.onTarget?.(frame.target); connection.onReady?.() }
      else if (frame.type === 'output') connection.onOutput?.(frame.data)
      else if (frame.type === 'exit') { settled = true; ready = false; connection.onExit?.(frame.code, frame.error, frame.detail) }
      else if (frame.type === 'auth_prompt') connection.onAuthPrompt?.(frame.name, frame.instructions, frame.prompts, frame.target)
    }
    const lost = (): void => {
      if (settled) return
      settled = true; ready = false
      if (persistent) connection.onDetached?.('connection closed')
      else connection.onExit?.(null, 'connection closed')
    }
    socket.onclose = lost
    socket.onerror = lost
    return connection
  }
}
