import { expect, it, vi } from 'vitest'
import { ServerPlugins, rejectedRequirement } from '../src/remote/plugins.ts'
import type { RemoteWorkspaces } from '../src/remote/manager.ts'

function fixture() {
  const local = [{ name: 'paper-review', version: '1.2.0', enabled: true, official: false, development: false },
    { name: 'local-tools', version: '1.0.0', enabled: true, official: false, development: true }]
  let remote = [{ name: 'remote-extra', version: '9.0.0', enabled: true, official: false, installed: true }]
  let changed = false
  const installs: Array<{ spec: string; options: { enabled: boolean } }> = []
  const rpc = vi.fn(async (method: string, args: any) => {
    if (method.endsWith('/listBundles')) return structuredClone(remote)
    if (method.endsWith('/installBundle')) {
      installs.push(args)
      const at = args.spec.lastIndexOf('@'), name = args.spec.slice(0, at), version = args.spec.slice(at + 1)
      remote = remote.filter(row => row.name !== name).concat({ name, version, enabled: args.options.enabled, official: false, installed: true })
      return { application: 'applied', changed: true }
    }
    throw new Error('Unexpected RPC')
  })
  const access = { hostId: 'a'.repeat(24), version: '0.2.1-rc.3', gateway: { rpc }, check: () => { if (changed) throw new Error('Host changed') } }
  const pluginAccess = vi.fn((_alias: string, expected: number) => { expect(expected).toBe(42); access.check(); return access })
  const manifest = vi.fn(async (name: string, version: string) => ({ name, version, dsh: { bundle: { patch: 'cordis.patch.yml' } }, engines: { dsh: '0.2.1-rc.3' } }))
  const service = new ServerPlugins({ pluginAccess } as unknown as Pick<RemoteWorkspaces, 'pluginAccess'>, async () => structuredClone(local), manifest)
  return { service, local, rpc, manifest, installs, access, remote: () => remote, setRemote: (rows: typeof remote) => { remote = rows }, changeHost: () => { changed = true } }
}
async function finished(f: ReturnType<typeof fixture>, id: string) {
  await vi.waitFor(() => expect(f.service.job(id)?.state).not.toBe('running'))
  return f.service.job(id)!
}
it('compares exact versions, retains remote-only plugins, and never publishes sources or config', async () => {
  const f = fixture(), plan = await f.service.compare('fixture', 42)
  expect(plan.rows.find(row => row.name === 'paper-review')).toMatchObject({ status: 'missing', spec: 'paper-review@1.2.0' })
  expect(plan.rows.find(row => row.name === 'local-tools')).toMatchObject({ block: 'development' })
  expect(plan.rows.find(row => row.name === 'remote-extra')).toMatchObject({ block: 'remote-only' })
  expect(f.manifest).toHaveBeenCalledOnce(); expect(f.installs).toEqual([])
  expect(JSON.stringify(plan)).not.toMatch(/source|manifest|credentials|apiKey|password/)
})
it('blocks unsupported engines and DSH peers, including prerelease requirements', () => {
  expect(rejectedRequirement({ engines: { dsh: '0.2.1-rc.3' } }, '0.2.1-alpha.4')).toBe('0.2.1-rc.3')
  expect(rejectedRequirement({ peerDependencies: { '@deepseek-ai/dsh-llm': '0.2.1-rc.3' } }, '0.2.1-alpha.4')).toBe('0.2.1-rc.3')
  expect(rejectedRequirement({ engines: { dsh: '0.2.1-alpha.4 || 0.2.1-rc.3' } }, '0.2.1-alpha.4')).toBeUndefined()
})
it('disables unpublished, incompatible and builtin packages before a sync can be submitted', async () => {
  const f = fixture()
  f.manifest.mockResolvedValueOnce(null as any)
  let plan = await f.service.compare('fixture', 42)
  expect(plan.rows[0]).toMatchObject({ name: 'local-tools', block: 'development' })
  expect(plan.rows.find(row => row.name === 'paper-review')?.block).toBe('unpublished')
  await expect(f.service.start(plan.planId, ['paper-review'], 'request-unpublished-01')).rejects.toThrow('cannot be synced')
  f.local[0]!.official = true
  plan = await f.service.compare('fixture', 42)
  expect(plan.rows.find(row => row.name === 'paper-review')?.block).toBe('builtin')
  f.local[0]!.official = false
  f.manifest.mockResolvedValueOnce({ engines: { dsh: '0.1.0' } } as any)
  plan = await f.service.compare('fixture', 42)
  expect(plan.rows.find(row => row.name === 'paper-review')?.block).toBe('incompatible')
  expect(f.installs).toEqual([])
})
it('installs only reviewed exact packages once and preserves remote enablement and extra packages', async () => {
  const f = fixture()
  f.setRemote([...f.remote(), { name: 'paper-review', version: '1.0.0', enabled: false, official: false, installed: true }])
  const plan = await f.service.compare('fixture', 42), id = 'request-preserve-state-01'
  await f.service.start(plan.planId, ['paper-review'], id)
  const done = await finished(f, id)
  expect(done.state).toBe('complete'); expect(done.items[0]?.state).toBe('installed')
  expect(f.installs).toEqual([{ spec: 'paper-review@1.2.0', options: { saveExact: true, enabled: false, requestId: id + '-0' } }])
  expect(f.remote().find(row => row.name === 'remote-extra')?.version).toBe('9.0.0')
  await f.service.start(plan.planId, ['paper-review'], id)
  expect(f.installs).toHaveLength(1)
})
it('refuses changed host identities and stale inventories without dispatching installation', async () => {
  const f = fixture(), plan = await f.service.compare('fixture', 42)
  f.setRemote([...f.remote(), { name: 'paper-review', version: '1.1.0', enabled: true, official: false, installed: true }])
  await expect(f.service.start(plan.planId, ['paper-review'], 'request-stale-inventory')).rejects.toThrow('versions changed')
  f.changeHost()
  await expect(f.service.compare('fixture', 42)).rejects.toThrow('Host changed')
  expect(f.installs).toEqual([])
})
it('marks a lost install response uncertain, stops the batch and never replays', async () => {
  const f = fixture()
  f.local.push({ name: 'second-plugin', version: '1.0.0', enabled: true, official: false, development: false })
  const original = f.rpc.getMockImplementation()!
  f.rpc.mockImplementation(async (method, args) => {
    if (method.endsWith('/installBundle')) { f.installs.push(args); throw new Error('connection lost') }
    return original(method, args)
  })
  const plan = await f.service.compare('fixture', 42), id = 'request-lost-response-01'
  await f.service.start(plan.planId, ['paper-review', 'second-plugin'], id)
  expect((await finished(f, id))).toMatchObject({ state: 'uncertain', items: [{ state: 'uncertain' }, { state: 'skipped' }] })
  await f.service.start(plan.planId, ['paper-review', 'second-plugin'], id)
  expect(f.installs).toHaveLength(1)
})
it('reports restart requirements only after verifying the installed version and does not restart', async () => {
  const f = fixture(), original = f.rpc.getMockImplementation()!
  f.rpc.mockImplementation(async (method, args) => {
    const result = await original(method, args)
    return method.endsWith('/installBundle') ? { application: 'restart-required', changed: true } : result
  })
  const plan = await f.service.compare('fixture', 42), id = 'request-restart-required'
  await f.service.start(plan.planId, ['paper-review'], id)
  expect((await finished(f, id)).items[0]?.state).toBe('restart-required')
  expect(f.rpc.mock.calls.every(([method]) => ['pluginManager/listBundles', 'pluginManager/installBundle'].includes(method))).toBe(true)
})
it('reserves a request before concurrent preflight and refuses another selection using that id', async () => {
  const f = fixture(), plan = await f.service.compare('fixture', 42), id = 'request-concurrent-submit'
  await Promise.all([f.service.start(plan.planId, ['paper-review'], id), f.service.start(plan.planId, ['paper-review'], id)])
  await finished(f, id)
  expect(f.installs).toHaveLength(1)
  await expect(f.service.start(plan.planId, ['local-tools'], id)).rejects.toThrow('another selection')
})
it('stages existing package updates through the official CLI bridge and preserves their enablement', async () => {
  const f = fixture()
  f.setRemote([...f.remote(), { name: 'paper-review', version: '1.0.0', enabled: false, official: false, installed: true }])
  const stageUpdate = vi.fn(async (name: string, version: string) => {
    f.setRemote(f.remote().filter(row => row.name !== name).concat({ name, version, enabled: false, official: false, installed: true }))
    return { application: 'restart-required', version }
  })
  ;(f.access as any).stageUpdate = stageUpdate
  const plan = await f.service.compare('fixture', 42), id = 'request-official-update'
  await f.service.start(plan.planId, ['paper-review'], id)
  expect((await finished(f, id)).items[0]?.state).toBe('restart-required')
  expect(stageUpdate).toHaveBeenCalledWith('paper-review', '1.2.0', '1.0.0', false, id + '-0')
  expect(f.installs).toEqual([])
})
