import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const { stagePluginUpdate, stageModelBridge } = await import(new URL('../assets/remote-plugin-update.mjs', import.meta.url).href)
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-update-')); roots.push(root)
  const data = join(root, 'data'), profile = join(data, 'profiles/web'), packagePath = join(profile, 'node_modules/paper-review/package.json')
  mkdirSync(join(profile, 'node_modules/paper-review'), { recursive: true })
  writeFileSync(packagePath, JSON.stringify({ name: 'paper-review', version: '1.0.0' }))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'paper-review': '1.0.0' }, dsh: { profile: { bundles: [] } } }))
  writeFileSync(join(profile, 'pnpm-lock.yaml'), 'fixture-lock\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), '# unchanged user configuration\n')
  mkdirSync(join(root, 'tools/pnpm-11.20.0/node_modules/pnpm'), { recursive: true, mode: 0o700 })
  writeFileSync(join(root, 'tools/pnpm-11.20.0/node_modules/pnpm/package.json'), JSON.stringify({ name: 'pnpm', version: '11.20.0' }))
  const dsh = join(root, 'dsh'), marker = join(root, 'dispatches.json')
  writeFileSync(dsh, `#!${process.execPath}\nconst fs=require('node:fs');
const marker=${JSON.stringify(marker)},path=${JSON.stringify(packagePath)};
const rows=fs.existsSync(marker)?JSON.parse(fs.readFileSync(marker,'utf8')):[];
rows.push({args:process.argv.slice(2),cwd:process.cwd(),dshHome:process.env.DSH_HOME});fs.writeFileSync(marker,JSON.stringify(rows));
fs.writeFileSync(path,JSON.stringify({name:'paper-review',version:'1.2.0'}));
`, { mode: 0o700 })
  return { root, data, profile, marker, input: { root, node: process.execPath, dsh, name: 'paper-review', version: '1.2.0', expectedVersion: '1.0.0', expectedEnabled: false, requestId: 'fixture-update-request-01' } }
}
it('stages through the official CLI arguments in private data cwd, backs up files and preserves disabled state', async () => {
  const f = fixture(), result = await stagePluginUpdate(f.input)
  expect(result).toMatchObject({ application: 'restart-required', version: '1.2.0' })
  expect(JSON.parse(readFileSync(f.marker, 'utf8'))).toEqual([{ args: ['plugin', '--profile', 'web', 'exec', join(f.root, 'tools/pnpm-11.20.0/node_modules/.bin/pnpm'), 'add', 'paper-review@1.2.0', '--save-exact'], cwd: realpathSync(f.data), dshHome: f.data }])
  expect(readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8')).toBe('# unchanged user configuration\n')
  expect(JSON.parse(readFileSync(join(f.root, 'state/plugin-updates', f.input.requestId, 'package.json'), 'utf8')).dependencies['paper-review']).toBe('1.0.0')
  expect(await stagePluginUpdate(f.input)).toEqual(result)
  expect(JSON.parse(readFileSync(f.marker, 'utf8'))).toHaveLength(1)
})
it('rejects stale selections and interrupted receipts without starting another command', async () => {
  const f = fixture()
  const result = await stagePluginUpdate({ ...f.input, expectedVersion: '0.9.0' })
  expect(result).toMatchObject({ application: 'failed', error: { code: 'stale-approval' } })
  const requestId = 'fixture-interrupted-01'
  mkdirSync(join(f.root, 'state/plugin-updates', requestId))
  await expect(stagePluginUpdate({ ...f.input, requestId })).rejects.toThrow('not replayed')
  expect(() => readFileSync(f.marker)).toThrow()
})
it('rejects package paths and shell options before creating a receipt', async () => {
  const f = fixture()
  for (const name of ['../package', '--execute', 'paper;touch-marker'])
    await expect(stagePluginUpdate({ ...f.input, name })).rejects.toThrow('Invalid reviewed')
  expect(() => readFileSync(f.marker)).toThrow()
})

it('does not dispatch another package command while an update lock survives interruption', async () => {
  const f = fixture()
  mkdirSync(join(f.root, 'state/plugin-update.lock'), { recursive: true })
  writeFileSync(join(f.root, 'state/plugin-update.lock/pid'), '123')
  const result = await stagePluginUpdate(f.input)
  expect(result).toMatchObject({ application: 'failed', error: { code: 'update-active-or-interrupted' } })
  expect(readFileSync(join(f.root, 'state/plugin-update.lock/pid'), 'utf8')).toBe('123')
  expect(() => readFileSync(f.marker)).toThrow()
})
it('updates an exact server plugin inside its existing pnpm profile workspace', async () => {
  const f = fixture()
  writeFileSync(join(f.profile, 'pnpm-workspace.yaml'), 'packages:\n  - "."\n')
  expect(await stagePluginUpdate(f.input)).toMatchObject({ application: 'restart-required' })
  expect(JSON.parse(readFileSync(f.marker, 'utf8'))[0].args).toEqual(['plugin', '--profile', 'web', 'exec', join(f.root, 'tools/pnpm-11.20.0/node_modules/.bin/pnpm'), 'add', 'paper-review@1.2.0', '--workspace-root', '--save-exact'])
})

function modelFixture() {
  const f = fixture(), source = '// generated model helper\n'
  const hash = createHash('sha256').update(source).digest('hex'), version = `0.0.0-${hash.slice(0, 16)}`
  const name = `@jay-local/dsh-ssh-model-bridge-${hash.slice(0, 16)}`
  const bundle = join(f.root, 'model-bridge', 'bundles-v2', hash)
  mkdirSync(bundle, { recursive: true, mode: 0o700 })
  writeFileSync(join(bundle, 'index.mjs'), source)
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name, version }))
  writeFileSync(f.input.dsh, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');
const marker=${JSON.stringify(f.marker)},bundle=${JSON.stringify(bundle)},profile=${JSON.stringify(f.profile)};
const rows=fs.existsSync(marker)?JSON.parse(fs.readFileSync(marker,'utf8')):[];
rows.push({args:process.argv.slice(2),privatePnpm:process.env.PATH.includes(${JSON.stringify(join(f.root, 'tools/pnpm-11.20.0/node_modules/.bin'))})});fs.writeFileSync(marker,JSON.stringify(rows));
if(fs.existsSync(path.join(profile,'pnpm-workspace.yaml'))&&!process.argv.includes('--workspace-root'))process.exit(9);
fs.mkdirSync(path.join(profile,'node_modules/@jay-local'),{recursive:true});fs.symlinkSync(bundle,path.join(profile,'node_modules',${JSON.stringify(name)}));
`, { mode: 0o700 })
  return { ...f, bundle, hash, version, input: { root: f.root, node: process.execPath, dsh: f.input.dsh, hash } }
}
it('prepares the exact bundled helper using private pnpm without changing user model settings or replaying a completed CLI install', async () => {
  const f = modelFixture(), result = await stageModelBridge(f.input)
  expect(result).toMatchObject({ application: 'staged', version: f.version })
  expect(JSON.parse(readFileSync(f.marker, 'utf8'))).toEqual([{ args: ['plugin', '--profile', 'web', 'exec', join(f.root, 'tools/pnpm-11.20.0/node_modules/.bin/pnpm'), 'add', `link:${f.bundle}`], privatePnpm: true }])
  expect(readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8')).toBe('# unchanged user configuration\n')
  expect(await stageModelBridge(f.input)).toEqual(result)
  expect(JSON.parse(readFileSync(f.marker, 'utf8'))).toHaveLength(1)
})
it('does not replay an interrupted helper install or bypass the shared plugin-update lock', async () => {
  const f = modelFixture()
  const directory = join(f.root, 'state/model-bridge-updates/v4', f.hash)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  await expect(stageModelBridge(f.input)).rejects.toThrow('not replayed')
  expect(() => readFileSync(f.marker)).toThrow()
  rmSync(directory, { recursive: true })
  mkdirSync(join(f.root, 'state/plugin-update.lock'))
  expect(await stageModelBridge(f.input)).toMatchObject({ application: 'failed', error: { code: 'update-active-or-interrupted' } })
  expect(() => readFileSync(f.marker)).toThrow()
})
it('rejects a helper whose content does not match its immutable build identity before dispatch', async () => {
  const f = modelFixture()
  writeFileSync(join(f.bundle, 'index.mjs'), '// changed externally\n')
  await expect(stageModelBridge(f.input)).rejects.toThrow('source mismatch')
  expect(() => readFileSync(f.marker)).toThrow()
})
it('scopes later helper installs to the profile workspace created by pnpm 11', async () => {
  const f = modelFixture()
  writeFileSync(join(f.profile, 'pnpm-workspace.yaml'), 'packages:\n  - "."\n')
  expect(await stageModelBridge(f.input)).toMatchObject({ application: 'staged' })
  expect(JSON.parse(readFileSync(f.marker, 'utf8'))[0].args).toEqual(['plugin', '--profile', 'web', 'exec', join(f.root, 'tools/pnpm-11.20.0/node_modules/.bin/pnpm'), 'add', `link:${f.bundle}`, '--workspace-root'])
  expect(readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8')).toBe('# unchanged user configuration\n')
})
it('passes the absolute private package manager to the official npm CLI entry', async () => {
  const f = modelFixture(), dsh = join(f.root, 'native-cli.mjs')
  writeFileSync(dsh, `import {readFileSync,writeFileSync,mkdirSync,symlinkSync} from 'node:fs';import {join} from 'node:path';
export async function runCli(options){
 if(options.packageManager.command!==${JSON.stringify(join(f.root, 'tools/pnpm-11.20.0/node_modules/.bin/pnpm'))})throw Error('Wrong package manager');
 writeFileSync(${JSON.stringify(f.marker)},JSON.stringify({command:options.packageManager.command,args:process.argv.slice(2)}));
 mkdirSync(${JSON.stringify(join(f.profile, 'node_modules/@jay-local'))},{recursive:true});
 const pkg=JSON.parse(readFileSync(${JSON.stringify(join(f.bundle, 'package.json'))},'utf8'));symlinkSync(${JSON.stringify(f.bundle)},join(${JSON.stringify(f.profile)},'node_modules',pkg.name));
}`, { mode: 0o700 })
  expect(await stageModelBridge({ ...f.input, dsh })).toMatchObject({ application: 'staged' })
  expect(JSON.parse(readFileSync(f.marker, 'utf8')).args).toEqual(['plugin', '--profile', 'web', 'add', `link:${f.bundle}`])
})
