import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { HostStore } from '../src/store.ts'
import { SshEngine } from '../src/engine.ts'
import { makeRoutes } from '../src/routes.ts'
import { TestSshd } from './helpers/sshd.ts'

async function fixture(changeDuringBody = false) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-transfer-target-')), remote = join(root, 'remote')
  mkdirSync(remote); const sshd = await TestSshd.start({ home: remote })
  const store = new HostStore(join(root, 'hosts.json')), engine = new SshEngine(store)
  const entry = store.create({ alias: 'fixture', host: '127.0.0.1', port: sshd.port, user: process.env.USER!, auth: { kind: 'key', keyPath: sshd.clientKey } })
  const version = entry.updatedAt
  const { routes } = makeRoutes({ store, engine, stagingDir: join(root, 'staging'), requestRejection: () => undefined })
  const server = createServer((req, res) => {
    void routes.find(route => route.path === req.url?.split('?')[0])!.handler(req, res)
    if (changeDuringBody) req.once('data', () => store.update('fixture', { description: 'changed while staging' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { root, remote, store, engine, version, origin: `http://127.0.0.1:${address.port}`,
    async close() { engine.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); sshd.stop(); rmSync(root, { recursive: true, force: true }) } }
}

it.each(['upload', 'download'] as const)('rejects stale %s targets before any SSH dispatch', async kind => {
  const f = await fixture()
  try {
    f.store.update('fixture', { description: 'new version' })
    const response = await fetch(f.origin + `/api/dsh-ssh/${kind}?` + new URLSearchParams({ alias: 'fixture', remotePath: f.remote + '/untouched.txt', expectedUpdatedAt: String(f.version) }), kind === 'upload' ? { method: 'POST', body: 'never write' } : {})
    expect(response.status).toBe(409); expect(await response.text()).toContain('no transfer was dispatched')
    expect(f.engine.pool.size).toBe(0); expect(existsSync(f.remote + '/untouched.txt')).toBe(false)
  } finally { await f.close() }
})

it('checks the frozen version again after upload staging and refuses a changed host', async () => {
  const f = await fixture(true)
  try {
    const response = await fetch(f.origin + '/api/dsh-ssh/upload?' + new URLSearchParams({ alias: 'fixture', remotePath: f.remote + '/untouched.txt', expectedUpdatedAt: String(f.version) }), { method: 'POST', body: 'never write' })
    const frames = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
    expect(frames.at(-1)).toMatchObject({ type: 'result', ok: false })
    expect(frames.at(-1).error).toContain('no transfer was dispatched')
    expect(f.engine.pool.size).toBe(0); expect(existsSync(f.remote + '/untouched.txt')).toBe(false)
  } finally { await f.close() }
})
