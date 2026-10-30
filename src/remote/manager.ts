import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, lstatSync } from 'node:fs'
import { join, posix } from 'node:path'
import type { SshEngine } from '../engine.ts'
import { dshHome } from '../dsh-home.ts'
import { isPrivateMode } from '../private-mode.ts'
import { RemoteGateway } from './gateway.ts'
import { RemoteFailureError, remoteErrorCode } from './errors.ts'
import { RemoteActivityStore } from './activity-store.ts'
import { remoteScript, shellQuote } from './transport.ts'
import type { RemoteOperation, RemotePhase, RemoteReceipt, RemoteWorkspace, RemoteSessionCatalog, RemoteForkResult } from './types.ts'
import { RemoteSessionCache } from './session-catalog.ts'
import { REMOTE_DSH_VERSION, REMOTE_DSH_INTEGRITY, REMOTE_DSH_VERSIONS, compatibleRemoteVersion } from './types.ts'
import { historyKey } from './history-cache.ts'
import { SegmentedHistoryCache } from './history-store.ts'
import { RemoteHistoryService } from './history-service.ts'
import { readHistoryDelta } from './history-reader.ts'
import { LocalDraftStore } from './draft-store.ts'
import { CatalogReadError, type CatalogReadPriority } from './catalog-json.ts'
import { BootAssetCache } from './boot-assets.ts'
import { readBootArtifact } from './boot-reader.ts'
import { GatewayOrigins } from './gateway-origins.ts'
import { ViewReceiptStore } from './view-receipts.ts'

interface Installed { node: string; dsh: string; root: string; version: string }
interface SessionSummary { sessionId: string; updatedAt: number; running: boolean; blank: boolean; origin?: string; projections?: { values?: { title?: unknown } } }
interface HostCatalog { workspaces: Awaited<ReturnType<RemoteGateway['workspaceCatalogSnapshot']>>; sessions: { items: SessionSummary[] }; checkedAt: number; revision: number }
interface Runtime { node: string; dsh?: string; gateway: RemoteGateway; tunnelId: string; hostId: string; alias: string; updatedAt: number; retryAt: number; failures: number; healthMisses?: number; repairing?: boolean; health?:{healthy:boolean;checkedAt:number};healthRead?:Promise<boolean>; catalogRevision?: number; catalog?: { read: Promise<HostCatalog>; expiresAt: number; priority: CatalogReadPriority } }
class SupersededCatalogError extends Error {
  constructor() { super('Remote catalog changed during this read'); this.name = 'SupersededCatalogError' }
}
interface ManagerOptions {
  installer: string; bootstrap: string; pluginUpdate?: string; modelBridge?: string; accountService?: string; accountBridge?: string; root?: string; remoteRoot?: string; returnUrl: () => string
  legacy?: () => Array<{ alias: string; remotePath: string; title: string }>
}
const messages: Record<RemotePhase, string> = {
  checking: 'Checking remote machine', 'installing-node': 'Installing verified Node.js', 'installing-dsh': 'Installing DSH and dependencies',
  starting: 'Starting remote DSH', connecting: 'Connecting remote workspace', ready: 'Remote workspace ready', failed: 'Connection failed', disconnected: 'Disconnected',
}

/** Host ownership is separate from workspace identity; no local cwd stands in for a remote directory. */
export class RemoteWorkspaces {
  onModelsConnected?: (alias: string, updatedAt: number) => Promise<void>
  private workspaces = new Map<string, RemoteWorkspace>()
  private operations = new Map<string, RemoteOperation>()
  private dismissed = new Set<string>()
  private pending = new Map<string, string>()
  private runtimes = new Map<string, Runtime>()
  private path: string
  private sessionCache: RemoteSessionCache
  private historyCache: RemoteHistoryService
  private drafts: LocalDraftStore
  private viewReceipts: ViewReceiptStore
  private catalogReads = new Map<string, Promise<RemoteSessionCatalog>>()
  private journal?: RemoteActivityStore
  private journalIssue?: string
  private recoveryKey: Buffer
  private disposed = false
  private enabled = true
  private epoch = 0
  private recovery: ReturnType<typeof setInterval>
  private refreshingHistory=false
  private bootAssets: BootAssetCache
  private gatewayOrigins: GatewayOrigins
  constructor(readonly engine: SshEngine, private options: ManagerOptions) {
    const root = options.root ?? join(dshHome(), 'remote-workspaces')
    mkdirSync(root, { recursive: true, mode: 0o700 }); this.path = join(root, 'workspaces.json')
    this.bootAssets = new BootAssetCache(join(root, 'boot-assets'))
    this.gatewayOrigins = new GatewayOrigins(join(root, 'gateway-origins'))
    this.drafts = new LocalDraftStore(join(root, 'drafts'))
    this.viewReceipts = new ViewReceiptStore(join(root, 'view-observations'))
    this.sessionCache = new RemoteSessionCache(join(root, 'session-catalog.json'))
    this.historyCache = new RemoteHistoryService(new SegmentedHistoryCache(join(root, 'history')), async (item, sessionId) => {
      const { runtime, check } = await this.connectedWorkspace(item.id)
      return this.withCatalog(runtime, catalog => {
        check()
        if (!catalog.workspaces.items.some(row => row.workspaceId === item.workspaceId && row.sessionIds.includes(sessionId))
          || catalog.workspaces.archivedSessionIds.includes(sessionId)) throw new Error('Session does not belong to this remote workspace')
        const summary = catalog.sessions.items.find(row => row.sessionId === sessionId)
        return { gateway: runtime.gateway, check, updatedAt: summary?.updatedAt ?? 0,
          delta: (afterSeq, throughSeq) => readHistoryDelta(this.engine, item.alias, runtime.node, runtime.gateway.receipt, { sessionId, afterSeq, throughSeq }, runtime.updatedAt),
          title: typeof summary?.projections?.values?.title === 'string' ? summary.projections.values.title : '' }
      })
    })
    const keyPath = join(root, 'recovery.key')
    if (!existsSync(keyPath)) {
      try { writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    const keyInfo = lstatSync(keyPath)
    if (!keyInfo.isFile() || !isPrivateMode(keyInfo)) throw new Error('Remote recovery key must be a private file')
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
    this.recovery = setInterval(() => {
      void this.repairConnections().then(()=>this.refreshSavedHistories()).catch(()=>{})
    }, 5000)
    this.recovery.unref?.()
  }
  private hostId(alias: string): string {
    const host = this.engine.find(alias)
    if (!host) throw new Error('Choose a configured SSH host first')
    return createHash('sha256').update(JSON.stringify([alias, host.host, host.port, host.user])).digest('hex').slice(0, 24)
  }
  list(): RemoteWorkspace[] { return [...this.workspaces.values()].map(x => ({ ...x })) }
  /** An explicit plugin-management action may use an existing carrier only.
   * Never starts/restarts a daemon or imports credentials to obtain access. */
  pluginAccess(alias: string, expectedUpdatedAt: number) {
    const epoch = this.epoch, hostId = this.hostId(alias), runtime = this.runtimes.get(hostId)
    if (!runtime) throw new Error('Remote DSH is disconnected. Open an SSH workspace on this host first.')
    const check = () => {
      this.assertActive(epoch)
      this.assertOwner(alias, hostId, expectedUpdatedAt)
      if (runtime.updatedAt !== expectedUpdatedAt || this.runtimes.get(hostId) !== runtime)
        throw new Error('Remote connection changed; compare plugins again')
    }
    check()
    const stageUpdate = async (name: string, version: string, expectedVersion: string, expectedEnabled: boolean, requestId: string) => {
      check()
      if (!runtime.dsh || !this.options.pluginUpdate) return { application: 'failed', error: { code: 'reconnect-required' } }
      const input = { root: runtime.gateway.receipt.root, node: runtime.node, dsh: runtime.dsh, name, version, expectedVersion, expectedEnabled, requestId }
      const source = this.options.pluginUpdate
        + `\ntry { console.log('DSH_PLUGIN_RESULT:' + JSON.stringify(await stagePluginUpdate(${JSON.stringify(input)}))) } catch { console.log('DSH_ERROR: Plugin update result is unconfirmed. Inspect its private receipt before another update.'); process.exitCode=1 }\n`
      let result: { application: string; error?: { code: string }; version?: string } | undefined
      await remoteScript(this.engine, alias, `${shellQuote(runtime.node)} --input-type=module`, source, line => {
        check()
        if (line.startsWith('DSH_PLUGIN_RESULT:')) result = JSON.parse(line.slice('DSH_PLUGIN_RESULT:'.length))
      }, 600000, expectedUpdatedAt)
      check()
      if (!result) throw new Error('Plugin update result unconfirmed; not replayed')
      return result
    }
    return { hostId, version: runtime.gateway.receipt.version, gateway: runtime.gateway, check, stageUpdate }
  }
  connectedModelHosts() {
    return [...this.runtimes.values()].filter(row => this.enabled && !this.disposed && !this.carrierBroken(row) && this.ownerMatches(row.alias, row.hostId, row.updatedAt))
      .map(row => ({ alias: row.alias, updatedAt: row.updatedAt }))
  }
  modelIdentity(alias: string, expectedUpdatedAt: number) {
    const hostId = this.hostId(alias)
    this.assertOwner(alias, hostId, expectedUpdatedAt)
    return { hostId }
  }
  modelAccess(alias: string, expectedUpdatedAt: number) {
    const access = this.pluginAccess(alias, expectedUpdatedAt), runtime = this.runtimes.get(access.hostId)!
    if (this.carrierBroken(runtime)) throw new Error('Remote DSH is disconnected. Open the workspace before syncing models.')
    return { ...access, open: () => { access.check(); return runtime.gateway.launch() }, stageBridge: async () => {
      access.check()
      const source = this.options.modelBridge
      if (!source || !this.options.pluginUpdate) throw new Error('Model bridge source is unavailable')
      const hash = createHash('sha256').update(source).digest('hex'), version = `0.0.0-${hash.slice(0, 16)}`
      const name = `@jay-local/dsh-ssh-model-bridge-${hash.slice(0, 16)}`
      const root = runtime.gateway.receipt.root
      const files = {
        'index.mjs': source,
        'package.json': JSON.stringify({ name, version, type: 'module', main: 'index.mjs', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
        'cordis.patch.yml': `- insert:\n    - id: ssh-model-bridge-${hash.slice(0, 16)}\n      name: "${name}"\n`,
      }
      const script = `import {mkdir,open,readFile,lstat} from 'node:fs/promises';import {join} from 'node:path';
const root=${JSON.stringify(root)},hash=${JSON.stringify(hash)},files=${JSON.stringify(files)};
try{const dir=join(root,'model-bridge','bundles-v2',hash);await mkdir(dir,{recursive:true,mode:0o700});
if((await lstat(dir)).isSymbolicLink())throw Error();
for(const [name,value] of Object.entries(files)){const path=join(dir,name);try{const f=await open(path,'wx',0o600);try{await f.writeFile(value)}finally{await f.close()}}catch(e){if(e.code!=='EEXIST'||!(await lstat(path)).isFile()||await readFile(path,'utf8')!==value)throw Error()}}
console.log('DSH_MODEL_BUNDLE:'+JSON.stringify({spec:'link:'+dir,version:${JSON.stringify(version)}}));}catch{console.log('DSH_ERROR: Private model helper staging is unconfirmed; not replayed.');process.exitCode=1}`
      let bundle: { spec: string; version: string } | undefined
      await remoteScript(this.engine, alias, `${shellQuote(runtime.node)} --input-type=module`, script, line => {
        if (line.startsWith('DSH_MODEL_BUNDLE:')) bundle = JSON.parse(line.slice('DSH_MODEL_BUNDLE:'.length))
      }, 30000, expectedUpdatedAt)
      access.check()
      if (!bundle || !bundle.spec.startsWith(`link:${root}/model-bridge/`) || bundle.version !== version) throw new Error('Model helper staging was not confirmed')
      let staged: { application: string; version?: string } | undefined
      const prepare = `${this.options.pluginUpdate}\ntry{console.log('DSH_MODEL_PREPARED:'+JSON.stringify(await stageModelBridge(${JSON.stringify({ root, node: runtime.node, dsh: runtime.dsh, hash })})))}catch{console.log('DSH_ERROR: Model helper preparation is unconfirmed; inspect its private receipt. No command was replayed.');process.exitCode=1}`
      await remoteScript(this.engine, alias, `${shellQuote(runtime.node)} --input-type=module`, prepare, line => {
        if (line.startsWith('DSH_MODEL_PREPARED:')) staged = JSON.parse(line.slice('DSH_MODEL_PREPARED:'.length))
      }, 600000, expectedUpdatedAt)
      access.check()
      if (staged?.application !== 'staged' || staged.version !== version) throw new Error('Model helper CLI preparation failed; inspect its private receipt')
      return { ...bundle, name, staged: true }
    } }
  }
  historyCopies() { return this.historyCache.status() }
  viewObservationPresence() { return this.viewReceipts.available() }
  async viewObservationHosts(after = '') {
    const page = await this.viewReceipts.hosts(after)
    return { hosts: page.items.map(hostId => ({ hostId, alias: [...this.workspaces.values()].find(row => row.hostId === hostId)?.alias })), ...(page.next ? { next: page.next } : {}), ...(page.issue ? { issue: page.issue } : {}) }
  }
  viewObservations(hostId: string, after = '') { return this.viewReceipts.list(hostId, after) }
  dismissViewObservation(hostId: string, observationId: string) { return this.viewReceipts.dismiss(hostId, observationId) }
  auditHistory() { return this.historyCache.cache.audit?.() }
  finishHistoryClear(selection: { key: string; generation: number }[]) {
    if (!this.historyCache.cache.finishClear) throw new Error('Interrupted clear recovery is unavailable in this storage')
    return this.historyCache.cache.finishClear(selection)
  }
  historyEvent(key:string,seq:number) { return this.historyCache.cache.event?.(key,seq) }
  historyCopy(key: string, window?: {beforeSeq?:number;limit:number}) {
    return window && this.historyCache.cache.window ? this.historyCache.cache.window(key,window.beforeSeq,window.limit) : this.historyCache.cache.read(key)
  }
  async cachedHistory(id: string, sessionId: string, window?: {beforeSeq?:number;limit:number}) {
    const item = this.workspaces.get(id)
    if (!item) throw new Error('Unknown remote workspace')
    return this.historyCopy(historyKey(item.hostId, item.workspaceId, sessionId),window)
  }
  syncHistory(id: string, sessionId: string): void {
    const item = this.workspaces.get(id)
    if (!item) throw new Error('Unknown remote workspace')
    void this.historyCache.sync(item, sessionId)
  }
  /** Keep opted-in disk copies current even with no sidebar mounted. The saved
   * registry is never an instruction to connect a Host or activate a Session. */
  private async refreshSavedHistories():Promise<void>{
    if(this.disposed||!this.enabled||this.refreshingHistory)return
    this.refreshingHistory=true
    try{
      const {entries}=await this.historyCache.cache.list()
      for(const meta of entries){
        if(this.disposed||!this.enabled)return
        const item=[...this.workspaces.values()].find(item=>item.hostId===meta.hostId&&item.workspaceId===meta.workspaceId)
        if(!item)continue
        const runtime=this.runtimes.get(item.hostId)
        if(!runtime||this.carrierBroken(runtime)||!this.ownerMatches(item.alias,item.hostId,runtime.updatedAt))continue
        const summary=this.sessionCache.get(item.id,item.workspaceId).sessions.find(row=>row.sessionId===meta.sessionId)
        void this.historyCache.sync(item,meta.sessionId,false,summary?.updatedAt,summary?.running)
      }
    }finally{this.refreshingHistory=false}
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
  async status(): Promise<Array<{ hostId: string; phase: RemotePhase; checkedAt?:number; checking?:boolean }>> {
    const pending = [...this.operations.values()].filter(x => x.hostId && !['ready', 'failed'].includes(x.phase))
    return [...new Set([...this.catalog().map(x => x.hostId), ...pending.map(x => x.hostId!)])].map(hostId => {
      const preparing = pending.find(x => x.hostId === hostId)
      if (preparing) return { hostId, phase: preparing.phase }
      const runtime = this.runtimes.get(hostId)
      if(!runtime||!this.ownerMatches(runtime.alias,hostId,runtime.updatedAt))return{hostId,phase:'disconnected' as const}
      const health=runtime.health
      if(!health||Date.now()-health.checkedAt>=5000)void this.probeHealth(runtime).catch(()=>{})
      const stale=!health||Date.now()-health.checkedAt>=10000
      return {hostId,phase:!health||stale?'connecting' as const:health.healthy?'ready' as const:'disconnected' as const,
        ...(health?{checkedAt:health.checkedAt}:{}),checking:!!runtime.healthRead}
    })
  }
  private probeHealth(runtime:Runtime):Promise<boolean>{
    if(runtime.healthRead)return runtime.healthRead
    const port=runtime.gateway.localPort
    const read=(async()=>{
      const healthy=await runtime.gateway.healthy()
      if(!this.disposed&&this.enabled&&this.runtimes.get(runtime.hostId)===runtime&&runtime.gateway.localPort===port
        &&this.ownerMatches(runtime.alias,runtime.hostId,runtime.updatedAt)){
        runtime.health={healthy,checkedAt:Date.now()};if(!healthy)this.invalidateCatalog(runtime)
      }
      return healthy
    })().finally(()=>{if(runtime.healthRead===read)runtime.healthRead=undefined})
    runtime.healthRead=read;return read
  }
  /** Health reads and SSH tunnel handshakes may repeat; user commands and writes never do. */
  async repairConnections(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map(async runtime => {
      if (this.disposed || !this.enabled || runtime.repairing || runtime.retryAt > Date.now()) return
      runtime.repairing = true
      let replacement: string | undefined
      try {
        this.assertOwner(runtime.alias, runtime.hostId, runtime.updatedAt)
        const broken = this.carrierBroken(runtime)
        const healthy = !broken && await this.probeHealth(runtime)
        if (this.disposed || !this.enabled || this.runtimes.get(runtime.hostId) !== runtime) return
        if (healthy) { runtime.failures = 0; runtime.healthMisses = 0; return }
        runtime.healthMisses = (runtime.healthMisses ?? 0) + 1
        // A slow HTTP response is not proof that a live terminal or SSH
        // transport failed. Only consecutive failed recovery rounds count.
        if (!broken && runtime.healthMisses < 3) return
        if (!broken && !runtime.gateway.canReplaceTunnel()) return
        this.invalidateCatalog(runtime)
        this.assertOwner(runtime.alias, runtime.hostId, runtime.updatedAt)
        const tunnel = await this.engine.startWorkspaceTunnel(runtime.alias, runtime.gateway.receipt.port, runtime.updatedAt)
        replacement = tunnel.id
        if (this.disposed || !this.enabled || this.runtimes.get(runtime.hostId) !== runtime) return
        this.assertOwner(runtime.alias, runtime.hostId, runtime.updatedAt)
        const previousPort = runtime.gateway.localPort
        await runtime.gateway.replaceTunnel(tunnel.localPort)
        if (this.disposed || !this.enabled || !this.ownerMatches(runtime.alias, runtime.hostId, runtime.updatedAt) || this.runtimes.get(runtime.hostId) !== runtime) return
        const previousTunnel = runtime.tunnelId
        runtime.tunnelId = tunnel.id; replacement = undefined; runtime.failures = 0; runtime.healthMisses = 0
        runtime.health={healthy:true,checkedAt:Date.now()}
        await runtime.gateway.retireTunnel(previousPort, () => { this.engine.stopWorkspaceTunnel(previousTunnel) })
      } catch { runtime.retryAt = Date.now() + Math.min(30000, 1000 * 2 ** ++runtime.failures) }
      finally { if (replacement) this.engine.stopWorkspaceTunnel(replacement); runtime.repairing = false }
    }))
  }
  private carrierBroken(runtime: Runtime): boolean {
    const tunnel = this.engine.tunnels?.get(runtime.tunnelId)
    return tunnel ? tunnel.record.broken : this.engine.tunnels !== undefined || this.engine.pool?.get(runtime.alias)?.broken === true
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
    if (runtime && runtime.updatedAt !== updatedAt) {
      runtime.gateway.dispose(); this.engine.stopWorkspaceTunnel(runtime.tunnelId); this.runtimes.delete(hostId); runtime = undefined
    }
    // Navigation must not destroy a retained guest on one slow health read.
    // Existing runtimes use their actual RPC; a proven broken carrier may
    // reconnect first, without replaying a workspace operation or setup.
    if (runtime && this.carrierBroken(runtime)) await this.repairConnections()
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
      const source = `${this.options.bootstrap}\ntry { console.log('DSH_RECEIPT:' + JSON.stringify(await bootstrapRemote(${JSON.stringify({ ...installed, directory: remotePath, supportedVersions: REMOTE_DSH_VERSIONS, ...(this.options.accountService && this.options.accountBridge ? { account: { serviceSource: this.options.accountService, bridgeSource: this.options.accountBridge, ...(this.options.remoteRoot ? { home: posix.join(installed.root, 'data'), installEntry: false, port: 0 } : {}) } } : {}) })}))) } catch { console.log('DSH_ERROR: Remote DSH startup failed. Inspect the private state/server.log and state/server.json; no restart was attempted.'); process.exitCode=1 }\n`
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
      const installedNode = installed.node, ownerReceipt = receipt
      const gateway = new RemoteGateway(tunnel.localPort, receipt, alias, this.options.returnUrl(), hostId, this.recoveryProof(hostId), this.drafts, this.viewReceipts, this.bootAssets,
        async input => { check(); const value = await readBootArtifact(this.engine, alias, installedNode, ownerReceipt, input, updatedAt); check(); return value })
      try {
        await gateway.start(await this.gatewayOrigins.preferred(hostId, this.options.returnUrl()))
        await this.gatewayOrigins.remember(hostId, this.options.returnUrl(), Number(new URL(gateway.origin).port))
      } catch (error) { gateway.dispose(); this.engine.stopWorkspaceTunnel(tunnel.id); throw error }
      try { check() } catch (error) { gateway.dispose(); this.engine.stopWorkspaceTunnel(tunnel.id); throw error }
      runtime = { node: installed.node, dsh: installed.dsh, gateway, tunnelId: tunnel.id, hostId, alias, updatedAt, retryAt: 0, failures: 0,health:{healthy:true,checkedAt:Date.now()} }; this.runtimes.set(hostId, runtime)
      const owner = runtime
      gateway.onCatalogChange = () => {
        if (this.runtimes.get(hostId) !== owner) return
        this.invalidateCatalog(owner)
      }
      remotePath = receipt.directory
    }
    this.phase(operation, 'connecting')
    check()
    if (this.onModelsConnected) await this.onModelsConnected(alias, updatedAt)
    check()
    if (remotePath === '~') remotePath = runtime.gateway.receipt.userHome
    else if (remotePath.startsWith('~/')) remotePath = posix.join(runtime.gateway.receipt.userHome, remotePath.slice(2))
    if (!remotePath.startsWith('/')) throw new Error('Choose an absolute remote directory or ~/path')
    this.invalidateCatalog(runtime)
    let value: { workspace: { workspaceId: string; path: string; title: string; sessionIds: string[] } }
    try { value = await runtime.gateway.rpc('workspace/create', { request: { path: remotePath } }) }
    finally { this.invalidateCatalog(runtime) }
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
  /** Fence reads dispatched before a mutation or carrier change, including
   * replies already queued in the event loop. Invalidating a Promise alone
   * cannot prevent that old Promise from installing its result later. */
  private invalidateCatalog(runtime: Runtime): void {
    runtime.catalogRevision = (runtime.catalogRevision ?? 0) + 1
    runtime.catalog = undefined
    for (const item of this.workspaces.values()) if (item.hostId === runtime.hostId) this.catalogReads.delete(item.id)
  }
  private assertCatalogCurrent(runtime: Runtime, catalog: HostCatalog): void {
    if (catalog.revision !== (runtime.catalogRevision ?? 0)) throw new SupersededCatalogError()
  }
  /** A pushed increment invalidates the old reply, not the operation being
   * observed. Re-query these two read-only lists at most once on the existing
   * carrier; never retry transport errors, writes or changed Host ownership.
   * Consume synchronously under the final revision check, with no await gap
   * between validation and installing a Session list or history source. */
  private async withCatalog<T>(runtime: Runtime, consume: (catalog: HostCatalog) => T, foreground = false): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (this.disposed || !this.enabled || this.runtimes.get(runtime.hostId) !== runtime
        || !this.ownerMatches(runtime.alias, runtime.hostId, runtime.updatedAt)) throw new Error('Remote connection changed')
      try {
        const catalog = await this.hostCatalog(runtime, foreground)
        this.assertCatalogCurrent(runtime, catalog)
        return consume(catalog)
      } catch (error) {
        const interrupted = foreground && error instanceof CatalogReadError && error.code === 'transport'
        if (!(error instanceof SupersededCatalogError) && !interrupted || attempt >= 1) throw error
      }
    }
  }
  /** Metadata reads use an existing carrier only; opening the sidebar never starts SSH. */
  private hostCatalog(runtime: Runtime, foreground = false): Promise<HostCatalog> {
    if (runtime.catalog && runtime.catalog.expiresAt > Date.now()) {
      if (foreground) { runtime.catalog.priority.foreground = true; runtime.gateway.prioritizeCatalog() }
      return runtime.catalog.read
    }
    // All projects on a Host share the same remote workspace/session lists.
    // Coalesce concurrent reads and short bursts; retain no Session content.
    const revision = runtime.catalogRevision ?? 0
    const priority = { foreground }
    const entry: NonNullable<Runtime['catalog']> = { expiresAt: Infinity, priority, read: Promise.all([
      runtime.gateway.workspaceCatalogSnapshot(priority), runtime.gateway.rpc<HostCatalog['sessions']>('session/list', { _request: {} }, 30000, priority),
    ])
      .then(([workspaces, sessions]) => {
        if (!Array.isArray(workspaces.items) || !Array.isArray(workspaces.archivedSessionIds) || !Array.isArray(sessions.items)) throw new Error('Remote catalog is incompatible')
        // Active work keeps the short status cadence. Quiet Hosts share a
        // longer snapshot; mutations and directory pushes still invalidate it.
        const checkedAt = Date.now(); entry.expiresAt = checkedAt + (sessions.items.some(row => row.running) ? 2000 : 15000)
        const catalog = { workspaces, sessions, checkedAt, revision }
        this.assertCatalogCurrent(runtime, catalog)
        return catalog
      }).catch(error => {
        if (runtime.catalog === entry) runtime.catalog = undefined
        // A carrier replacement invalidates failed reads as well as late
        // successful replies. Continue the read on the current carrier once.
        if (revision !== (runtime.catalogRevision ?? 0) && (!(error instanceof CatalogReadError) || error.code === 'transport')) throw new SupersededCatalogError()
        throw error
      }) }
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
        return await this.withCatalog(runtime, snapshot => {
          const { workspaces, sessions: result, checkedAt } = snapshot
          this.assertActive(epoch); this.assertOwner(item.alias, item.hostId, runtime.updatedAt)
          if (this.runtimes.get(item.hostId) !== runtime) throw new Error('Remote connection changed')
          const workspace = workspaces.items.find(x => x.workspaceId === item.workspaceId)
          if (!workspace || !Array.isArray(workspace.sessionIds) || !Array.isArray(result.items)) throw new Error('Remote workspace catalog is incompatible')
          const members = new Set(workspace.sessionIds), archived = new Set(workspaces.archivedSessionIds), pinned = new Set(workspaces.pinnedSessionIds ?? [])
          const all = result.items.filter(x => members.has(x.sessionId) && x.origin !== 'subagent')
            .map(x => ({ sessionId: x.sessionId, title: typeof x.projections?.values?.title === 'string' ? x.projections.values.title.slice(0, 1024) : '',
              running: x.running === true, blank: x.blank === true, updatedAt: Number.isFinite(x.updatedAt) ? x.updatedAt : 0, ...(pinned.has(x.sessionId) ? { pinned: true } : {}) }))
            .sort((a, b) => b.updatedAt - a.updatedAt)
          const sessions = all.filter(row => !archived.has(row.sessionId)), archivedSessions = all.filter(row => archived.has(row.sessionId))
          const catalog: RemoteSessionCatalog = { workspaceId: item.workspaceId, sessions, ...(archivedSessions.length ? { archivedSessions } : {}), stale: false, checkedAt }
          this.sessionCache.save(id, catalog)
          for (const session of sessions) void this.historyCache.sync(item, session.sessionId, false, session.updatedAt, session.running)
          return { ...catalog, ...(this.sessionCache.warning ? { warning: this.sessionCache.warning } : {}) }
        })
      } catch(error) { return { ...cached(), warning: error instanceof CatalogReadError ? error.message : 'Remote session status could not be checked. Showing the last saved list.' } }
    })()
    this.catalogReads.set(id, read)
    try { return await read } finally { if (this.catalogReads.get(id) === read) this.catalogReads.delete(id) }
  }
  async createSession(id: string): Promise<{ sessionId: string }> {
    const { item, runtime, check } = await this.connectedWorkspace(id)
    this.invalidateCatalog(runtime)
    try {
      const result = await runtime.gateway.rpc<{ sessionId: string }>('session/create', { request: { workspaceId: item.workspaceId } })
      check(); return result
    } finally { this.invalidateCatalog(runtime) }
  }
  /** Explicit metadata mutations use the owning connected Host once. No retry. */
  async sessionAction(id: string, sessionId: string, action: string, title?: string, stopActivity = false, expectedHostId?: string): Promise<RemoteForkResult | void> {
    const methods: Record<string, string> = { pin: 'workspace/pinSession', unpin: 'workspace/unpinSession', archive: 'workspace/archiveSession', unarchive: 'workspace/unarchiveSession', rename: 'session/rename', fork: 'session/fork' }
    if (!Object.hasOwn(methods, action) || !sessionId || sessionId.length > 256 || /[\u0000-\u001f\u007f]/.test(sessionId)
      || action === 'rename' && (typeof title !== 'string' || !title.trim() || title.length > 1024)
      || action === 'fork' && title !== undefined && title.length > 1024) throw new Error('Invalid remote Session action')
    const forkTitle = title?.trim() ? title : undefined
    let childTitle: string | undefined
    if (action === 'fork' && forkTitle !== undefined) {
      const numbered = /^(.*?)(\(|（)(\d+)(\)|）)$/u.exec(forkTitle)
      const candidate = numbered && (numbered[2] === '(' ? numbered[4] === ')' : numbered[4] === '）')
        ? `${numbered[1]}${numbered[2]}${BigInt(numbered[3]!) + 1n}${numbered[4]}` : `${forkTitle} (1)`
      // Keep the inherited name when incrementing it cannot fit. Decide before
      // creating a child so a display limit never turns success into a failure.
      if (candidate.length <= 1024) childTitle = candidate
    }
    const { item, runtime, check } = await this.connectedWorkspace(id)
    if (expectedHostId !== undefined && item.hostId !== expectedHostId) throw new Error('Remote Host identity changed')
    await this.withCatalog(runtime, catalog => {
      check()
      if (!catalog.workspaces.items.some(row => row.workspaceId === item.workspaceId && row.sessionIds.includes(sessionId))) throw new Error('Session does not belong to this remote workspace')
    })
    check(); this.invalidateCatalog(runtime)
    try {
      const result = await runtime.gateway.rpc<{ sessionId: string }>(methods[action]!, { request: { sessionId,
        ...(action === 'rename' ? { title: title!.trim() } : {}), ...(action === 'archive' && stopActivity ? { stopActivity: true } : {}) } })
      check()
      if (action === 'fork') {
        if (typeof result?.sessionId !== 'string' || !result.sessionId || result.sessionId === sessionId) throw new Error('Remote fork acknowledgement is unconfirmed; inspect the remote Session list before another action')
        let titleUnconfirmed: true | undefined
        if (childTitle !== undefined) {
          try { await runtime.gateway.rpc('session/rename', { request: { sessionId: result.sessionId, title: childTitle } }) }
          catch { titleUnconfirmed = true } // The child is known; never fork it again to recover its title.
          check()
        }
        return { sessionId: result.sessionId, ...(titleUnconfirmed ? { titleUnconfirmed } : {}) }
      }
    } finally { this.invalidateCatalog(runtime) }
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
  async open(id: string, preferredSessionId?: string, hostname?: 'localhost'): Promise<{ url: string; sessionId: string }> {
    const { item, runtime, check } = await this.connectedWorkspace(id)
    if (preferredSessionId !== undefined && (!preferredSessionId || preferredSessionId.length > 256 || /[\u0000-\u001f\u007f]/.test(preferredSessionId))) throw new Error('Invalid remote session identity')
    const members=await this.withCatalog(runtime,catalog=>{
      check()
      const workspace=catalog.workspaces.items.find(row=>row.workspaceId===item.workspaceId)
      if(!workspace)throw new Error('Remote workspace is no longer available')
      if(preferredSessionId&&!workspace.sessionIds.includes(preferredSessionId))throw new Error('Session does not belong to this remote workspace')
      return workspace.sessionIds
    }, true)
    let sessionId = preferredSessionId ?? members.at(-1)
    if (!sessionId) {
      this.invalidateCatalog(runtime)
      try { sessionId = (await runtime.gateway.rpc<{ sessionId: string }>('session/create', { request: { workspaceId: item.workspaceId } })).sessionId }
      finally { this.invalidateCatalog(runtime) }
    }
    check()
    this.syncHistory(id, sessionId)
    return { url: runtime.gateway.launch(sessionId, hostname), sessionId }
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
  dispose(): Promise<void> {
    this.setEnabled(false); this.disposed = true; clearInterval(this.recovery)
    return Promise.all([this.historyCache.cache.close?.().catch(() => {}), this.drafts.close().catch(() => {}), this.viewReceipts.close()]).then(() => {})
  }
}
