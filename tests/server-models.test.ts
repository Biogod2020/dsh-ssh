import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { localModelSource, modelBridgeHash, ServerModels } from '../src/remote/models.ts'
// @ts-expect-error Standalone deployment asset tested through its public factory.
import { createModelBridge } from '../assets/remote-model-bridge.mjs'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'server-models-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const profiles: any = { providers: {} }, values = new Map<string, string>(); let revision = 0, online = true, changed = false
  const settings = { writable: true, describe: () => [{ ns: 'llm-pi-ai', value: profiles, revision }], mutate: vi.fn(async (_ns, ops) => { for (const op of ops) profiles.providers[op.path[1]] = op.value; revision++ }) }
  const credentials = { resolve: async (ref: string) => values.has(ref) ? { value: values.get(ref) } : undefined, set: vi.fn(async (ref, value) => { values.set(ref, value) }) }
  const native = createModelBridge({ settings, credentials, llm: { listConfigurableProviders: () => [{ provider: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] }] }, get: () => undefined }, join(dir, 'remote.json'))
  const gateway = { modelBridge: vi.fn(native), rpc: vi.fn(async (_method: string, _args?: unknown, _timeout?: number): Promise<any> => { throw Error('unexpected install') }) }
  const check = () => { if (changed) throw Error('Host changed') }
  const manager: any = {
    modelIdentity: vi.fn((_alias, version) => { expect(version).toBe(42); check(); return { hostId: 'a'.repeat(24) } }),
    connectedModelHosts: () => online ? [{ alias: 'fixture', updatedAt: 42 }] : [],
    modelAccess: vi.fn(() => { check(); if (!online) throw Error('offline'); return { gateway, hostId: 'a'.repeat(24), check, stageBridge: vi.fn(), open: () => 'http://127.0.0.1:9000/' } }),
  }
  const snapshot = { providers: [{ ns: 'llm-pi-ai', path: ['providers', 'fixture'], provider: 'fixture', label: 'Fixture', key: 'private-local-api-key', config: { apiKeyEnv: 'LOCAL_KEY', baseURL: 'https://api.example.invalid/v1', models: [{ id: 'one' }] } }], skipped: [] }
  const source = vi.fn(async () => structuredClone(snapshot)), filename = join(dir, 'controller.json')
  const hash = modelBridgeHash(readFileSync(new URL('../assets/remote-model-bridge.mjs', import.meta.url), 'utf8'))
  const make = () => { const value = new ServerModels(manager, source, hash, filename); cleanups.push(() => value.dispose()); return value }
  const service = make()
  return { service, source, snapshot, gateway, settings, credentials, profiles, values, filename, manager, make,
    offline: () => { online = false }, online: () => { online = true }, changeHost: () => { changed = true } }
}
it('automatically propagates local changes and avoids unchanged writes', async () => {
  const f = fixture(); await f.service.changed()
  expect(f.service.view('fixture', 42).rows[0]?.status).toBe('synced')
  expect(f.credentials.set).toHaveBeenCalledOnce()
  await f.service.changed(); expect(f.credentials.set).toHaveBeenCalledOnce()
  f.snapshot.providers[0]!.key = 'rotated-private-key'; await f.service.changed()
  expect(f.credentials.set).toHaveBeenCalledTimes(2)
  expect(readFileSync(f.filename, 'utf8')).not.toMatch(/private-local-api-key|rotated-private-key/)
  expect(JSON.stringify(f.service.view('fixture', 42))).not.toContain('private-local-api-key')
})
it('choosing independent mode before connection never connects, installs or resolves local keys', async () => {
  const f = fixture(); f.offline()
  expect(f.service.view('fixture', 42).mode).toBe('follow')
  expect((await f.service.setPolicy('fixture', 42, { mode: 'independent' })).mode).toBe('independent')
  await f.service.changed()
  expect(f.manager.modelAccess).not.toHaveBeenCalled(); expect(f.source).not.toHaveBeenCalled()
})
it('saves following while disconnected without inventing an uncertain outcome and syncs after connection', async () => {
  const f = fixture(); f.offline()
  await f.service.setPolicy('fixture', 42, { mode: 'independent' })
  const view = await f.service.setPolicy('fixture', 42, { mode: 'follow' })
  expect(view).toMatchObject({ mode: 'follow', connected: false, state: 'idle' })
  expect(f.manager.modelAccess).not.toHaveBeenCalled(); expect(f.source).not.toHaveBeenCalled()
  expect(f.gateway.modelBridge).not.toHaveBeenCalled(); expect(f.gateway.rpc).not.toHaveBeenCalled()
  f.online(); await f.service.changed()
  expect(f.service.view('fixture', 42)).toMatchObject({ mode: 'follow', connected: true, state: 'ready' })
  expect(f.service.view('fixture', 42).rows[0]?.status).toBe('synced')
  expect(f.credentials.set).toHaveBeenCalledOnce()
})
it('retains a genuine uncertain dispatched sync when following is selected while disconnected', async () => {
  const f = fixture(), native = f.gateway.modelBridge.getMockImplementation()!
  f.gateway.modelBridge.mockImplementation(async request => {
    const result = await native(request)
    if (request.kind === 'sync') throw Error('lost response')
    return result
  })
  await f.service.sync('fixture', 42)
  const pending = JSON.parse(readFileSync(f.filename, 'utf8')).hosts['a'.repeat(24)].pending
  expect(pending).toBeDefined()
  f.offline()
  await f.service.setPolicy('fixture', 42, { mode: 'independent' })
  const view = await f.service.setPolicy('fixture', 42, { mode: 'follow' })
  expect(view).toMatchObject({ connected: false, state: 'uncertain' })
  expect(JSON.parse(readFileSync(f.filename, 'utf8')).hosts['a'.repeat(24)].pending).toEqual(pending)
  expect(f.gateway.modelBridge.mock.calls.filter(([request]) => request.kind === 'sync')).toHaveLength(1)
})
it('rejects an invalid combined policy without re-enabling credential synchronization', async () => {
  const f = fixture()
  await f.service.setPolicy('fixture', 42, { mode: 'independent' })
  const before = readFileSync(f.filename, 'utf8')
  await expect(f.service.setPolicy('fixture', 42, { mode: 'follow', provider: 'invalid', providerMode: 'follow' })).rejects.toThrow('Invalid provider')
  await f.service.changed()
  expect(f.service.view('fixture', 42).mode).toBe('independent')
  expect(f.source).not.toHaveBeenCalled(); expect(f.credentials.set).not.toHaveBeenCalled()
  expect(readFileSync(f.filename, 'utf8')).toBe(before)
})
it('protects separate provider settings and explicitly restores following later', async () => {
  const f = fixture(); await f.service.changed()
  await f.service.setPolicy('fixture', 42, { provider: 'llm-pi-ai:fixture', providerMode: 'independent' })
  f.snapshot.providers[0]!.key = 'later-local-key'; await f.service.changed()
  expect(f.credentials.set).toHaveBeenCalledOnce()
  await f.service.setPolicy('fixture', 42, { provider: 'llm-pi-ai:fixture', providerMode: 'follow' })
  expect(f.credentials.set).toHaveBeenCalledTimes(2)
})
it('recovers a lost completed response after controller restart without sending the mutation again', async () => {
  const f = fixture(), send = f.gateway.modelBridge.getMockImplementation()!
  let lost = false
  f.gateway.modelBridge.mockImplementation(async request => {
    const result = await send(request)
    if (request.kind === 'sync' && !lost) { lost = true; throw Error('response lost') }
    return result
  })
  await f.service.sync('fixture', 42); expect(f.service.view('fixture', 42).state).toBe('uncertain')
  f.service.dispose(); const restarted = f.make()
  await restarted.sync('fixture', 42)
  expect(restarted.view('fixture', 42).state).toBe('ready')
  expect(f.credentials.set).toHaveBeenCalledOnce(); expect(f.settings.mutate).toHaveBeenCalledOnce()
})
it('never installs or stages a helper merely because an existing carrier has a network error', async () => {
  const f = fixture(); f.gateway.modelBridge.mockRejectedValue(Error('disconnected'))
  await f.service.sync('fixture', 42)
  expect(f.gateway.rpc).not.toHaveBeenCalled(); expect(f.credentials.set).not.toHaveBeenCalled()
})
it('enables a helper prepared by the private CLI instead of invoking a missing native pnpm command', async () => {
  const f = fixture(), native = f.gateway.modelBridge.getMockImplementation()!
  let installed = false
  f.gateway.modelBridge.mockImplementation(async request => {
    if (!installed) throw Object.assign(new Error('not installed'), { status: 404 })
    return native(request)
  })
  const access = f.manager.modelAccess('fixture', 42)
  access.stageBridge = vi.fn(async () => ({ name: '@jay-local/dsh-ssh-model-bridge-fixture', spec: 'link:/generated/model-bridge', version: '0.0.0-fixture', staged: true }))
  f.manager.modelAccess.mockReturnValue(access)
  f.gateway.rpc.mockImplementation(async (method: string) => {
    if (method === 'settings/describe') return { writable: true } as any
    if (method === 'credentials/describe') return {} as any
    if (method === 'pluginManager/setBundleEnabled') { installed = true; return { application: 'applied' } as any }
    throw Error('unexpected package installation')
  })
  await f.service.sync('fixture', 42)
  expect(access.stageBridge).toHaveBeenCalledOnce()
  expect(f.gateway.rpc).toHaveBeenCalledWith('pluginManager/setBundleEnabled', { name: '@jay-local/dsh-ssh-model-bridge-fixture', enabled: true }, 600000)
  expect(f.gateway.rpc.mock.calls.some(([method]) => method === 'pluginManager/installBundle')).toBe(false)
  expect(f.service.view('fixture', 42).state).toBe('ready')
  expect(f.credentials.set).toHaveBeenCalledOnce()
})
it('stops before dispatch when the reviewed SSH host changes during the local snapshot read', async () => {
  const f = fixture(); f.source.mockImplementation(async () => { f.changeHost(); return structuredClone(f.snapshot) })
  await f.service.sync('fixture', 42)
  expect(f.gateway.modelBridge).not.toHaveBeenCalled(); expect(f.credentials.set).not.toHaveBeenCalled()
})
it('retains a confirmed restart requirement across polling and controller restart without reinstalling', async () => {
  const f = fixture(), native = f.gateway.modelBridge.getMockImplementation()!
  f.gateway.modelBridge.mockRejectedValue(Object.assign(new Error('not active yet'), { status: 404 }))
  const access = f.manager.modelAccess('fixture', 42)
  access.stageBridge = vi.fn(async () => ({ name: '@jay-local/dsh-ssh-model-bridge-fixture', staged: true }))
  f.manager.modelAccess.mockReturnValue(access)
  f.gateway.rpc.mockImplementation(async method => method === 'settings/describe' ? { writable: true }
    : method === 'credentials/describe' ? {} : { application: 'restart-required' })
  await f.service.sync('fixture', 42)
  expect(f.service.view('fixture', 42).state).toBe('restart-required')
  const calls = f.gateway.modelBridge.mock.calls.length
  f.offline()
  await f.service.setPolicy('fixture', 42, { mode: 'independent' })
  expect((await f.service.setPolicy('fixture', 42, { mode: 'follow' })).state).toBe('restart-required')
  expect(JSON.parse(readFileSync(f.filename, 'utf8')).hosts['a'.repeat(24)].helperPending).toBe(true)
  expect(f.gateway.modelBridge).toHaveBeenCalledTimes(calls)
  f.online()
  f.service.dispose(); const restarted = f.make()
  await restarted.sync('fixture', 42)
  expect(restarted.view('fixture', 42).state).toBe('restart-required')
  expect(access.stageBridge).toHaveBeenCalledOnce()
  f.gateway.modelBridge.mockImplementation(native)
  await restarted.sync('fixture', 42)
  expect(restarted.view('fixture', 42).state).toBe('ready')
  expect(access.stageBridge).toHaveBeenCalledOnce()
})
it('does not enable a replacement or repeat retirement after losing the old helper acknowledgement', async () => {
  const f = fixture(), native = f.gateway.modelBridge.getMockImplementation()!
  f.gateway.modelBridge.mockImplementation(async request => ({ ...await native(request), build: '0'.repeat(64) }))
  const access = f.manager.modelAccess('fixture', 42)
  access.stageBridge = vi.fn(async () => ({ name: '@jay-local/dsh-ssh-model-bridge-fixture', staged: true }))
  f.manager.modelAccess.mockReturnValue(access)
  f.gateway.rpc.mockImplementation(async method => {
    if (method === 'settings/describe') return { writable: true }
    if (method === 'credentials/describe') return {}
    if (method === 'pluginManager/listBundles') return [{ name: '@jay-local/dsh-ssh-model-bridge', enabled: true }, { name: 'unrelated-plugin', enabled: true }]
    throw Error('lost retirement reply')
  })
  await f.service.sync('fixture', 42); await f.service.sync('fixture', 42)
  expect(f.service.view('fixture', 42).state).toBe('uncertain')
  expect(f.gateway.rpc.mock.calls.filter(([method]) => method === 'pluginManager/setBundleEnabled')).toEqual([
    ['pluginManager/setBundleEnabled', { name: '@jay-local/dsh-ssh-model-bridge', enabled: false }, 600000],
  ])
  expect(access.stageBridge).toHaveBeenCalledOnce(); expect(f.credentials.set).not.toHaveBeenCalled()
})
it('reads API-key routes from native services, excludes browser logins and localhost routes, and preserves parameters', async () => {
  const rows = [
    { provider: 'api', displayName: 'API', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'api'] },
    { provider: 'local', displayName: 'Local', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'local'] },
    { provider: 'deepseek-account', displayName: 'Account', settingsNs: 'account', settingsPath: [] },
  ]
  const resolve = vi.fn(async () => ({ value: 'source-private-key' }))
  const config = { providers: { api: { apiKeyEnv: 'API_KEY', baseURL: 'https://api.example.invalid', models: [{ id: 'model', contextWindow: 200000 }], headers: { 'x-client': 'fixture' } }, local: { apiKeyEnv: 'LOCAL_KEY', baseURL: 'http://127.0.0.1:4002/v1' } } }
  const services: Record<string, any> = { settings: { describe: () => [{ ns: 'llm-pi-ai', value: config }] }, credentials: { resolve }, llm: { listConfigurableProviders: () => rows } }
  const source = await localModelSource({ get: (name: string) => services[name] })
  expect(source.providers).toHaveLength(1); expect(source.providers[0]?.config).toEqual(config.providers.api)
  expect(source.skipped).toMatchObject([{ provider: 'local', reason: 'local-endpoint' }]); expect(resolve).toHaveBeenCalledOnce()
})
it('imports a native API-key record but never reads an OAuth grant payload', async () => {
  const readRecord = vi.fn(async () => ({ kind: 'api-key', key: 'native-record-api-key' }))
  const services: Record<string, any> = {
    settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { api: {}, oauth: {} } } }] },
    credentials: { describeRecord: async (key: string) => ({ configured: true, kind: key.endsWith('/api') ? 'api-key' : 'grant' }), readRecord },
    llm: { listConfigurableProviders: () => ['api', 'oauth'].map(provider => ({ provider, displayName: provider, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider] })) },
  }
  const source = await localModelSource({ get: name => services[name] })
  expect(source.providers).toHaveLength(1); expect(source.providers[0]?.key).toBe('native-record-api-key')
  expect(source.skipped).toMatchObject([{ provider: 'oauth', reason: 'login-auth' }])
  expect(readRecord).toHaveBeenCalledExactlyOnceWith('llm-pi-ai/api')
})
