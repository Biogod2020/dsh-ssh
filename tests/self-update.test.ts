import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, type Server } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { runUpdate, readJson, atomicJson, UPDATE_PACKAGE } from '../src/update-worker.ts'
import { SelfUpdate } from '../src/self-update.ts'
import { updateServicePlan } from '../src/update-service.ts'
import type { UpdateConfig } from '../src/update-types.ts'

const roots: string[] = [], servers: Server[] = [], children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) child.kill()
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function fixture() {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-update-test-')); roots.push(profile)
  const root = join(profile, '.dsh-ssh-updates'), target = join(profile, 'node_modules/@biogod/dsh-ssh')
  await mkdir(join(root, 'hosts'), { recursive: true }); await mkdir(target, { recursive: true })
  await atomicJson(join(profile, 'package.json'), { private: true, custom: 'keep', dependencies: { [UPDATE_PACKAGE]: '0.3.24-jay.69', 'other-plugin': '1.0.0' } })
  await writeFile(join(profile, 'pnpm-lock.yaml'), 'original lock')
  await writeFile(join(profile, 'cordis.patch.yml'), 'original settings')
  await atomicJson(join(target, 'package.json'), { name: UPDATE_PACKAGE, version: '0.3.24-jay.69' })
  await writeFile(join(target, 'original'), 'retained')
  const runtime = join(profile, 'runtime.json'); await atomicJson(runtime, { version: '0.2.1-rc.5' })
  const artifact = Buffer.from('generated update archive fixture'), integrity = 'sha512-' + createHash('sha512').update(artifact).digest('base64')
  let downloads = 0, incompatible = false, corrupt = false
  const server = createServer((req, res) => {
    if (req.url === '/@biogod%2fdsh-ssh') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ 'dist-tags': { latest: '0.3.24-jay.70' }, versions: {
        '0.3.24-jay.70': { name: UPDATE_PACKAGE, version: '0.3.24-jay.70', engines: { dsh: incompatible ? '0.2.2' : '>=0.2.1-rc.2 <0.2.2-0' },
          dist: { tarball: registry + '/@biogod/dsh-ssh/-/dsh-ssh-0.3.24-jay.70.tgz', integrity } },
      } }))
    } else { downloads++; res.end(corrupt ? 'corrupt bytes' : artifact) }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server)
  const registry = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  const manager = join(profile, 'manager.cjs')
  await writeFile(manager, `const fs=require('fs'),p=require('path');const manifest=p.join(process.cwd(),'package.json');
const pkg=JSON.parse(fs.readFileSync(manifest));
if(process.argv.includes('--lockfile-only')) {pkg.dependencies['@biogod/dsh-ssh']='0.3.24-jay.70';fs.writeFileSync(manifest,JSON.stringify(pkg));fs.writeFileSync('pnpm-lock.yaml',${JSON.stringify(integrity)});}
else {const dir=p.join(process.cwd(),'node_modules/@biogod/dsh-ssh');fs.mkdirSync(p.join(dir,'lib'),{recursive:true});
fs.writeFileSync(p.join(dir,'package.json'),JSON.stringify({name:'@biogod/dsh-ssh',version:'0.3.24-jay.70',engines:{dsh:'>=0.2.1-rc.2 <0.2.2-0'}}));
for(const file of ['lib/index.js','lib/client.js','lib/update-worker.js','cordis.patch.yml'])fs.writeFileSync(p.join(dir,file),'generated');}
`)
  const config: UpdateConfig = { enabled: true, profile, runtimeManifest: runtime, executable: process.execPath, executableArgs: [], packageManager: { command: process.execPath, args: [manager], env: {} } }
  const configFile = join(root, 'config.json'); await atomicJson(configFile, config)
  return { profile, root, target, config, configFile, registry, runtime,
    setIncompatible: () => { incompatible = true }, corrupt: () => { corrupt = true }, downloads: () => downloads }
}
async function phase(root: string) { return (await readJson<{ phase: string }>(join(root, 'status.json'))).phase }
async function waitFor(check: () => Promise<boolean>) {
  for (let n = 0; n < 150; n++) { if (await check().catch(() => false)) return; await new Promise(resolve => setTimeout(resolve, 40)) }
  throw new Error('Fixture deadline exceeded')
}

it('updates only the plugin after every Host exits and preserves unrelated profile data', async () => {
  const f = await fixture()
  const host = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']); children.push(host)
  await atomicJson(join(f.root, 'hosts', host.pid + '.json'), { pid: host.pid })
  const update = runUpdate(f.configFile, { registry: f.registry })
  await waitFor(async () => await phase(f.root) === 'waiting')
  expect((await readJson<any>(join(f.target, 'package.json'))).version).toBe('0.3.24-jay.69')
  host.kill(); await new Promise(resolve => host.once('exit', resolve))
  await update
  expect(await phase(f.root)).toBe('installed')
  expect((await readJson<any>(join(f.target, 'package.json'))).version).toBe('0.3.24-jay.70')
  expect((await readJson<any>(join(f.profile, 'package.json'))).dependencies['other-plugin']).toBe('1.0.0')
  expect((await readJson<any>(join(f.profile, 'package.json'))).custom).toBe('keep')
  expect(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8')).toBe('original settings')
}, 15000)

it.each(['incompatible', 'checksum'])('keeps the installed package after a refused %s update', async reason => {
  const f = await fixture()
  if (reason === 'incompatible') f.setIncompatible(); else f.corrupt()
  await runUpdate(f.configFile, { registry: f.registry })
  expect(await phase(f.root)).toBe(reason === 'incompatible' ? 'ready' : 'failed')
  expect(await readFile(join(f.target, 'original'), 'utf8')).toBe('retained')
  expect(await readFile(join(f.profile, 'pnpm-lock.yaml'), 'utf8')).toBe('original lock')
  if (reason === 'incompatible') expect(f.downloads()).toBe(0)
})

it('rolls back both the package and profile metadata after a commit failure', async () => {
  const f = await fixture()
  const before = await readFile(join(f.profile, 'package.json'), 'utf8')
  await runUpdate(f.configFile, { registry: f.registry, afterStep: async step => { if (step === 'package.json') throw new Error('injected commit failure') } })
  expect(await phase(f.root)).toBe('failed')
  expect(await readFile(join(f.target, 'original'), 'utf8')).toBe('retained')
  expect(await readFile(join(f.profile, 'package.json'), 'utf8')).toBe(before)
  expect(await readFile(join(f.profile, 'pnpm-lock.yaml'), 'utf8')).toBe('original lock')
}, 15000)

it('backs out when a new Host starts during the metadata transaction', async () => {
  const f = await fixture()
  const before = await readFile(join(f.profile, 'package.json'), 'utf8')
  await runUpdate(f.configFile, { registry: f.registry, afterStep: async step => {
    if (step === 'package.json') await atomicJson(join(f.root, 'hosts', process.pid + '.json'), { pid: process.pid })
  } })
  expect(await phase(f.root)).toBe('failed')
  expect(await readFile(join(f.target, 'original'), 'utf8')).toBe('retained')
  expect(await readFile(join(f.profile, 'package.json'), 'utf8')).toBe(before)
}, 15000)

it('cancels a prepared update when the persisted opt-in is turned off', async () => {
  const f = await fixture()
  await atomicJson(join(f.root, 'hosts', process.pid + '.json'), { pid: process.pid })
  const run = runUpdate(f.configFile, { registry: f.registry })
  await waitFor(async () => await phase(f.root) === 'waiting')
  await atomicJson(f.configFile, { ...f.config, enabled: false })
  await run
  expect(await readFile(join(f.target, 'original'), 'utf8')).toBe('retained')
}, 15000)

it.each([true, false])('recovers an interrupted rename without replaying it when enabled=%s', async enabled => {
  const f = await fixture(), backup = join(f.root, 'previous-aabb')
  await atomicJson(f.configFile, { ...f.config, enabled })
  const files = { 'package.json': await readFile(join(f.profile, 'package.json'), 'utf8'), 'pnpm-lock.yaml': 'original lock', 'pnpm-workspace.yaml': null }
  await atomicJson(join(f.root, 'transaction.json'), { target: f.target, backup, moved: false, linked: false, files })
  await rename(f.target, backup)
  await runUpdate(f.configFile, { registry: f.registry })
  expect(await readFile(join(f.target, 'original'), 'utf8')).toBe('retained')
  expect(f.downloads()).toBe(0)
  expect(await phase(f.root)).toBe('failed')
})

it('persists consent, starts the independent helper on later loads, and does nothing when off', async () => {
  const f = await fixture(), pkg = join(f.profile, 'bootstrap')
  await mkdir(join(pkg, 'lib'), { recursive: true }); await atomicJson(join(pkg, 'package.json'), { version: '0.3.24-jay.69' })
  await writeFile(join(pkg, 'lib/update-worker.js'), '// fixture')
  await atomicJson(f.configFile, { ...f.config, enabled: false })
  const configureService = vi.fn(async () => {}), launch = vi.fn()
  const profile = { dir: f.profile, home: f.profile, installAnchor: f.runtime, packageManager: f.config.packageManager }
  const updater = new SelfUpdate(profile, { packageRoot: pkg, configureService, launch })
  expect((await updater.view()).enabled).toBe(false); expect(launch).not.toHaveBeenCalled()
  await updater.setEnabled(true)
  expect(configureService).toHaveBeenCalledOnce(); expect(launch).toHaveBeenCalledOnce()
  const loaded = new SelfUpdate(profile, { packageRoot: pkg, configureService, launch })
  expect((await loaded.view()).enabled).toBe(true); expect(launch).toHaveBeenCalledTimes(2)
  await loaded.setEnabled(false)
  expect((await loaded.view()).enabled).toBe(false)
})

it('uses account-scoped schedulers with quoted arguments and no shell execution', async () => {
  const f = await fixture()
  const mac = updateServicePlan('/private/with & space/config.json', '/private/worker.mjs', f.config, 'darwin', '/test user', 501)
  expect(Object.values(mac.files)[0]).toContain('with &amp; space')
  expect(mac.enable[0]).toEqual(['launchctl', 'bootstrap', 'gui/501', expect.stringContaining(join('/test user', 'Library/LaunchAgents') )])
  const windows = updateServicePlan("C:\\user's space\\config.json", 'C:\\worker.mjs', f.config, 'win32')
  expect(Object.values(windows.files).join('')).toContain("user''s space")
  const registration = Buffer.from(windows.enable[0]!.at(-1)!, 'base64').toString('utf16le')
  expect(registration).toContain('-LogonType Interactive -RunLevel Limited')
  expect(registration).toContain('New-TimeSpan -Hours 6')
  const linux = updateServicePlan('/private/config.json', '/private/worker.mjs', f.config, 'linux', '/test user')
  expect(Object.values(linux.files).join('')).toContain('OnUnitInactiveSec=6h')
  expect(linux.enable.every(command => command[0] === 'systemctl' && command[1] === '--user')).toBe(true)
})

it('requires authenticated loopback access and keeps service configuration out of responses', async () => {
  const f = await fixture()
  const updater = new SelfUpdate(undefined)
  const route = updater.route(req => req.headers.authorization === 'fixture' ? undefined : 401)
  const server = createServer((req, res) => { void route.handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server)
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + route.path
  expect((await fetch(url)).status).toBe(401)
  const allowed = await fetch(url, { headers: { Authorization: 'fixture' } })
  expect(allowed.status).toBe(200)
  const view = await allowed.json()
  expect(view.enabled).toBe(false)
  expect(JSON.stringify(view)).not.toContain(f.profile)
  expect((await fetch(url, { method: 'POST', headers: { Authorization: 'fixture', 'Content-Type': 'application/json' }, body: '{"enabled":"yes"}' })).status).toBe(400)
})

it('turns consent back off when installing the user service fails', async () => {
  const f = await fixture(), pkg = join(f.profile, 'bootstrap')
  await mkdir(join(pkg, 'lib'), { recursive: true }); await atomicJson(join(pkg, 'package.json'), { version: '0.3.24-jay.69' })
  await writeFile(join(pkg, 'lib/update-worker.js'), '// fixture')
  await atomicJson(f.configFile, { ...f.config, enabled: false })
  const launch = vi.fn(), updater = new SelfUpdate({ dir: f.profile, home: f.profile, installAnchor: f.runtime, packageManager: f.config.packageManager },
    { packageRoot: pkg, configureService: async () => { throw Error('No user service manager') }, launch })
  await expect(updater.setEnabled(true)).rejects.toThrow('Could not configure')
  expect((await updater.view()).enabled).toBe(false)
  expect(launch).not.toHaveBeenCalled()
})

it.skipIf(process.platform !== 'win32')('resolves the Windows pnpm command to an executable invocation', async () => {
  const f = await fixture(), pkg = join(f.profile, 'bootstrap')
  await mkdir(join(pkg, 'lib'), { recursive: true }); await atomicJson(join(pkg, 'package.json'), { version: '0.3.24-jay.69' })
  await writeFile(join(pkg, 'lib/update-worker.js'), '// fixture')
  await atomicJson(f.configFile, { ...f.config, enabled: false })
  const updater = new SelfUpdate({ dir: f.profile, home: f.profile, installAnchor: f.runtime }, { packageRoot: pkg })
  expect((await updater.view()).supported).toBe(true)
  const invocation = (await readJson<UpdateConfig>(f.configFile)).packageManager
  expect(invocation.command).toMatch(/\.exe$/i)
  expect(invocation.command).not.toMatch(/\.cmd$/i)
})
