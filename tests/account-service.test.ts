import { it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, realpath, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
// @ts-expect-error shipped standalone runtime asset
import { ensureAccountWeb, prepareAccountHome, readAccountJson, accountWebActivity, stopAccountWeb, stageAccountService } from '../assets/account-service.mjs'
// @ts-expect-error shipped standalone native bridge
import { accountActivity } from '../assets/account-service-bridge.mjs'

it('joins the logical default to existing SSH data and refuses conflicting homes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-path-')), root = join(dir, 'runtime'), home = join(dir, 'default')
  await mkdir(join(root, 'data'), { recursive: true })
  expect(await prepareAccountHome({ root, home })).toBe(await realpath(join(root, 'data')))
  expect(await realpath(home)).toBe(await realpath(join(root, 'data')))
  const other = join(dir, 'other'); await mkdir(other)
  await expect(prepareAccountHome({ root, home: other })).rejects.toThrow('backed-up merge')
})
it('treats unsupported activity shapes and terminals as busy', async () => {
  expect(await accountActivity({ get: () => ({ list: async () => ({ items: [{}] }) }) })).toEqual({ checked: false, idle: false })
  const ctx = { get: (id: string) => id === 'sessionController' ? { list: async () => ({ items: [{ running: false }] }) } : { list: () => [{ id: 's' }] },
    waterfall: async (event: string) => event === 'workspace/session-activity' ? [{ kind: 'terminal' }] : [] }
  expect(await accountActivity(ctx)).toMatchObject({ checked: true, idle: false, activities: [{ kind: 'terminal' }] })
})
it('starts once under concurrent requests, reuses it, refuses busy stops, and protects receipts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-owner-')), home = join(dir, 'data'), root = join(dir, 'runtime')
  await mkdir(home); const core = join(dir, 'core.mjs'), busy = join(dir, 'busy')
  await writeFile(core, `#!${process.execPath}\nimport http from 'node:http';import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(join(dir, 'starts'))},'start\\n');const server=http.createServer((req,res)=>{
 if(req.url==='/?token=fixture'){res.writeHead(303,{'Set-Cookie':'fixture=yes'});res.end();return}
 if(req.url==='/api/dsh-account-service/activity'){res.end(JSON.stringify({checked:true,pid:process.pid,idle:!fs.existsSync(${JSON.stringify(busy)})}));return}
 res.writeHead(401);res.end();});server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port+'/?token=fixture'));process.on('SIGINT',()=>server.close(()=>process.exit()));`, { mode: 0o755 })
  const config = { root, home, dsh: core, node: process.execPath, version: 'fixture', port: 0, timeoutMs: 10000 }
  let pid: number | undefined
  try {
    const [a, b] = await Promise.all([ensureAccountWeb(config), ensureAccountWeb(config)]); pid = a.pid
    expect(a.pid).toBe(b.pid); expect((await ensureAccountWeb(config)).pid).toBe(pid)
    expect((await readFile(join(dir, 'starts'), 'utf8')).trim()).toBe('start')
    expect((await stat(join(home, 'services/web/server.json'))).mode & 0o077).toBe(0)
    await writeFile(busy, 'busy'); await expect(stopAccountWeb(config)).rejects.toThrow('active work')
    const receipt = await readAccountJson(join(home, 'services/web/server.json'))
    expect(await accountWebActivity(receipt)).toMatchObject({ checked: true, idle: false })
  } finally { if (pid) process.kill(pid, 'SIGINT') }
}, 15000)
it('stages the native bridge without changing existing YAML functions or installing a global entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-stage-')), home = join(dir, 'data'), root = join(dir, 'runtime')
  await mkdir(join(home, 'profiles/web'), { recursive: true })
  const before = '- id: other\n  config:\n    value: !!js/function () => 42\n'
  await writeFile(join(home, 'profiles/web/cordis.patch.yml'), before)
  const options = { root, home, dsh: '/fixture/dsh', node: process.execPath, version: 'fixture', serviceSource: 'export {};', bridgeSource: 'export {};', installEntry: false }
  await stageAccountService(options); const again = await stageAccountService({ ...options, dsh: '/fixture/another-core', version: 'newer' })
  expect(again.config.dsh).toBe('/fixture/dsh'); expect(again.config.version).toBe('fixture')
  const patch = await readFile(join(home, 'profiles/web/cordis.patch.yml'), 'utf8')
  expect(patch.startsWith(before)).toBe(true); expect(patch.match(/id: dsh-account-service/g)).toHaveLength(1)
})

it('runs the account entry through a symlinked home path', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'account-entry-')), module = join(dir, 'linked-entry.mjs'), home = join(dir, 'home'), config = join(dir, 'config.json')
 await mkdir(home); await symlink(fileURLToPath(new URL('../assets/account-service.mjs', import.meta.url)), module)
 await writeFile(config, JSON.stringify({ home }), { mode: 0o600 })
 const result = await promisify(execFile)(process.execPath, [module, '--account-service-cli', config, 'service', 'status'])
 expect(JSON.parse(result.stdout)).toMatchObject({ running: false, home: await realpath(home) })
})

it('retains an explicit stop when the backend is already absent', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'account-stop-')); await stopAccountWeb({ home: dir })
 expect(await readFile(join(dir, 'services/web/stopped'), 'utf8')).toBe('explicit-stop\n')
})
