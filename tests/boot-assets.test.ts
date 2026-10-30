import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BootAssetCache, bootAssetPath } from '../src/remote/boot-assets.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function cache() { const root = await mkdtemp(join(tmpdir(), 'ssh-code-cache-')); roots.push(root); return new BootAssetCache(join(root, 'assets')) }
const asset = new URL('http://127.0.0.1:12345/plugins/??@generated/plugin/client.js&rev=0123456789ab')
const headers = { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=31536000, immutable', vary: 'Accept-Encoding' }

it('recognizes versioned native code without admitting APIs, tickets, HTML, files or arbitrary queries', () => {
  expect(bootAssetPath(asset)).toBe(true)
  expect(bootAssetPath(new URL('http://host/assets/vendor-abcdefgh.js'))).toBe(true)
  for (const path of ['/', '/?dsh-remote-ticket=secret', '/api/session/modelCatalog', '/files/file.js', '/assets/unversioned.js', '/assets/vendor-abcdefgh.js?token=secret', '/plugins/??@generated/plugin/client.js&rev=0123456789ab&token=secret', '/plugins/??../client.js&rev=0123456789ab']) expect(bootAssetPath(new URL(path, 'http://host'))).toBe(false)
})
it('persists code across cache instances and browser ports, with private files and Host/encoding isolation', async () => {
  const value = await cache(), body = Buffer.from('/* generated code */')
  await value.save('host-a:version', asset, 'gzip', headers, body)
  const again = new BootAssetCache(value.root), otherPort = new URL(asset); otherPort.port = '23456'
  expect((await again.read('host-a:version', otherPort, 'gzip'))?.body).toEqual(body)
  expect(await again.read('host-b:version', otherPort, 'gzip')).toBeUndefined()
  expect(await again.read('host-a:version', otherPort, 'br')).toBeUndefined()
  expect((await stat(value.root)).mode & 0o077).toBe(0)
  const files = await readdir(value.root); expect(files).toHaveLength(1)
  expect((await stat(join(value.root, files[0]!))).mode & 0o077).toBe(0)
})
it('does not persist dynamic, private, cookie-setting or unversioned responses', async () => {
  const value = await cache()
  for (const extra of [{ 'cache-control': 'private, immutable, max-age=100' }, { 'cache-control': 'public, no-store, immutable, max-age=100' }, { 'set-cookie': ['generated=value'] }, { vary: 'Cookie' }, { 'content-type': 'application/json' }]) {
    await value.save('a', asset, '', { ...headers, ...extra }, Buffer.from('generated'))
  }
  expect(await value.read('a', asset, '')).toBeUndefined()
  await value.save('a', new URL('http://host/api/models'), '', headers, Buffer.from('generated'))
  expect(await value.read('a', new URL('http://host/api/models'), '')).toBeUndefined()
})
it('treats damaged, expired or non-private files as misses', async () => {
  const value = await cache(); await value.save('a', asset, '', headers, Buffer.from('generated'))
  const path = join(value.root, (await readdir(value.root))[0]!), bytes = await readFile(path), split = bytes.indexOf(10), meta = JSON.parse(bytes.subarray(0, split).toString())
  await writeFile(path, Buffer.concat([bytes.subarray(0, split + 1), Buffer.from('corrupted')]))
  expect(await value.read('a', asset, '')).toBeUndefined()
  meta.expiresAt = 0; await writeFile(path, Buffer.concat([Buffer.from(JSON.stringify(meta) + '\n'), bytes.subarray(split + 1)]))
  expect(await value.read('a', asset, '')).toBeUndefined()
})
it('bounds stored bytes and removes only its own generated cache entries', async () => {
  const value = await cache(), body = Buffer.alloc(4 * 1024 * 1024, 1)
  await Promise.all(Array.from({ length: 17 }, (_, n) => value.save('a', new URL(`http://host/assets/code-abcdefgh${n}.js`), '', headers, body)))
  const files = await readdir(value.root), sizes = await Promise.all(files.map(name => stat(join(value.root, name))))
  expect(sizes.reduce((sum, row) => sum + row.size, 0)).toBeLessThanOrEqual(64 * 1024 * 1024)
})
