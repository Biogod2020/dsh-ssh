import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// @ts-expect-error The remote helper is a standalone, dependency-free deployment asset.
import { createModelBridge } from '../assets/remote-model-bridge.mjs'

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'model-bridge-')); directories.push(dir)
  const file = join(dir, 'state.json'), values = new Map<string, string>()
  const config: any = { providers: { 'remote-only': { apiKeyEnv: 'OTHER_KEY', models: [{ id: 'keep' }] } } }
  let revision = 0, selected = { provider: 'unconfigured', model: 'old' }
  const settings = { writable: true, get: () => structuredClone(config), describe: () => [{ ns: 'llm-pi-ai', value: config, revision }],
    mutate: vi.fn(async (_ns, ops, expected) => {
      if (expected !== revision) throw Error('conflict')
      for (const op of ops) config.providers[op.path[1]] = structuredClone(op.value)
      revision++
    }) }
  const credentials = { resolve: vi.fn(async ref => values.has(ref) ? { value: values.get(ref) } : undefined), set: vi.fn(async (ref, value) => { values.set(ref, value) }) }
  const defaultModel = { currentSelection: () => structuredClone(selected), saveSelection: vi.fn(async value => { selected = structuredClone(value) }) }
  const ctx = { settings, credentials, llm: { listConfigurableProviders: () => [{ provider: 'fixture', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'fixture'] }] }, get: (name: string) => name === 'agentDefaultModel' ? defaultModel : undefined }
  const run = createModelBridge(ctx, file)
  const item = { ns: 'llm-pi-ai', path: ['providers', 'fixture'], provider: 'fixture', label: 'Fixture', key: 'fixture-secret-one', config: { api: 'openai-completions', apiKeyEnv: 'LOCAL_KEY', baseURL: 'https://api.example.invalid/v1', models: [{ id: 'model-one' }] } }
  const request = (id: string, patch: any = {}) => ({ kind: 'sync', requestId: `request-fixture-${id}`, providers: [structuredClone(item)], policy: { mode: 'follow', providers: {} }, ...patch })
  return { run, ctx, settings, config, credentials, defaultModel, values, item, file, request, revise: () => revision++ }
}
it('syncs API settings and keys through native services, preserves unrelated routes, and returns no secrets', async () => {
  const f = fixture(), result = await f.run(f.request('initial', { defaultSelection: { provider: 'fixture', model: 'model-one' } }))
  expect(result.providers[0]).toMatchObject({ mode: 'follow', status: 'synced', modelCount: 1 })
  expect(f.config.providers['remote-only'].models).toEqual([{ id: 'keep' }])
  expect(f.config.providers.fixture.apiKeyEnv).toMatch(/^DSH_SSH_[A-F0-9]{40}$/)
  expect(f.values.get(f.config.providers.fixture.apiKeyEnv)).toBe(f.item.key)
  expect(f.defaultModel.currentSelection()).toEqual({ provider: 'fixture', model: 'model-one' })
  expect(JSON.stringify(result)).not.toContain(f.item.key)
  expect(readFileSync(f.file, 'utf8')).not.toContain(f.item.key)
})
it('propagates changed models and a rotated local key while keeping previous key references for in-flight requests', async () => {
  const f = fixture(); await f.run(f.request('one'))
  const old = f.config.providers.fixture.apiKeyEnv
  f.item.key = 'fixture-secret-two'; f.item.config.models.push({ id: 'model-two' })
  await f.run(f.request('two'))
  expect(f.config.providers.fixture.models).toHaveLength(2)
  expect(f.config.providers.fixture.apiKeyEnv).not.toBe(old)
  expect(f.values.get(old)).toBe('fixture-secret-one')
  expect(f.values.get(f.config.providers.fixture.apiKeyEnv)).toBe('fixture-secret-two')
})
it('detects separate remote profile edits and returns to follow only after an explicit policy change', async () => {
  const f = fixture(); await f.run(f.request('one'))
  f.config.providers.fixture.baseURL = 'https://separate.example.invalid'; f.revise()
  f.item.config.models.push({ id: 'model-two' })
  expect((await f.run(f.request('two'))).providers[0]).toMatchObject({ mode: 'independent', status: 'independent', reason: 'remote-edited' })
  expect(f.config.providers.fixture.baseURL).toBe('https://separate.example.invalid')
  await f.run(f.request('three', { policy: { mode: 'follow', reset: ['llm-pi-ai:fixture'] } }))
  expect(f.config.providers.fixture.baseURL).toBe(f.item.config.baseURL)
})
it('also protects a remotely changed key when the remote model configuration has not changed', async () => {
  const f = fixture(); await f.run(f.request('one'))
  const ref = f.config.providers.fixture.apiKeyEnv
  f.values.set(ref, 'remote-independent-key'); f.item.key = 'new-local-key'
  expect((await f.run(f.request('two'))).providers[0].mode).toBe('independent')
  expect(f.values.get(ref)).toBe('remote-independent-key')
  expect(f.credentials.set).toHaveBeenCalledTimes(1)
})
it('preserves an already configured remote provider on first connection', async () => {
  const f = fixture(); f.config.providers.fixture = { apiKeyEnv: 'EXISTING_KEY' }; f.values.set('EXISTING_KEY', 'existing-remote-key')
  expect((await f.run(f.request('one'))).providers[0].status).toBe('independent')
  expect(f.credentials.set).not.toHaveBeenCalled()
})
it('honors independent host and provider policies without writing credentials', async () => {
  const f = fixture()
  await f.run(f.request('one', { policy: { mode: 'independent' } }))
  await f.run(f.request('two', { policy: { mode: 'follow', providers: { 'llm-pi-ai:fixture': 'independent' } } }))
  expect(f.settings.mutate).not.toHaveBeenCalled(); expect(f.credentials.set).not.toHaveBeenCalled()
})
it('never replays an uncertain mutation, including after helper restart or a reset-to-follow request', async () => {
  const f = fixture(); f.settings.mutate.mockRejectedValueOnce(Error('response lost'))
  expect((await f.run(f.request('one'))).providers[0].status).toBe('uncertain')
  await f.run(f.request('one'))
  const restarted = createModelBridge(f.ctx, f.file)
  expect((await restarted(f.request('two', { policy: { mode: 'follow', reset: ['llm-pi-ai:fixture'] } }))).providers[0].status).toBe('uncertain')
  expect(f.settings.mutate).toHaveBeenCalledOnce(); expect(f.credentials.set).toHaveBeenCalledOnce()
})
it('reconciles a completed write whose response was lost without repeating it', async () => {
  const f = fixture(), mutate = f.settings.mutate.getMockImplementation()!
  f.settings.mutate.mockImplementationOnce(async (...args) => { await mutate(...args); throw Error('lost after commit') })
  expect((await f.run(f.request('one'))).providers[0].status).toBe('uncertain')
  expect((await f.run(f.request('two'))).providers[0].status).toBe('synced')
  expect(f.settings.mutate).toHaveBeenCalledOnce()
})
it('keeps a separately changed default model on later automatic syncs', async () => {
  const f = fixture(), first = { provider: 'fixture', model: 'model-one' }
  await f.run(f.request('one', { defaultSelection: first }))
  await f.defaultModel.saveSelection({ provider: 'fixture', model: 'remote-choice' })
  const result = await f.run(f.request('two', { defaultSelection: first }))
  expect(result.default.mode).toBe('independent')
  expect(f.defaultModel.currentSelection().model).toBe('remote-choice')
})
it('rejects writes outside a native LLM settings address', async () => {
  const f = fixture(), request = f.request('one'); request.providers[0].path = ['some-unrelated-settings']
  await expect(f.run(request)).rejects.toThrow('invalid-request')
  expect(f.credentials.set).not.toHaveBeenCalled()
})
it('maps profile namespace names to the remote LLM address while preserving the source identity', async () => {
  const f = fixture(), request = f.request('one'); request.providers[0].ns = 'local-custom-pi-ai'
  const result = await f.run(request)
  expect(result.providers[0]).toMatchObject({ id: 'local-custom-pi-ai:fixture', status: 'synced' })
  expect(f.settings.mutate.mock.calls[0]?.[0]).toBe('llm-pi-ai')
})
it('verifies source fields when a native schema adds nested defaults', async () => {
  const f = fixture(), mutate = f.settings.mutate.getMockImplementation()!
  f.settings.mutate.mockImplementationOnce(async (...args) => {
    await mutate(...args)
    f.config.providers.fixture.compat = { extraDefault: true }
    f.config.providers.fixture.models[0].compat = { added: {} }
  })
  expect((await f.run(f.request('one'))).providers[0].status).toBe('synced')
})
it('keeps an authenticated remote default when a new local provider is enrolled', async () => {
  const f = fixture()
  f.ctx.llm.listConfigurableProviders = () => [
    { provider: 'fixture', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'fixture'] },
    { provider: 'remote-only', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'remote-only'] },
  ]
  f.values.set('OTHER_KEY', 'existing-remote-only-key')
  await f.defaultModel.saveSelection({ provider: 'remote-only', model: 'keep' })
  const result = await f.run(f.request('one', { defaultSelection: { provider: 'fixture', model: 'model-one' } }))
  expect(result.default.mode).toBe('independent')
  expect(f.defaultModel.currentSelection()).toEqual({ provider: 'remote-only', model: 'keep' })
})
it('does not take over an interrupted helper lock or dispatch another write', async () => {
  const f = fixture(); mkdirSync(f.file + '.lock', { mode: 0o700 })
  await expect(f.run(f.request('one'))).rejects.toThrow()
  expect(f.credentials.set).not.toHaveBeenCalled()
})
it('observes a lost committed result using status alone, without another sync request', async () => {
  const f = fixture(), mutate = f.settings.mutate.getMockImplementation()!
  f.settings.mutate.mockImplementationOnce(async (...args) => { await mutate(...args); throw Error('lost after commit') })
  expect((await f.run(f.request('one'))).providers[0].status).toBe('uncertain')
  expect((await f.run({ kind: 'status' })).providers[0].status).toBe('synced')
  expect(f.settings.mutate).toHaveBeenCalledOnce()
})
it('preserves a remote edit made while the new credential was being stored', async () => {
  const f = fixture(); await f.run(f.request('one'))
  const oldRef = f.config.providers.fixture.apiKeyEnv, store = f.credentials.set.getMockImplementation()!
  f.item.key = 'rotated-local-key'
  f.credentials.set.mockImplementationOnce(async (...args) => { await store(...args); f.values.set(oldRef, 'concurrent-remote-key') })
  expect((await f.run(f.request('two'))).providers[0].mode).toBe('independent')
  expect(f.config.providers.fixture.apiKeyEnv).toBe(oldRef); expect(f.values.get(oldRef)).toBe('concurrent-remote-key')
  expect(f.settings.mutate).toHaveBeenCalledOnce()
})
it('preserves native remote key records before switching the route to an explicit reference', async () => {
  const f = fixture()
  ;(f.credentials as any).describeRecord = async () => ({ configured: true, kind: 'api-key' })
  ;(f.credentials as any).readRecord = async () => ({ kind: 'api-key', key: 'remote-record-key' })
  expect((await f.run(f.request('one'))).providers[0].mode).toBe('independent')
  expect(f.credentials.set).not.toHaveBeenCalled()
})
