import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync } from 'node:fs'
import { dshHome } from '../dsh-home.ts'
import type { RemoteWorkspaces } from './manager.ts'
import type { ModelBridgeView, ModelFollowMode, ModelFollowPolicyChange, ModelFollowRow, ModelFollowView } from './model-types.ts'

type ObjectValue = Record<string, any>
interface DirectoryRow { provider: string; displayName: string; settingsNs: string; settingsPath: string[] }
export interface ModelContext { get(name: string): any }
interface SourceRow { ns: string; path: string[]; provider: string; label: string; config: ObjectValue; key: string }
interface Source { providers: SourceRow[]; skipped: ModelFollowRow[]; defaultSelection?: { provider: string; model: string; reasoningEffort?: string } }
interface Policy { mode: ModelFollowMode; providers: Record<string, ModelFollowMode>; reset: string[] }
interface HostState {
  policy: Policy; view?: ModelFollowView; source?: string
  policyRevision?: number
  pending?: { id: string; source: string }; helperPending?: boolean
}
interface DiskState { version: 1; key: string; hosts: Record<string, HostState> }
const plain = (x: unknown): x is ObjectValue => x !== null && typeof x === 'object' && !Array.isArray(x)
const at = (value: any, path: string[]) => path.reduce((v, key) => plain(v) ? v[key] : undefined, value)
const stable = (value: unknown) => JSON.stringify(value, (_, v) => plain(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v)
const rowId = (row: SourceRow) => `${row.ns}:${row.provider}`
const publicRow = (row: ModelFollowRow): ModelFollowRow => ({ id: row.id, provider: row.provider, label: row.label,
  mode: row.mode, status: row.status, ...(row.reason ? { reason: row.reason } : {}),
  ...(row.modelCount !== undefined ? { modelCount: row.modelCount } : {}), ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}) })
const endpointSafe = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.every(endpointSafe)
  if (!plain(value)) return true
  return Object.entries(value).every(([k, v]) => {
    if (['__proto__', 'constructor', 'prototype'].includes(k) || /cookie|oauth|refreshToken/i.test(k)) return false
    if (/^(?:baseURL|baseUrl|endpoint)$/.test(k) && typeof v === 'string') {
      try { const u = new URL(v), host = u.hostname.toLowerCase().replace(/[\[\]]/g, '').replace(/\.$/, '')
        if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash
          || host === 'localhost' || host.endsWith('.localhost') || host.startsWith('127.') || ['0.0.0.0', '::', '::1'].includes(host)
          || /^::ffff:(?:127\.|7f[0-9a-f]{2}:)/.test(host)) return false } catch { return false }
    }
    return endpointSafe(v)
  })
}

/** Resolve only explicit API-key routes from this profile's own native services. */
export async function localModelSource(ctx: ModelContext): Promise<Source> {
  const settings = ctx.get('settings'), credentials = ctx.get('credentials'), llm = ctx.get('llm')
  if (!settings || !credentials || !llm?.listConfigurableProviders) return { providers: [], skipped: [] }
  const providers: SourceRow[] = [], skipped: ModelFollowRow[] = [], seen = new Set<string>()
  const directory: DirectoryRow[] = llm.listConfigurableProviders()
  if (!Array.isArray(directory) || directory.length > 2000) throw new Error('Invalid local model directory')
  const sections = new Map(settings.describe().map((row: { ns: string; value: unknown }) => [row.ns, row.value]))
  for (const entry of directory) {
    if (entry.provider === 'deepseek-account' || !Array.isArray(entry.settingsPath)) continue
    const raw = at(sections.get(entry.settingsNs), entry.settingsPath)
    if (raw !== undefined && !plain(raw)) continue
    const ref = raw?.apiKeyEnv
    if (ref !== undefined && (typeof ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,150}$/.test(ref))) continue
    const id = `${entry.settingsNs}:${entry.provider}`
    if (seen.has(id)) continue
    seen.add(id)
    const profile = JSON.parse(JSON.stringify(raw ?? {})) as ObjectValue
    const meta = { id, provider: entry.provider, label: entry.displayName.slice(0, 256), mode: 'follow' as const, status: 'blocked' as const }
    let recordKey: string | undefined
    if (ref === undefined && entry.settingsPath[0] === 'providers' && credentials.describeRecord) {
      const key = `llm-pi-ai/${entry.provider}`, info = await credentials.describeRecord(key)
      if (info?.configured && info.kind === 'grant') { skipped.push({ ...meta, reason: 'login-auth' }); continue }
      if (info?.configured && info.kind === 'api-key') recordKey = key
    }
    if (ref === undefined && !recordKey) continue
    if (!endpointSafe(profile)) { skipped.push({ ...meta, reason: 'local-endpoint' }); continue }
    const record = recordKey ? await credentials.readRecord(recordKey) : undefined
    const key = ref !== undefined ? (await credentials.resolve(ref))?.value : record?.kind === 'api-key' ? record.key : undefined
    if (typeof key !== 'string' || !key.trim()) { skipped.push({ ...meta, reason: 'missing-key' }); continue }
    providers.push({ ns: entry.settingsNs, path: [...entry.settingsPath], provider: entry.provider, label: meta.label, config: profile, key })
  }
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  return { providers, skipped, ...(selection && typeof selection.provider === 'string' && typeof selection.model === 'string'
    ? { defaultSelection: JSON.parse(JSON.stringify(selection)) } : {}) }
}

/** Automatic sync is confined to existing authenticated carriers. No tool exposes keys. */
export class ServerModels {
  private disk: DiskState
  private running = new Map<string, Promise<void>>()
  private timer: ReturnType<typeof setInterval>
  private disposed = false
  private generation = 0
  private issue = false
  constructor(private manager: Pick<RemoteWorkspaces, 'modelIdentity' | 'modelAccess' | 'connectedModelHosts'>,
    private source: () => Promise<Source>, private bridgeHash: string,
    private filename = join(dshHome(), 'remote-workspaces', 'model-follow.json')) {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
    try {
      const info = lstatSync(filename)
      if (!info.isFile() || (info.mode & 0o077)) throw Error('private-state-required')
      this.disk = JSON.parse(readFileSync(filename, 'utf8')) as DiskState
      if (this.disk.version !== 1 || typeof this.disk.key !== 'string' || !plain(this.disk.hosts)) throw Error('invalid-state')
      for (const host of Object.values(this.disk.hosts)) {
        if (!plain(host) || !plain(host.policy) || !['follow', 'independent'].includes(host.policy.mode)
          || !plain(host.policy.providers) || !Array.isArray(host.policy.reset) || host.view && !Array.isArray(host.view.rows)) throw Error('invalid-state')
        if ((host.pending || host.helperPending && host.view?.state !== 'restart-required') && host.view) host.view.state = 'uncertain'
      }
    } catch (error) {
      this.issue = (error as NodeJS.ErrnoException).code !== 'ENOENT'
      this.disk = { version: 1, key: randomBytes(32).toString('hex'), hosts: {} }
    }
    this.timer = setInterval(() => { void this.changed() }, 30000); this.timer.unref?.()
  }
  dispose() { this.disposed = true; this.generation++; clearInterval(this.timer) }
  private save() {
    if (this.issue) throw Error('Model sync state is unavailable; existing file retained')
    const tmp = `${this.filename}.${randomUUID()}.tmp`
    try { writeFileSync(tmp, JSON.stringify(this.disk), { mode: 0o600, flag: 'wx' }); renameSync(tmp, this.filename) }
    catch { this.issue = true; throw Error('Model sync state could not be saved') }
  }
  private host(alias: string, updatedAt: number) {
    if (this.disposed) throw Error('Model sync is stopped')
    const identity = this.manager.modelIdentity(alias, updatedAt)
    const state = this.disk.hosts[identity.hostId] ??= { policy: { mode: 'follow', providers: {}, reset: [] } }
    return { identity, state }
  }
  view(alias: string, updatedAt: number): ModelFollowView {
    const { state } = this.host(alias, updatedAt)
    const connected = this.manager.connectedModelHosts().some(row => row.alias === alias && row.updatedAt === updatedAt)
    const view = state.view ?? { alias, mode: state.policy.mode, connected, state: this.issue ? 'uncertain' : 'idle', rows: [] }
    return { alias, mode: state.policy.mode, connected, state: view.state, ...(view.checkedAt ? { checkedAt: view.checkedAt } : {}),
      ...(view.default ? { default: { mode: view.default.mode, status: view.default.status } } : {}),
      ...(view.default && state.policy.providers['@default'] === 'independent' ? { default: { mode: 'independent' as const, status: 'independent' as const } } : {}),
      rows: view.rows.map(row => ({ ...publicRow(row), ...(state.policy.mode === 'independent' || state.policy.providers[row.id] === 'independent' ? { mode: 'independent', status: 'independent' } : {}) })) }
  }
  async setPolicy(alias: string, updatedAt: number, change: ModelFollowPolicyChange) {
    // Validate the complete request before touching a host's active policy.
    // In particular, an invalid combined request must not turn an independent
    // host back into a follower and let the background loop copy credentials.
    if (!plain(change)) throw Error('Invalid model sync policy')
    if (change.mode !== undefined && !['follow', 'independent'].includes(change.mode)) throw Error('Invalid model sync mode')
    if (change.provider !== undefined && (typeof change.provider !== 'string'
      || !/^(?:@default|[a-z][a-z0-9-]{0,100}:[A-Za-z0-9_./-]{1,200})$/.test(change.provider)
      || !['follow', 'independent'].includes(change.providerMode ?? ''))) throw Error('Invalid provider mode')
    const { state } = this.host(alias, updatedAt)
    if (change.mode !== undefined) {
      state.policy.mode = change.mode
    }
    if (change.provider !== undefined) {
      state.policy.providers[change.provider] = change.providerMode!
      if (change.providerMode === 'follow' && !state.policy.reset.includes(change.provider)) state.policy.reset.push(change.provider)
    }
    state.policyRevision = (state.policyRevision ?? 0) + 1; state.source = undefined; this.save()
    if (state.policy.mode === 'follow') await this.sync(alias, updatedAt)
    return this.view(alias, updatedAt)
  }
  async changed() {
    if (this.disposed || this.issue) return
    await Promise.allSettled(this.manager.connectedModelHosts().map(row => this.sync(row.alias, row.updatedAt)))
  }
  open(alias: string, updatedAt: number) { return { url: this.manager.modelAccess(alias, updatedAt).open() } }
  sync(alias: string, updatedAt: number): Promise<void> {
    if (this.disposed || this.issue) return Promise.resolve()
    const { identity, state } = this.host(alias, updatedAt)
    // Choosing a policy before opening a workspace only saves local intent.
    // A missing carrier is not a dispatched operation with an unknown result.
    // Leave any genuine pending/helper receipt intact for reconnection.
    if (state.policy.mode === 'independent'
      || !this.manager.connectedModelHosts().some(row => row.alias === alias && row.updatedAt === updatedAt)) return Promise.resolve()
    const previous = this.running.get(identity.hostId)
    if (previous) return previous
    const read = this.run(alias, updatedAt).catch(() => {
      state.view ??= { alias, mode: state.policy.mode, connected: true, state: 'uncertain', rows: [] }
      state.view.state = 'uncertain'; state.view.rows = state.view.rows.map(row => ({ ...row, status: 'uncertain' }))
      try { this.save() } catch { /* A failed private state store blocks further writes. */ }
    }).finally(() => { if (this.running.get(identity.hostId) === read) this.running.delete(identity.hostId) })
    this.running.set(identity.hostId, read); return read
  }
  private async run(alias: string, updatedAt: number) {
    const { state } = this.host(alias, updatedAt), access = this.manager.modelAccess(alias, updatedAt), epoch = this.generation, policyRevision = state.policyRevision
    const check = () => { access.check(); if (this.disposed || epoch !== this.generation || policyRevision !== state.policyRevision || state.policy.mode !== 'follow') throw Error('Model sync settings changed') }
    const source = await this.source(); check()
    const providers = source.providers.filter(row => state.policy.providers[rowId(row)] !== 'independent')
    const selection = state.policy.providers['@default'] === 'independent' ? undefined : source.defaultSelection
    const sourceHash = createHmac('sha256', this.disk.key).update(stable({ providers, selection,
      policy: { mode: state.policy.mode, providers: state.policy.providers }, bridge: this.bridgeHash, runtime: access.version })).digest('hex')
    if (state.source === sourceHash && !state.pending && !state.helperPending && state.view?.state !== 'uncertain') return
    if (!providers.length && !state.pending && !state.helperPending) {
      const sourceIds = new Set(source.providers.map(rowId))
      const retained = (state.view?.rows ?? []).filter(row => !source.skipped.some(skip => skip.id === row.id)).map(row => sourceIds.has(row.id) ? row
        : { ...row, mode: 'independent' as const, status: 'independent' as const, reason: 'source-removed' })
      state.view = { alias, mode: 'follow', connected: true, state: 'ready', rows: [...retained, ...source.skipped], default: state.view?.default, checkedAt: Date.now() }; state.source = sourceHash; this.save(); return
    }
    let remote: ModelBridgeView | undefined
    try { remote = await access.gateway.modelBridge<ModelBridgeView>({ kind: 'status' }); check() }
    catch (error) { check(); if ((error as { status?: number }).status !== 404) throw error }
    if (remote && (remote.protocol !== 1 || !Array.isArray(remote.providers))) throw Error('Incompatible model bridge')
    if (remote && state.pending) {
      if (remote.lastRequest?.id === state.pending.id && remote.lastRequest.status === 'complete') {
        state.source = state.pending.source; delete state.pending; this.save()
      } else { this.updateView(state, alias, remote, source.skipped, 'uncertain'); this.save(); return }
    }
    if (!remote || remote.build !== this.bridgeHash) {
      if (state.helperPending) { state.view = { alias, mode: 'follow', connected: true,
        state: state.view?.state === 'restart-required' ? 'restart-required' : 'uncertain', rows: source.skipped }; this.save(); return }
      try {
        const settings = await access.gateway.rpc<{ writable: boolean }>('settings/describe', {})
        await access.gateway.rpc('credentials/describe', { refs: [] }); check()
        if (!settings.writable) throw Error('Read-only remote settings')
      } catch {
        check(); state.view = { alias, mode: 'follow', connected: true, state: 'unsupported', rows: source.skipped }
        state.source = sourceHash; this.save(); return
      }
      state.helperPending = true; this.save()
      const bundle = await access.stageBridge(); check()
      // Different bundle names give Node a fresh module identity. Retire only
      // the confirmed previous helper, retaining the daemon and its sessions.
      if (remote && bundle.staged) {
        const previous = await access.gateway.rpc<Array<{ name: string; enabled: boolean }>>('pluginManager/listBundles', {}); check()
        if (!Array.isArray(previous) || previous.length > 2000) throw Error('Invalid model helper inventory')
        const oldName = typeof remote.build === 'string' && /^[a-f0-9]{64}$/.test(remote.build)
          ? `@jay-local/dsh-ssh-model-bridge-${remote.build.slice(0, 16)}` : undefined
        for (const row of previous.filter(row => row.enabled === true && row.name !== bundle.name
          && (row.name === oldName || row.name === '@jay-local/dsh-ssh-model-bridge'))) {
          const disabled = await access.gateway.rpc<{ application: string }>('pluginManager/setBundleEnabled', { name: row.name, enabled: false }, 600000); check()
          if (!['applied', 'restart-required'].includes(disabled.application)) throw Error('Previous model helper retirement is unconfirmed')
        }
      }
      const result = bundle.staged
        ? await access.gateway.rpc<{ application: string }>('pluginManager/setBundleEnabled', { name: bundle.name, enabled: true }, 600000)
        : await access.gateway.rpc<{ application: string }>('pluginManager/installBundle', { spec: bundle.spec, options: { enabled: true } }, 600000)
      check()
      if (result.application !== 'applied') {
        state.view = { alias, mode: 'follow', connected: true, state: result.application === 'restart-required' ? 'restart-required' : 'unsupported', rows: source.skipped }; this.save(); return
      }
      remote = await access.gateway.modelBridge<ModelBridgeView>({ kind: 'status' }); check()
      if (remote.protocol !== 1 || remote.build !== this.bridgeHash) throw Error('Model helper version could not be confirmed')
      delete state.helperPending; this.save()
    } else if (state.helperPending) { delete state.helperPending; this.save() }
    const activeIds = new Set(providers.map(rowId))
    if (remote.providers.some(row => activeIds.has(row.id) && row.status === 'uncertain')
      || selection && remote.default.status === 'uncertain') {
      this.updateView(state, alias, remote, source.skipped, 'uncertain'); this.save(); return
    }
    if (state.source === sourceHash) { this.updateView(state, alias, remote, source.skipped, 'ready'); this.save(); return }
    check()
    const requestId = randomUUID()
    state.pending = { id: requestId, source: sourceHash }
    this.updateView(state, alias, remote, source.skipped, 'syncing'); this.save()
    remote = await access.gateway.modelBridge<ModelBridgeView>({ kind: 'sync', requestId, providers,
      defaultSelection: selection, policy: structuredClone(state.policy) })
    check()
    if (remote.protocol !== 1 || remote.lastRequest?.id !== requestId || remote.lastRequest.status !== 'complete') throw Error('Model sync result is unconfirmed')
    state.source = sourceHash; delete state.pending; state.policy.reset = []
    this.updateView(state, alias, remote, source.skipped, remote.providers.some(row => row.status === 'uncertain') || remote.default.status === 'uncertain' ? 'uncertain' : 'ready'); this.save()
  }
  private updateView(state: HostState, alias: string, remote: ModelBridgeView, skipped: ModelFollowRow[], status: ModelFollowView['state']) {
    state.view = { alias, mode: state.policy.mode, connected: true, state: status, rows: [...remote.providers, ...skipped.filter(row => !remote.providers.some(p => p.id === row.id))].map(publicRow),
      default: { mode: remote.default.mode, status: remote.default.status }, checkedAt: Date.now() }
  }
}

export const modelBridgeHash = (source: string) => createHash('sha256').update(source).digest('hex')
