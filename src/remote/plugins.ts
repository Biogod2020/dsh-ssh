import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { satisfies, valid, validRange } from 'semver'
import type { RemoteWorkspaces } from './manager.ts'
import type { PluginSyncJob, ServerPluginComparison, ServerPluginPackage, ServerPluginRow } from './plugin-types.ts'

interface Bundle {
  name: string; version?: string; enabled: boolean; official?: boolean; installed?: boolean
  availability?: string; source?: string
}
interface Manifest {
  name?: string; version?: string; engines?: { dsh?: string }; dsh?: { engines?: { dsh?: string }; bundle?: unknown }
  peerDependencies?: Record<string, string>
}
interface LocalBundle extends ServerPluginPackage { development: boolean; manifest?: Manifest }
interface Plan { view: ServerPluginComparison; fingerprint: string; access: ReturnType<RemoteWorkspaces['pluginAccess']> }
interface NativeChange { application: string; error?: { code?: string }; version?: string; changed?: boolean }
export interface PluginManagementContext {
  get(name: string): unknown
}
const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const REQUEST = /^[a-zA-Z0-9-]{16,80}$/

/** Use the current profile's own package inventory, without serializing its source specs. */
export async function localPluginPackages(ctx: PluginManagementContext): Promise<LocalBundle[]> {
  const manager = ctx.get('pluginManager') as { listBundles?(): Promise<Bundle[]> } | undefined
  const profile = ctx.get('profileContext') as { dir?: string } | undefined
  if (!manager?.listBundles || !profile?.dir) throw new Error('This DSH does not expose current-profile plugin management')
  const bundles = await manager.listBundles()
  return Promise.all(bundles.filter(row => row.installed && NAME.test(row.name)).map(async row => {
    let manifest: Manifest | undefined
    try { manifest = JSON.parse(await readFile(join(profile.dir!, 'node_modules', row.name, 'package.json'), 'utf8')) as Manifest }
    catch { /* An unreadable version is displayed, never replaced by a guessed package. */ }
    return { ...project(row), development: /^(?:link:|workspace:)/.test(row.source ?? '') || /(?:^|[.-])local(?:[.-]|$)/.test(row.version ?? ''), manifest }
  }))
}
function project(row: Bundle): ServerPluginPackage {
  if (!NAME.test(row.name) || typeof row.enabled !== 'boolean') throw new Error('Invalid plugin inventory')
  return { name: row.name, ...(typeof row.version === 'string' ? { version: row.version } : {}), enabled: row.enabled, official: row.official === true }
}
function remotePackages(rows: Bundle[]): ServerPluginPackage[] {
  if (!Array.isArray(rows) || rows.length > 2000) throw new Error('Invalid remote plugin inventory')
  const selected = rows.filter(row => row.installed || row.enabled || row.availability === 'installation').map(project)
  if (new Set(selected.map(row => row.name)).size !== selected.length) throw new Error('Duplicate remote plugin identity')
  return selected
}
function fingerprint(local: LocalBundle[], remote: ServerPluginPackage[]): string {
  return createHash('sha256').update(JSON.stringify([local.map(({ manifest: _manifest, ...row }) => row).sort(byName), [...remote].sort(byName)])).digest('hex')
}
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
async function mapLimited<T, R>(items: T[], consume: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length); let next = 0
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    for (;;) { const index = next++; if (index >= items.length) return; results[index] = await consume(items[index]!) }
  }))
  return results
}

export function rejectedRequirement(manifest: Manifest, version: string): string | undefined {
  const ranges = [manifest.engines?.dsh, manifest.dsh?.engines?.dsh,
    ...Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')).map(([, range]) => range)]
  return ranges.find(range => range !== undefined && (!validRange(range) || !valid(version) || !satisfies(version, range, { includePrerelease: true })))
}

/** Query an exact public npm version. No local archives, npm auth or local paths are uploaded. */
export async function publicPluginManifest(name: string, version: string): Promise<Manifest | null> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
    redirect: 'error', signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' },
  })
  if (response.status === 404) { await response.body?.cancel(); return null }
  if (!response.ok) { await response.body?.cancel(); throw new Error('Plugin registry unavailable') }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty plugin registry response')
  const chunks: Uint8Array[] = []; let bytes = 0
  try {
    for (;;) {
      const value = await reader.read(); if (value.done) break
      bytes += value.value.byteLength; if (bytes > 2 * 1024 * 1024) throw new Error('Plugin metadata too large')
      chunks.push(value.value)
    }
  } finally { await reader.cancel() }
  const manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Manifest
  if (manifest.name !== name || manifest.version !== version || !manifest.dsh?.bundle) throw new Error('Registry package does not match this plugin')
  return manifest
}

/** Explicit, Host-bound package sync. Reads never connect; writes are dispatched once. */
export class ServerPlugins {
  private plans = new Map<string, Plan>()
  private jobs = new Map<string, PluginSyncJob>()
  private busy = new Set<string>()
  private requests = new Map<string, { binding: string; result: Promise<PluginSyncJob> }>()
  constructor(private manager: Pick<RemoteWorkspaces, 'pluginAccess'>,
    private local: () => Promise<LocalBundle[]>, private manifest = publicPluginManifest) {}

  private async inventories(access: Plan['access']) {
    access.check()
    const [local, raw] = await Promise.all([this.local(), access.gateway.rpc<Bundle[]>('pluginManager/listBundles', {})])
    access.check()
    if (local.length > 1000 || new Set(local.map(row => row.name)).size !== local.length) throw new Error('Invalid local plugin inventory')
    return { local, remote: remotePackages(raw) }
  }
  async compare(alias: string, hostUpdatedAt: number): Promise<ServerPluginComparison> {
    const access = this.manager.pluginAccess(alias, hostUpdatedAt)
    const { local, remote } = await this.inventories(access)
    const rows: ServerPluginRow[] = await mapLimited(local, async item => {
      const other = remote.find(row => row.name === item.name)
      const row: ServerPluginRow = { name: item.name, local: project(item), ...(other ? { remote: other } : {}),
        status: !other ? 'missing' : other.version === item.version ? 'same' : 'different' }
      if (item.official || item.name.startsWith('@deepseek-ai/')) row.block = 'builtin'
      else if (!item.version || !valid(item.version)) row.block = 'missing-version'
      else if (item.development) row.block = 'development'
      else if (!other && !item.enabled) row.block = 'local-disabled'
      else if (row.status !== 'same') {
        try {
          const published = await this.manifest(item.name, item.version)
          if (!published) row.block = 'unpublished'
          else {
            const requirement = rejectedRequirement(published, access.version) ?? (item.manifest && rejectedRequirement(item.manifest, access.version))
            if (requirement) { row.block = 'incompatible'; row.requirement = requirement }
            else row.spec = `${item.name}@${item.version}`
          }
        } catch { row.block = 'registry-unavailable' }
      }
      return row
    })
    for (const item of remote) if (!local.some(row => row.name === item.name)) rows.push({ name: item.name, remote: item, status: 'remote-only', block: item.official || item.name.startsWith('@deepseek-ai/') ? 'builtin' : 'remote-only' })
    access.check()
    const now = Date.now()
    for (const [id, plan] of this.plans) if (plan.view.expiresAt < now) this.plans.delete(id)
    if (this.plans.size >= 64) throw new Error('Too many plugin comparisons; wait for an older comparison to expire')
    const view: ServerPluginComparison = { planId: randomUUID(), alias, hostId: access.hostId, hostUpdatedAt,
      dshVersion: access.version, checkedAt: now, expiresAt: now + 300000, rows: rows.sort(byName) }
    this.plans.set(view.planId, { view: structuredClone(view), fingerprint: fingerprint(local, remote), access })
    return view
  }
  job(id: string): PluginSyncJob | undefined {
    const job = this.jobs.get(id); return job && structuredClone(job)
  }
  async start(planId: string, names: string[], id: string): Promise<PluginSyncJob> {
    if (!REQUEST.test(id)) throw new Error('Invalid sync request identity')
    const binding = JSON.stringify([planId, names]), existing = this.requests.get(id)
    if (existing) {
      if (existing.binding !== binding) throw new Error('Sync request identity belongs to another selection')
      await existing.result
      return this.job(id)!
    }
    if (this.requests.size >= 128) throw new Error('Plugin sync receipt limit reached')
    // Reserve before the first asynchronous preflight, even across different Hosts.
    const result = Promise.resolve().then(() => this.startOnce(planId, names, id))
    this.requests.set(id, { binding, result })
    try { return await result } catch (error) { this.requests.delete(id); throw error }
  }
  private async startOnce(planId: string, names: string[], id: string): Promise<PluginSyncJob> {
    const plan = this.plans.get(planId)
    if (!plan || plan.view.expiresAt < Date.now()) throw new Error('Plugin comparison expired; compare again')
    if (!Array.isArray(names) || !names.length || names.length > 32 || new Set(names).size !== names.length) throw new Error('Choose up to 32 plugins once')
    const rows = names.map(name => plan.view.rows.find(row => row.name === name))
    if (rows.some(row => !row?.spec || row.block || !row.local?.version)) throw new Error('A selected plugin cannot be synced')
    plan.access.check()
    if (this.busy.has(plan.view.hostId)) throw new Error('A plugin sync is already running on this host')
    this.busy.add(plan.view.hostId)
    try {
      const inventory = await this.inventories(plan.access)
      if (fingerprint(inventory.local, inventory.remote) !== plan.fingerprint) throw new Error('Plugin versions changed; compare again before syncing')
      if (this.jobs.size >= 128) throw new Error('Plugin sync receipt limit reached; keep the current results before restarting DSH')
      const job: PluginSyncJob = { id, alias: plan.view.alias, hostId: plan.view.hostId, state: 'running', createdAt: Date.now(),
        items: rows.map(row => ({ name: row!.name, version: row!.local!.version!, state: 'waiting' })) }
      this.jobs.set(id, job); this.plans.delete(planId)
      void this.run(plan, rows as ServerPluginRow[], job).finally(() => this.busy.delete(job.hostId))
      return structuredClone(job)
    } catch (error) { this.busy.delete(plan.view.hostId); throw error }
  }
  private async run(plan: Plan, rows: ServerPluginRow[], job: PluginSyncJob): Promise<void> {
    try {
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!, item = job.items[index]!
        plan.access.check()
        // A person may change remote packages while this batch runs. Never silently
        // replace a version or enablement different from the one they reviewed.
        const before = remotePackages(await plan.access.gateway.rpc<Bundle[]>('pluginManager/listBundles', {})).find(pkg => pkg.name === row.name)
        if (JSON.stringify(before) !== JSON.stringify(row.remote)) throw new Error('Selected remote plugin changed before dispatch')
        plan.access.check(); item.state = 'installing'
        let result: NativeChange
        try {
          result = plan.access.stageUpdate ? await plan.access.stageUpdate(row.name, item.version, before?.version ?? '', before?.enabled ?? row.local!.enabled, `${job.id}-${index}`)
            : await plan.access.gateway.rpc<NativeChange>('pluginManager/installBundle', {
            spec: row.spec, options: { saveExact: true, enabled: before?.enabled ?? row.local!.enabled, requestId: `${job.id}-${index}` },
          }, 600000)
        } catch {
          item.state = 'uncertain'; job.state = 'uncertain'
          job.message = 'Installation outcome is unknown. Inspect remote plugins before another sync; no request was replayed.'
          return
        }
        plan.access.check()
        if (result.application !== 'applied' && result.application !== 'restart-required') {
          item.state = 'failed'; item.errorCode = /^[a-z-]{1,80}$/.test(result.error?.code ?? '') ? result.error!.code : 'remote-refused'
          job.state = 'failed'; return
        }
        const after = remotePackages(await plan.access.gateway.rpc<Bundle[]>('pluginManager/listBundles', {})).find(pkg => pkg.name === row.name)
        plan.access.check()
        if (after?.version !== item.version) { item.state = 'uncertain'; job.state = 'uncertain'; return }
        item.state = result.application === 'restart-required' ? 'restart-required' : 'installed'
      }
      job.state = 'complete'
    } catch {
      const active = job.items.find(item => item.state === 'installing')
      if (active) { active.state = 'uncertain'; job.state = 'uncertain' }
      else job.state = 'failed'
      job.message = 'The remote connection or plugin inventory changed. Compare again before another sync.'
    } finally {
      for (const item of job.items) if (item.state === 'waiting') item.state = 'skipped'
    }
  }
}
