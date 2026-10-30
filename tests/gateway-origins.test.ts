import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayOrigins } from '../src/remote/gateway-origins.ts'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'ssh-origin-')); roots.push(root); return new GatewayOrigins(join(root, 'origins')) }
it('retains a port across instances while isolating Hosts and controller origins', async () => {
  const value = await fixture(); await value.remember('a'.repeat(24), 'http://127.0.0.1:3080/', 51234)
  const again = new GatewayOrigins(value.root)
  expect(await again.preferred('a'.repeat(24), 'http://127.0.0.1:3080/')).toBe(51234)
  expect(await again.preferred('b'.repeat(24), 'http://127.0.0.1:3080/')).toBeUndefined()
  expect(await again.preferred('a'.repeat(24), 'http://127.0.0.1:9999/')).toBeUndefined()
})
it('ignores malformed and privileged ports instead of changing or resetting session files', async () => {
  const value = await fixture(); await value.remember('a', 'http://127.0.0.1:3080/', 51234)
  const file = join(value.root, (await readdir(value.root))[0]!)
  await writeFile(file, JSON.stringify({ version: 1, port: 22 }))
  expect(await value.preferred('a', 'http://127.0.0.1:3080/')).toBeUndefined()
  await writeFile(file, '{broken')
  expect(await value.preferred('a', 'http://127.0.0.1:3080/')).toBeUndefined()
})
