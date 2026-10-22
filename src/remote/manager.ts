import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, lstatSync } from 'node:fs'
import { join, posix } from 'node:path'
import type { SshEngine } from '../engine.ts'
import { dshHome } from '../dsh-home.ts'
import { RemoteGateway } from './gateway.ts'
import { RemoteFailureError, remoteErrorCode } from './errors.ts'
import { RemoteActivityStore } from './activity-store.ts'
import { remoteScript, shellQuote } from './transport.ts'
import type { RemoteOperation, RemotePhase, RemoteReceipt, RemoteWorkspace, RemoteSessionCatalog } from './types.ts'
import { RemoteSessionCache } from './session-catalog.ts'
import { REMOTE_DSH_VERSION, REMOTE_DSH_INTEGRITY, REMOTE_DSH_VERSIONS, compatibleRemoteVersion } from './types.ts'
import { RemoteHistoryCache, historyKey } from './history-cache.ts'
import { RemoteHistoryService } from './history-service.ts'

interface Installed { node: string; dsh: string; root: string; version: string }
interface SessionSummary { sessionId: string; updatedAt: number; running: boolean; blank: boolean; origin?: string; projections?: { values?: { title?: unknown } } }
interface HostCatalog { workspaces: Awaited<ReturnType<RemoteGateway['workspaceSnapshot']>>; sessions: { items: SessionSummary[] }; checkedAt: number }
interface Runtime { gateway: RemoteGateway; tunnelId: string; hostId: string; alias: string; updatedAt: number; retryAt: number; failures: number; repairing?: boolean; catalog?: { read: Promise<HostCatalog>; expiresAt: number } }
interface ManagerOptions {
  installer: string; bootstrap: string; root?: string; remoteRoot?: string; returnUrl: () => string
  legacy?: () => Array<{ alias: string; remotePath: string; title: string }>
}
const messages: Record<RemotePhase, string> = {
  checking: 'Checking remote machine', 'installing-node': 'Installing verified Node.js', 'installing-dsh': 'Installing DSH and dependencies',
  starting: 'Starting remote DSH', connecting: 'Connecting remote workspace', ready: 'Remote workspace ready', failed: 'Connection failed', disconnected: 'Disconnected',
}

/** Host ownership is separate from workspace identity; no local cwd stands in for a remote directory. */
export class RemoteWorkspaces {
  private workspaces = new Map<string, RemoteWorkspace>()
  private operations = new Map<string, RemoteOperation>()
  private dismissed = new Set<string>()
  private pending = new Map<string, string>()
  private runtimes = new Map<string, Runtime>()
  private path: string
  private sessionCache: RemoteSessionCache
  private historyCache: RemoteHistoryService
  private catalogReads = new Map<string, Promise<RemoteSessionCatalog>>()
  private journal?: RemoteActivityStore
  private journalIssue?: string
  private recoveryKey: Buffer
  private disposed = false
  private enabled = true
  private epoch = 0
  private recovery: ReturnType<typeof setInterval>
  constructor(readonly engine: SshEngine, private options: ManagerOptions) {
    const root = options.root ?? join(dshHome(), 'remote-workspaces')
    mkdirSync(root, { recursive: true, mode: 0o700 }); this.path = join(root, 'workspaces.json')
    this.sessionCache = new RemoteSessionCache(join(root, 'session-catalog.json'))
    this.historyCache = new RemoteHistoryService(new RemoteHistoryCache(join(root, 'history')), async (item, sessionId) => {
      const { runtime, check } = await this.connectedWorkspace(item.id)
      const catalog = await this.hostCatalog(runtime); check()
      if (!catalog.workspaces.items.some(row => row.workspaceId === item.workspaceId && row.sessionIds.includes(sessionId))
        || catalog.workspaces.archivedSessionIds.includes(sessionId)) throw new Error('Session does not belong to this remote workspace')
      const summary = catalog.sessions.items.find(row => row.sessionId === sessionId)
      return { gateway: runtime.gateway, check, updatedAt: summary?.updatedAt ?? 0,
        title: typeof summary?.projections?.values?.title === 'string' ? summary.projections.values.title : '' }
    })
    const keyPath = join(root, 'recovery.key')
    if (!existsSync(keyPath)) {
      try { writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    const keyInfo = lstatSync(keyPath)
    if (!keyInfo.isFile() || (keyInfo.mode & 0o077) !== 0) throw new Error('Remote recovery key must be a private file')
    this.recoveryKey = readFileSync(keyPath)
    if (this.recoveryKey.length !== 32) throw new Error('Invalid remote recovery key')
    if (existsSync(this.path)) {
      const items = JSON.parse(readFileSync(this.path, 'utf8')) as RemoteWorkspace[]
      if (!Array.isArray(items)) throw new Error('Invalid remote workspace registry')
      for (const item of items) {
        if (!item || typeof item.id !== 'string' || typeof item.alias !== 'string' || typeof item.hostId !== 'string'
          || typeof item.remotePath !== 'string' || !item.remotePath.startsWith('/') || typeof item.workspaceId !== 'string') throw new Error('Invalid remote workspace binding')
        this.workspaces.set(item.id, item)
      }
    }
    try {
      this.journal = new RemoteActivityStore(root)
      let interrupted = false
      for (const { operation, dismissed } of this.journal.load()) {
        if (!['ready', 'failed'].includes(operation.phase)) {
          interrupted = true; operation.lastPhase = operation.phase; operation.phase = 'failed'; operation.errorCode = 'ssh/setup-interrupted'
          operation.updatedAt = Math.max(Date.now(), (operation.updatedAt ?? 0) + 1)
          operation.message = 'The local controller stopped before setup was confirmed. Remote installation or startup may still be running. Inspect its state before another attempt; no request was replayed.'
        }
        this.operations.set(operation.id, operation)
        if (dismissed) this.dismissed.add(operation.id)
      }
      if (interrupted) this.saveOperations()
    } catch {
      this.journalIssue = 'Remote preparation history is unavailable. No new setup will be dispatched; inspect the private local state.'
    }
    this.recovery = setInterval(() => { void this.repairConnections() }, 5000)
    this.recovery.unref?.()
  }
  private hostId(alias: string): string {
    const host = this.engine.find(alias)
    if (!host) throw new Error('Choose a configured SSH host first')
    return createHash('sha256').update(JSON.stringify([alias, host.host, host.port, host.user])).digest('hex').slice(0, 24)
  }
  list(): RemoteWorkspace[] { return [...this.workspaces.values()].map(x => ({ ...x })) }
  historyCopies() { return this.historyCache.status() }
  historyCopy(key: string) { return this.historyCache.cache.read(key) }
  async cachedHistory(id: string, sessionId: string) {
    const item = this.workspaces.get(id)
    if (!item) throw new Error('Unknown remote workspace')
    return this.historyCopy(historyKey(item.hostId, item.workspaceId, sessionId))
  }
  syncHistory(id: string, sessionId: string): void {
    const item = this.workspaces.get(id)
    if (!item) throw new Error('Unknown remote workspace')
    void this.historyCache.sync(item, sessionId)
  }
  clearHistory(keys: string[]) { return this.historyCache.clear(keys) }
  snoozeHistory() { return this.historyCache.cache.snooze() }
  catalog(): RemoteWorkspace[] {
    const items = this.list()
    for (const old of this.options.legacy?.() ?? []) {
      if (items.some(x => x.alias === old.alias && x.remotePath === old.remotePath)) continue
      try {
        const hostId = this.hostId(old.alias)
        items.push({ ...old, hostId, id: 'legacy-' + createHash('sha256').update(JSON.stringify([hostId, old.remotePath])).digest('hex').slice(0, 24), workspaceId: '' })
      } catch { /* A removed SSH host remains available only in the old local history. */ }
    }
    return items
  }
  operation(id: string): RemoteOperation | undefined { const item = this.operations.get(id); return item ? { ...item } : undefined }
  /** Durable public receipts, independent of browser and controller lifetimes. */
  activity(): RemoteOperation[] {
    const items = [...this.operations.values()].filter(x => x.phase !== 'ready' && !this.dismissed.has(x.id))
    const failed = items.filter(x => x.phase === 'failed').slice(-20)
    return [...items.filter(x => x.phase !== 'failed'), ...failed].map(x => ({ ...x }))
  }
  history(): RemoteOperation[] {
    return [...this.operations.values()].slice(-30).reverse().map(x => ({ ...x, ...(x.workspace ? { workspace: { ...x.workspace } } : {}), dismissed: this.dismissed.has(x.id) }))
  }
  activityWarning(): string | undefined { return this.journalIssue }
  dismiss(id: string): void {
    const operation = this.operations.get(id)
    if (!operation || operation.phase !== 'failed') throw new Error('Only a completed failure can be dismissed')
    this.dismissed.add(id)
    try { this.saveOperations() } catch (error) { this.dismissed.delete(id); throw error }
  }
  recoveryProof(hostId: string): string { return createHmac('sha256', this.recoveryKey).update(hostId).digest('hex') }
  recover(hostId: string, proof: string): RemoteOperation {
    const item = this.list().find(x => x.hostId === hostId)
    if (!item || !/^[a-f0-9]{64}$/.test(proof)) throw new Error('Unknown remote recovery link')
    if (this.hostId(item.alias) !== hostId) throw new Error('SSH host settings changed; recovery requires selecting the new host')
    const expected = Buffer.from(this.recoveryProof(hostId), 'hex')
    if (!timingSafeEqual(expected, Buffer.from(proof, 'hex'))) throw new Error('Unknown remote recovery link')
    return this.connect(item.alias, item.remotePath)
  }
  async status(): Promise<Array<{ hostId: string; phase: RemotePhase }>> {
    const pending = [...this.operations.values()].filter(x => x.hostId && !['ready', 'failed'].includes(x.phase))
    return Promise.all([...new Set([...this.catalog().map(x => x.hostId), ...pending.map(x => x.hostId!)])].map(async hostId => {
      const preparing = pending.find(x => x.hostId === hostId)
      if (preparing) return { hostId, phase: preparing.phase }
      const runtime = this.runtimes.get(hostId)
      const healthy = runtime && await runtime.gateway.healthy()
      if (runtime && !healthy) runtime.catalog = undefined
      return { hostId, phase: healthy && runtime && this.ownerMatches(runtime.alias, hostId, runtime.updatedAt) && this.runtimes.get(hostId) === runtime ? 'ready' : 'disconnected' }
    }))
  }
  /** Health reads and SSH tunnel handshakes may repeat; user commands and writes never do. */
  async repairConnections(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map(async runtime => {
      if (this.disposed || !this.enabled || runtime.repairing || runtime.retryAt > Date.now()) return
      runtime.repairing = true
      let replacement: string | undefined
      try {
        this.assertOwner(runtime.alias, runtime.hostId, runtime.updatedAt)
        if (await runtime.gateway.healthy()) { runtime.failures = 0; return }
        runtime.catalog = undefined
        this.assertOwner(runtime.alias, runtime.hostId, runtime.updatedAt)
        const tunnel = await this.engine.startWorkspaceTunnel(runtime.alias, runtime.gateway.receipt.port, runtime.updatedAt)
        replacement = tunnel.id
        this.assertOwner(runtime.alias, runtime.hostId, runtime.updatedAt)
        const previousPort = runtime.gateway.localPort
        await runtime.gateway.replaceTunnel(tunnel.localPort)
        if (this.disposed || !this.enabled || !this.ownerMatches(runtime.alias, runtime.hostId, runtime.updatedAt) || this.runtimes.get(runtime.hostId) !== runtime) return
        const previousTunnel = runtime.tunnelId
        runtime.tunnelId = tunnel.id; replacement = undefined; runtime.failures = 0
        try { await runtime.gateway.drainRequests(previousPort) }
        finally { this.engine.stopWorkspaceTunnel(previousTunnel) }
      } catch { runtime.retryAt = Date.now() + Math.min(30000, 1000 * 2 ** ++runtime.failures) }
      finally { if (replacement) this.engine.stopWorkspaceTunnel(replacement); runtime.repairing = false }
    }))
  }
  connect(alias: string, remotePath: string, expectedHostId?: string): RemoteOperation {
    if (this.disposed || !this.enabled) throw new Error('Remote workspace manager is stopped')
    if (this.journalIssue) throw new RemoteFailureError(this.journalIssue, 'ssh/activity-unavailable')
    const hostId = this.hostId(alias)
    if (expectedHostId !== undefined && expectedHostId !== hostId) throw new RemoteFailureError('SSH host identity changed; no preparation was dispatched. Choose the configured host again.', 'ssh/host-changed')
    const updatedAt = this.engine.find(alias)!.updatedAt
    if (!remotePath.trim() || remotePath.length > 4096 || remotePath.includes('\0')) throw new Error('Invalid remote directory')
    const key = JSON.stringify([hostId, remotePath])
    const pending = this.pending.get(key)
    if (pending) return this.operation(pending)!
    if (this.pending.size >= 8) throw new Error('Too many remote connections are being prepared')
    const now = Date.now()
    const operation: RemoteOperation = { id: randomUUID(), alias, hostId, remotePath, createdAt: now, updatedAt: now, phase: 'checking', message: messages.checking }
    const epoch = this.epoch
    this.operations.set(operation.id, operation); this.pending.set(key, operation.id)
    try { this.saveOperations() } catch (error) { this.operations.delete(operation.id); this.pending.delete(key); throw error }
    // One install/start per Host, even if users select different directories concurrently.
    const predecessor = [...this.operations.values()].find(x => x.id !== operation.id && x.alias === alias && !['ready', 'failed'].includes(x.phase))
    void (async () => {
      try {
        if (predecessor) throw new Error('This host is already being prepared; wait for that connection to finish')
        const workspace = await this.prepare(hostId, alias, remotePath, operation, epoch, updatedAt)
        operation.workspace = workspace; this.phase(operation, 'ready')
      } catch (error) {
        if (operation.errorCode === 'ssh/setup-interrupted') return
        const failure = !this.ownerMatches(alias, hostId, updatedAt) ? this.ownerFailure() : error
        operation.phase = 'failed'; operation.message = failure instanceof Error ? failure.message : 'Remote setup failed'
        operation.errorCode = remoteErrorCode(failure)
        operation.updatedAt = Math.max(Date.now(), (operation.updatedAt ?? 0) + 1)
        try { this.saveOperations() } catch { /* The public warning retains the local persistence failure; no replay. */ }
      } finally {
        this.pending.delete(key)
      }
    })()
    return { ...operation }
  }
  private saveOperations(): void {
    if (this.operations.size > 200) for (const [id, item] of this.operations) {
      if (this.operations.size <= 150) break
      if (['ready', 'failed'].includes(item.phase)) { this.operations.delete(id); this.dismissed.delete(id) }
    }
    try {
      if (!this.journal) throw new Error('History unavailable')
      this.journal.save([...this.operations.values()].map(operation => ({ operation, dismissed: this.dismissed.has(operation.id) })))
    } catch {
      this.journalIssue = 'Remote preparation history could not be saved. Already dispatched setup may still be running; inspect its remote state before another attempt. No request was replayed.'
      throw new RemoteFailureError(this.journalIssue, 'ssh/activity-unavailable')
    }
  }
  private phase(operation: RemoteOperation, phase: RemotePhase): void {
    if (!this.enabled || this.disposed || ['ready', 'failed'].includes(operation.phase) || operation.phase === phase) return
    operation.phase = phase; operation.message = messages[phase]; operation.updatedAt = Math.max(Date.now(), (operation.updatedAt ?? 0) + 1)
    this.saveOperations()
  }
  private assertActive(epoch: number): void {
    if (this.disposed || !this.enabled || epoch !== this.epoch) throw new Error('Connection setup was stopped; completed remote installation or startup is retained. No request was replayed.')
  }
  private ownerMatches(alias: string, hostId: string, updatedAt: number): boolean {
    try { return this.engine.find(alias)?.updatedAt === updatedAt && this.hostId(alias) === hostId } catch { return false }
  }
  private ownerFailure(): RemoteFailureError {
    return new RemoteFailureError('SSH host settings changed. Already dispatched setup may still be running; inspect its remote state before another attempt. Completed installation or startup is retained. No request was replayed.', 'ssh/host-changed')
  }
  private assertOwner(alias: string, hostId: string, updatedAt: number): void {
    if (!this.ownerMatches(alias, hostId, updatedAt)) throw this.ownerFailure()
  }
  private async prepare(hostId: string, alias: string, remotePath: string, operation: RemoteOperation, epoch: number, updatedAt: number): Promise<RemoteWorkspace> {
    const check = () => { this.assertActive(epoch); this.assertOwner(alias, hostId, updatedAt) }
    check()
    let runtime = this.runtimes.get(hostId)
    if (runtime && (runtime.updatedAt !== updatedAt || !await runtime.gateway.healthy())) {
      runtime.gateway.dispose(); this.engine.stopWorkspaceTunnel(runtime.tunnelId); this.runtimes.delete(hostId); runtime = undefined
    }
    check()
    if (!runtime) {
      let installed: Installed | undefined
      const installerArgs = [this.options.remoteRoot ?? '', REMOTE_DSH_VERSION, REMOTE_DSH_INTEGRITY, REMOTE_DSH_VERSIONS.join('|')]
      await remoteScript(this.engine, alias, `sh -s -- ${installerArgs.map(shellQuote).join(' ')}`, this.options.installer, line => {
        if (line.startsWith('DSH_PROGRESS:')) {
          const phase = line.slice(13) as RemotePhase
          if (['checking', 'installing-node', 'installing-dsh'].includes(phase)) this.phase(operation, phase)
        }
        if (line.startsWith('DSH_INSTALL:')) installed = JSON.parse(line.slice(12)) as Installed
      }, 15 * 60 * 1000, updatedAt)
      check()
      if (!installed || ![installed.node, installed.dsh, installed.root].every(x => typeof x === 'string' && x.startsWith('/'))
        || !compatibleRemoteVersion(installed.version)) throw new Error('Remote installer did not return a compatible installation')
      this.phase(operation, 'starting')
      let receipt: RemoteReceipt | undefined
      const source = `${this.options.bootstrap}\ntry { console.log('DSH_RECEIPT:' + JSON.stringify(await bootstrapRemote(${JSON.stringify({ ...installed, directory: remotePath, supportedVersions: REMOTE_DSH_VERSIONS })}))) } catch { console.log('DSH_ERROR: Remote DSH startup failed. Inspect the private state/server.log and state/server.json; no restart was attempted.'); process.exitCode=1 }\n`
      await remoteScript(this.engine, alias, `${shellQuote(installed.node)} --input-type=module`, source, line => {
        if (line.startsWith('DSH_RECEIPT:')) receipt = JSON.parse(line.slice(12)) as RemoteReceipt
      }, 100000, updatedAt)
      check()
      if (!receipt || receipt.protocol !== 1 || !compatibleRemoteVersion(receipt.version) || !Number.isInteger(receipt.port)
        || receipt.port < 1 || receipt.port > 65535 || !receipt.directory.startsWith('/') || !receipt.userHome?.startsWith('/')) throw new Error('Remote DSH did not return a compatible server receipt')
      const target = new URL(receipt.url)
      if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || Number(target.port) !== receipt.port || !target.searchParams.get('token')) throw new Error('Invalid remote DSH address')
      check()
      const tunnel = await this.engine.startWorkspaceTunnel(alias, receipt.port, updatedAt)
      const gateway = new RemoteGateway(tunnel.localPort, receipt, alias, this.options.returnUrl(), hostId, this.recoveryProof(hostId))
      try { await gateway.start() } catch (error) { gateway.dispose(); this.engine.stopWorkspaceTunnel(tunnel.id); throw error }
      try { check() } catch (error) { gateway.dispose(); this.engine.stopWorkspaceTunnel(tunnel.id); throw error }
      runtime = { gateway, tunnelId: tunnel.id, hostId, alias, updatedAt, retryAt: 0, failures: 0 }; this.runtimes.set(hostId, runtime)
      const owner = runtime
      gateway.onCatalogChange = () => {
        if (this.runtimes.get(hostId) !== owner) return
        owner.catalog = undefined
        for (const item of this.workspaces.values()) if (item.hostId === hostId) this.catalogReads.delete(item.id)
      }
      remotePath = receipt.directory
    }
    this.phase(operation, 'connecting')
    check()
    if (remotePath === '~') remotePath = runtime.gateway.receipt.userHome
    else if (remotePath.startsWith('~/')) remotePath = posix.join(runtime.gateway.receipt.userHome, remotePath.slice(2))
    if (!remotePath.startsWith('/')) throw new Error('Choose an absolute remote directory or ~/path')
    runtime.catalog = undefined
    let value: { workspace: { workspaceId: string; path: string; title: string; sessionIds: string[] } }
    try { value = await runtime.gateway.rpc('workspace/create', { request: { path: remotePath } }) }
    finally { runtime.catalog = undefined }
    const workspace = value.workspace
    check()
    if (!workspace?.workspaceId || !workspace.path?.startsWith('/')) throw new Error('Remote workspace API returned an incompatible identity')
    const id = createHash('sha256').update(JSON.stringify([hostId, workspace.path])).digest('hex').slice(0, 24)
    const item: RemoteWorkspace = { id, hostId, alias, remotePath: workspace.path, title: `${posix.basename(workspace.path) || '/'} [SSH:${alias}]`, workspaceId: workspace.workspaceId }
    this.workspaces.set(id, item)
    const temporary = `${this.path}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(this.list()), { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.path)
    return item
  }
  /** Metadata reads use an existing carrier only; opening the sidebar never starts SSH. */
  private hostCatalog(runtime: Runtime): Promise<HostCatalog> {
    if (runtime.catalog && runtime.catalog.expiresAt > Date.now()) return runtime.catalog.read
    // All projects on a Host share the same remote workspace/session lists.
    // Coalesce concurrent reads and short bursts; retain no Session content.
    const entry: NonNullable<Runtime['catalog']> = { expiresAt: Infinity, read: Promise.all([
      runtime.gateway.workspaceSnapshot(), runtime.gateway.rpc<HostCatalog['sessions']>('session/list', { _request: {} }),
    ])
      .then(([workspaces, sessions]) => {
        if (!Array.isArray(workspaces.items) || !Array.isArray(workspaces.archivedSessionIds) || !Array.isArray(sessions.items)) throw new Error('Remote catalog is incompatible')
        const checkedAt = Date.now(); entry.expiresAt = checkedAt + 2000
        return { workspaces, sessions, checkedAt }
      }).catch(error => { if (runtime.catalog === entry) runtime.catalog = undefined; throw error }) }
    runtime.catalog = entry
    return entry.read
  }
  async sessions(id: string): Promise<RemoteSessionCatalog> {
    const item = this.workspaces.get(id)
    if (!item) throw new Error('Unknown remote workspace')
    const cached = () => this.sessionCache.get(id, item.workspaceId)
    const runtime = this.runtimes.get(item.hostId), epoch = this.epoch
    if (!runtime || this.disposed || !this.enabled || !this.ownerMatches(item.alias, item.hostId, runtime.updatedAt)) return cached()
    const pending = this.catalogReads.get(id)
    if (pending) return pending
    const read = (async () => {
      try {
        const { workspaces, sessions: result, checkedAt } = await this.hostCatalog(runtime)
        this.assertActive(epoch); this.assertOwner(item.alias, item.hostId, runtime.updatedAt)
        if (this.runtimes.get(item.hostId) !== runtime) throw new Error('Remote connection changed')
        const workspace = workspaces.items.find(x => x.workspaceId === item.workspaceId)
        if (!workspace || !Array.isArray(workspace.sessionIds) || !Array.isArray(result.items)) throw new Error('Remote workspace catalog is incompatible')
        const members = new Set(workspace.sessionIds), archived = new Set(workspaces.archivedSessionIds)
        const sessions = result.items.filter(x => members.has(x.sessionId) && !archived.has(x.sessionId) && x.origin !== 'subagent')
          .map(x => ({ sessionId: x.sessionId, title: typeof x.projections?.values?.title === 'string' ? x.projections.values.title.slice(0, 1024) : '',
            running: x.running === true, blank: x.blank === true, updatedAt: Number.isFinite(x.updatedAt) ? x.updatedAt : 0 }))
          .sort((a, b) => b.updatedAt - a.updatedAt)
        const catalog: RemoteSessionCatalog = { workspaceId: item.workspaceId, sessions, stale: false, checkedAt }
        this.sessionCache.save(id, catalog)
        for (const session of sessions) void this.historyCache.sync(item, session.sessionId, false, session.updatedAt)
        return { ...catalog, ...(this.sessionCache.warning ? { warning: this.sessionCache.warning } : {}) }
      } catch { return { ...cached(), warning: 'Remote session status could not be checked. Showing the last saved list.' } }
    })()
    this.catalogReads.set(id, read)
    try { return await read } finally { if (this.catalogReads.get(id) === read) this.catalogReads.delete(id) }
  }
  async createSession(id: string): Promise<{ sessionId: string }> {
    const { item, runtime, check } = await this.connectedWorkspace(id)
    runtime.catalog = undefined
    try {
      const result = await runtime.gateway.rpc<{ sessionId: string }>('session/create', { request: { workspaceId: item.workspaceId } })
      check(); return result
    } finally { runtime.catalog = undefined }
  }
  private async connectedWorkspace(id: string) {
    const epoch = this.epoch
    this.assertActive(epoch)
    const item = this.workspaces.get(id)
    if (!item) throw new Error('Unknown remote workspace')
    if (this.hostId(item.alias) !== item.hostId) throw new Error('SSH host settings changed; reconnect and add this workspace again')
    const runtime = this.runtimes.get(item.hostId)
    if (!runtime) throw new Error('Remote DSH is disconnected. Connect the workspace first.')
    // The actual RPC verifies reachability. A separate health request adds a
    // serial remote round trip without making a subsequent write safer.
    const check = () => { this.assertActive(epoch); this.assertOwner(item.alias, item.hostId, runtime.updatedAt) }
    check()
    return { item, runtime, check }
  }
  async open(id: string, preferredSessionId?: string): Promise<{ url: string; sessionId: string }> {
    const { item, runtime, check } = await this.connectedWorkspace(id)
    const value = await runtime.gateway.rpc<{ workspace: { sessionIds: string[] } }>('workspace/create', { request: { path: item.remotePath } })
    check()
    if (preferredSessionId !== undefined && (!preferredSessionId || preferredSessionId.length > 256 || /[\u0000-\u001f\u007f]/.test(preferredSessionId))) throw new Error('Invalid remote session identity')
    if (preferredSessionId && !value.workspace.sessionIds.includes(preferredSessionId)) throw new Error('Session does not belong to this remote workspace')
    let sessionId = preferredSessionId ?? value.workspace.sessionIds.at(-1)
    if (!sessionId) {
      runtime.catalog = undefined
      try { sessionId = (await runtime.gateway.rpc<{ sessionId: string }>('session/create', { request: { workspaceId: item.workspaceId } })).sessionId }
      finally { runtime.catalog = undefined }
    }
    check()
    this.syncHistory(id, sessionId)
    return { url: runtime.gateway.launch(sessionId), sessionId }
  }
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    if (enabled) return
    this.epoch++
    let interrupted = false
    for (const operation of this.operations.values()) if (!['ready', 'failed'].includes(operation.phase)) {
      interrupted = true; operation.lastPhase = operation.phase; operation.phase = 'failed'; operation.errorCode = 'ssh/setup-interrupted'
      operation.updatedAt = Math.max(Date.now(), (operation.updatedAt ?? 0) + 1)
      operation.message = 'The local controller stopped before setup was confirmed. Remote installation or startup may still be running. Inspect its state before another attempt; no request was replayed.'
    }
    if (interrupted) try { this.saveOperations() } catch { /* Do not prevent owned connection cleanup. */ }
    for (const runtime of this.runtimes.values()) { runtime.gateway.dispose(); this.engine.stopWorkspaceTunnel(runtime.tunnelId) }
    this.runtimes.clear()
  }
  dispose(): void {
    this.setEnabled(false); this.disposed = true; clearInterval(this.recovery)
  }
}
