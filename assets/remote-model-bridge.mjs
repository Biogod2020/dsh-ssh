/** Private Host bridge. Uses native settings/credentials; never returns a secret. */
// Every build has its own bundle identity so the Host cannot reuse an older module.
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readFile, writeFile, rename, lstat, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'ssh-model-bridge'
export const inject = ['webServer', 'connection', 'settings', 'credentials', 'llm']
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const at = (value, path) => path.reduce((v, key) => plain(v) ? v[key] : undefined, value)
const stable = value => JSON.stringify(value, (_, v) => plain(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v)
const safe = value => {
  if (Array.isArray(value)) return value.every(safe)
  if (!plain(value)) return value === null || ['string', 'number', 'boolean'].includes(typeof value)
  return Object.entries(value).every(([k, v]) => !['__proto__', 'constructor', 'prototype'].includes(k) && safe(v))
}
const idOf = row => row.sourceId ?? `${row.ns}:${row.provider}`
const BUILD = createHash('sha256').update(await readFile(new URL(import.meta.url), 'utf8')).digest('hex')
// A native schema may add defaults. Verify every supplied field without
// persisting its value, then retain the complete resolved target fingerprint.
const shapeOf = value => Array.isArray(value) ? value.map(shapeOf) : plain(value)
  ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shapeOf(v)])) : true
const project = (value, shape) => shape === true ? value : Array.isArray(shape)
  ? Array.isArray(value) && value.length === shape.length ? shape.map((s, i) => project(value[i], s)) : undefined
  : plain(value) ? Object.fromEntries(Object.entries(shape).map(([k, s]) => [k, project(value[k], s)])) : undefined

/** Exported factory permits isolated native-service integration tests. */
export function createModelBridge(ctx, filename) {
  let queue = Promise.resolve()
  const load = async () => {
    try {
      const info = await lstat(filename)
      if (!info.isFile() || (info.mode & 0o077)) throw Error('private-state-required')
      const state = JSON.parse(await readFile(filename, 'utf8'))
      if (state.version !== 1 || typeof state.key !== 'string' || !plain(state.providers)) throw Error('invalid-state')
      return state
    } catch (e) {
      if (e.code !== 'ENOENT') throw Error('state-unavailable')
      return { version: 1, key: randomBytes(32).toString('hex'), providers: {}, requests: {}, default: {} }
    }
  }
  const save = async state => {
    const tmp = `${filename}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(state), { mode: 0o600 }); await rename(tmp, filename)
  }
  const digest = (state, value) => createHmac('sha256', state.key).update(stable(value)).digest('hex')
  const descriptor = ns => ctx.settings.describe().find(row => row.ns === ns)
  const target = async (state, item) => {
    const section = descriptor(item.ns), profile = at(section?.value, item.path)
    const ref = plain(profile) && typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined
    let key = ref ? (await ctx.credentials.resolve(ref))?.value : undefined, configured = !!key
    if (!ref && item.path[0] === 'providers' && ctx.credentials.describeRecord) {
      const recordKey = `llm-pi-ai/${item.provider}`, info = await ctx.credentials.describeRecord(recordKey)
      configured = info?.configured === true
      if (configured && info.kind === 'api-key') {
        const record = await ctx.credentials.readRecord(recordKey)
        if (record?.kind === 'api-key') key = record.key
      }
    }
    const user = at(section?.user, item.path), customized = item.path.length ? user !== undefined : plain(user) && Object.keys(user).length > 0
    return { section, profile, key, configured, customized, hash: digest(state, { profile: profile ?? null, key: key ?? null }) }
  }
  const publicState = state => ({ protocol: 1, build: BUILD,
    providers: Object.entries(state.providers).map(([id, row]) => ({ id, provider: row.provider, label: row.label,
      mode: row.mode ?? 'follow', status: row.status ?? 'pending', reason: row.reason, modelCount: row.modelCount, updatedAt: row.updatedAt })),
    default: { mode: state.default.mode ?? 'follow', status: state.default.status ?? 'pending' },
    lastRequest: state.lastRequest && { id: state.lastRequest.id, status: state.lastRequest.status },
  })
  const valid = item => {
    if (!plain(item) || !/^[a-z][a-z0-9-]{0,100}$/.test(item.ns) || typeof item.provider !== 'string'
      || !Array.isArray(item.path) || !plain(item.config) || !safe(item.config) || typeof item.key !== 'string' || !item.key.trim()
      || item.key.length > 65536 || typeof item.label !== 'string' || item.label.length > 256) return false
    return item.provider !== 'deepseek-account' && item.provider.length <= 200
      && (item.path.length === 0 || item.path.length === 2 && item.path[0] === 'providers' && item.path[1] === item.provider)
  }
  const destination = item => {
    const entries = ctx.llm.listConfigurableProviders().filter(row => row.provider !== 'deepseek-account')
    let entry = entries.find(row => row.provider === item.provider && row.settingsNs === item.ns && stable(row.settingsPath) === stable(item.path))
      ?? entries.find(row => row.provider === item.provider && (row.settingsPath.length === 0) === (item.path.length === 0))
    if (!entry && item.path[0] === 'providers') {
      const families = [...new Set(entries.filter(row => row.settingsPath?.[0] === 'providers').map(row => row.settingsNs))]
      const ns = families.includes(item.ns) ? item.ns : families.length === 1 ? families[0] : undefined
      if (ns) entry = { settingsNs: ns, settingsPath: item.path }
    }
    return entry ? { ...item, sourceId: `${item.ns}:${item.provider}`, ns: entry.settingsNs, path: entry.settingsPath.length === 0 ? [] : ['providers', item.provider] } : undefined
  }
  const applySnapshot = async request => {
    const state = await load()
    if (request.kind === 'status') {
      let changed = false
      for (const row of Object.values(state.providers)) if (row.pending && row.ns && row.path) {
        const current = await target(state, row)
        if (digest(state, { profile: row.pending.shape ? project(current.profile, row.pending.shape) : current.profile, key: current.key }) === row.pending.target) {
          row.source = row.pending.source; row.target = current.hash; delete row.pending; row.status = 'synced'
          row.modelCount = Array.isArray(current.profile?.models) ? current.profile.models.length : undefined; changed = true
        }
      }
      const service = ctx.get('agentDefaultModel')
      if (state.default.pending && service && digest(state, service.currentSelection()) === state.default.pending) {
        state.default.target = state.default.pending; delete state.default.pending; state.default.status = 'synced'; changed = true
      }
      const last = state.lastRequest
      if (last?.status === 'running' && last.expected?.every(goal => {
        const row = state.providers[goal.id]
        return row && !row.pending && (row.mode === 'independent' || row.status === 'blocked' || row.source === goal.source)
      })) {
        const owner = Object.values(state.providers).find(row => row.provider === last.defaultProvider && row.status === 'synced')
        if (!state.default.pending && (!last.defaultGoal || !owner || state.default.mode === 'independent' || service && digest(state, service.currentSelection()) === last.defaultGoal)) {
          state.requests[last.id] = 'complete'; last.status = 'complete'; changed = true
        }
      }
      if (changed) await save(state)
      return publicState(state)
    }
    if (request.kind !== 'sync' || !/^[a-zA-Z0-9-]{16,100}$/.test(request.requestId)
      || !Array.isArray(request.providers) || request.providers.length > 200 || !request.providers.every(valid)
      || new Set(request.providers.map(idOf)).size !== request.providers.length
      || !plain(request.policy)) throw Error('invalid-request')
    // A previous dispatch is observed, never run a second time, including after restart.
    if (state.requests[request.requestId]) return publicState(state)
    state.requests[request.requestId] = 'started'; state.lastRequest = { id: request.requestId, status: 'running',
      expected: request.providers.map(item => ({ id: idOf(item), source: digest(state, { config: item.config, key: item.key }) })),
      ...(request.defaultSelection ? { defaultGoal: digest(state, request.defaultSelection), defaultProvider: request.defaultSelection.provider } : {}) }; await save(state)
    for (const sourceItem of request.providers) {
      const item = destination(sourceItem)
      if (!item) {
        state.providers[idOf(sourceItem)] = { provider: sourceItem.provider, label: sourceItem.label, status: 'blocked', reason: 'unsupported' }
        continue
      }
      const id = idOf(item), current = await target(state, item), existing = state.providers[id]
      const row = state.providers[id] ??= { provider: item.provider, label: item.label, ns: item.ns, path: item.path }
      row.label = item.label; row.modelCount = Array.isArray(current.profile?.models) ? current.profile.models.length : undefined
      const policy = request.policy.providers?.[id]
      if (request.policy.mode === 'independent') { row.status = 'independent'; continue }
      if (policy === 'independent') { row.mode = 'independent'; row.status = 'independent'; continue }
      // Explicitly returning to follow clears the protected baseline once.
      const force = request.policy.reset?.includes(id) === true
      if (force && !row.pending) { delete row.target; row.mode = 'follow' }
      if (row.pending) {
        const actual = digest(state, { profile: row.pending.shape ? project(current.profile, row.pending.shape) : current.profile, key: current.key })
        if (actual === row.pending.target) { row.target = current.hash; row.source = row.pending.source; delete row.pending; row.status = 'synced' }
        else { row.status = 'uncertain'; continue }
      }
      if (row.mode === 'independent' && !force) { row.status = 'independent'; continue }
      if (!force && (row.target && row.target !== current.hash || !existing && (current.configured || current.customized))) {
        row.mode = 'independent'; row.status = 'independent'; row.reason = 'remote-edited'; continue
      }
      const source = digest(state, { config: item.config, key: item.key })
      if (row.source === source && row.target === current.hash) { row.status = 'synced'; continue }
      const section = descriptor(item.ns)
      if (!section || ctx.settings.writable === false) { row.status = 'blocked'; row.reason = 'unsupported'; continue }
      // A new reference avoids overwriting another provider or an in-flight request's key.
      const ref = 'DSH_SSH_' + createHash('sha256').update(id + source).digest('hex').slice(0, 40).toUpperCase()
      const config = { ...item.config, apiKeyEnv: ref }
      row.pending = { source, target: digest(state, { profile: config, key: item.key }), shape: shapeOf(config), phase: 'credential' }; row.status = 'syncing'; await save(state)
      try {
        await ctx.credentials.set(ref, item.key)
        row.pending.phase = 'settings'; await save(state)
        const observed = await target(state, item)
        if (observed.hash !== current.hash) {
          delete row.pending; row.mode = 'independent'; row.status = 'independent'; row.reason = 'remote-edited'; await save(state); continue
        }
        // Native revision checks protect concurrent edits to the whole namespace.
        await ctx.settings.mutate(item.ns, [{ op: 'set', path: item.path, value: config }], observed.section.revision)
        row.pending.phase = 'verify'; await save(state)
        const confirmed = await target(state, item)
        if (digest(state, { profile: project(confirmed.profile, row.pending.shape), key: confirmed.key }) !== row.pending.target) throw Error('unconfirmed')
        row.source = source; row.target = confirmed.hash; delete row.pending
        row.modelCount = Array.isArray(confirmed.profile?.models) ? confirmed.profile.models.length : undefined
        row.mode = 'follow'; row.status = 'synced'; delete row.reason; row.updatedAt = Date.now()
      } catch {
        // Do not echo validation errors; a rejected profile can contain a secret header.
        row.status = 'uncertain'; row.reason = 'inspect-required'
      }
      await save(state)
    }
    const selection = request.defaultSelection, service = ctx.get('agentDefaultModel')
    const defaultPolicy = request.policy.providers?.['@default']
    if (request.policy.mode === 'independent' || defaultPolicy === 'independent') { state.default.mode = 'independent'; state.default.status = 'independent' }
    if (request.policy.reset?.includes('@default') && !state.default.pending) state.default = { mode: 'follow' }
    if (selection && service && state.default.mode !== 'independent') {
      const owner = Object.values(state.providers).find(row => row.provider === selection.provider && row.status === 'synced')
      if (typeof selection.provider === 'string' && typeof selection.model === 'string') {
        const current = service.currentSelection(), hash = digest(state, current)
        // On first enrollment, keep an already authenticated remote default.
        if (!state.default.target && !state.default.pending && !request.policy.reset?.includes('@default')) {
          const entry = ctx.llm.listConfigurableProviders().find(row => row.provider === current.provider)
          const profile = entry ? at(descriptor(entry.settingsNs)?.value, entry.settingsPath) : undefined
          const ref = plain(profile) && profile.apiKeyEnv
          const previousKey = typeof ref === 'string' ? (await ctx.credentials.resolve(ref))?.value : undefined
          const managed = Object.values(state.providers).some(row => row.provider === current.provider && row.status === 'synced')
          const records = await ctx.credentials.listRecords?.() ?? []
          const authenticated = records.some(row => typeof row.key === 'string' && row.key.includes(current.provider))
          if ((previousKey || authenticated) && !managed) { state.default.mode = 'independent'; state.default.status = 'independent' }
        }
        if (state.default.pending && hash === state.default.pending) { state.default.target = hash; delete state.default.pending }
        if (state.default.mode === 'independent') { /* Preserve the authenticated remote default. */ }
        else if (!owner) state.default.status = 'blocked'
        else if (state.default.pending) state.default.status = 'uncertain'
        else if (state.default.target && hash !== state.default.target) { state.default.mode = 'independent'; state.default.status = 'independent' }
        else {
          const wanted = digest(state, selection)
          if (hash !== wanted) {
            state.default.pending = wanted; await save(state)
            try { await service.saveSelection(selection) } catch { state.default.status = 'uncertain' }
          }
          if (digest(state, service.currentSelection()) === wanted) { state.default.target = wanted; delete state.default.pending; state.default.status = 'synced' }
        }
      }
    }
    state.requests[request.requestId] = 'complete'; state.lastRequest = { id: request.requestId, status: 'complete' }
    // Receipt retention is bounded; incomplete provider receipts remain above.
    const ids = Object.keys(state.requests); for (const id of ids.slice(0, Math.max(0, ids.length - 100))) delete state.requests[id]
    await save(state); return publicState(state)
  }
  return request => {
    const result = queue.then(async () => {
      // Serializes helper replacements and multiple controllers, without
      // taking over a stale lock after an uncertain interrupted write.
      const lock = filename + '.lock'
      await mkdir(lock, { mode: 0o700 })
      try { return await applySnapshot(request) } finally { await rm(lock, { recursive: true }) }
    })
    queue = result.catch(() => {}); return result
  }
}

export function apply(ctx) {
  const home = process.env.DSH_HOME
  if (!home?.startsWith('/')) throw Error('model bridge requires an absolute DSH home')
  const run = createModelBridge(ctx, join(home, 'ssh-model-follow.json'))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/dsh-ssh-model-follow', handler: async (req, res) => {
    const denied = ctx.connection.requestRejection(req)
    if (denied) { res.writeHead(denied); res.end(); return }
    res.setHeader('Cache-Control', 'no-store')
    try {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      let size = 0, chunks = []
      for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw Error('too-large'); chunks.push(chunk) }
      const result = await run(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result))
    } catch { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Model sync was not confirmed. Inspect its status; no write was replayed.' })) }
  } }))
}
