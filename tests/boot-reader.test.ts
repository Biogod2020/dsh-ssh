import { afterEach, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile, readFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { bootAssetPath } from '../src/remote/boot-assets.ts'
import { remoteBootRead } from '../src/remote/boot-reader.ts'

const roots: string[] = [], servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(s => { s.closeAllConnections(); return new Promise<void>(r => s.close(() => r())) })); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const source = '/plugins/??@deepseek-ai/dsh-client-ui-settings-account/client.js&rev=0123456789ab'
async function fixture() {
  const png = Buffer.alloc(80 * 1024, 7); Buffer.from([137,80,78,71,13,10,26,10]).copy(png)
  const code = `const illustration="data:image/png;base64,${png.toString('base64')}";export const account={illustration};`
  let reads = 0
  const server = createServer((req, res) => {
    if (req.url === '/?token=generated') { res.writeHead(303, { 'set-cookie': 'native=generated; HttpOnly', Location: '/' }); res.end(); return }
    if (req.url !== source || req.headers.cookie !== 'native=generated') { res.writeHead(403); res.end(); return }
    reads++; res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=31536000, immutable' }); res.end(code)
  }); servers.push(server); await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const expected = { pid: process.pid, port: (server.address() as {port: number}).port }, root = await mkdtemp(join(tmpdir(), 'compact-native-code-')); roots.push(root)
  await mkdir(join(root, 'state'), { mode: 0o700 }); await writeFile(join(root, 'state/server.json'), JSON.stringify({ ...expected, protocol: 1, root, url: `http://127.0.0.1:${expected.port}/?token=generated` }), { mode: 0o600 })
  return { root, expected, png, code, reads: () => reads }
}
it('removes large account images before SSH transfer and restores the exact original PNG only on demand', async () => {
  const f = await fixture(), artifact = await remoteBootRead(f.root, f.expected, { source }, bootAssetPath, { readFile, lstat, join, isAbsolute, createHash, gzipSync })
  const code = gunzipSync(Buffer.from(artifact.body, 'base64')).toString('utf8')
  expect(code.length).toBeLessThan(1000); expect(artifact.sourceBytes).toBeGreaterThan(100000); expect(artifact.kind).toBe('code')
  expect(code).not.toContain('data:image/png'); expect(code).toContain('export const account={illustration}')
  const imagePath = /"([^" ]+boot-image[^" ]+)"/.exec(code)![1]!, imageUrl = new URL(imagePath, 'http://127.0.0.1:12345')
  const hash = createHash('sha256').update(f.png).digest('hex')
  expect(imageUrl.pathname).toBe(`/__dsh_remote/boot-image/${hash}.png`)
  expect(Buffer.from(imageUrl.searchParams.get('source')!, 'base64url').toString()).toBe(source)
  const image = await remoteBootRead(f.root, f.expected, { source, image: hash }, bootAssetPath, { readFile, lstat, join, isAbsolute, createHash, gzipSync })
  expect(image.kind).toBe('image'); expect(Buffer.from(image.body, 'base64')).toEqual(f.png); expect(image.hash).toBe(hash); expect(f.reads()).toBe(2)
})
it('fails closed on a changed server or a request for anything except versioned native JavaScript', async () => {
  const f = await fixture()
  await expect(remoteBootRead(f.root, { ...f.expected, pid: 1 }, { source }, bootAssetPath, { readFile, lstat, join, isAbsolute, createHash, gzipSync })).rejects.toThrow('identity')
  for (const source of ['/api/session/list', 'https://example.test/plugins/??x/client.js&rev=0123456789ab', '/plugins/??../client.js&rev=0123456789ab', '/plugins/??x/client.js&rev=0123456789ab&token=secret']) await expect(remoteBootRead(f.root, f.expected, { source }, bootAssetPath, { readFile, lstat, join, isAbsolute, createHash, gzipSync })).rejects.toThrow('Invalid')
  expect(f.reads()).toBe(0)
})
it('does not return an arbitrary image or include the native authentication URL in artifacts', async () => {
  const f = await fixture()
  await expect(remoteBootRead(f.root, f.expected, { source, image: 'a'.repeat(64) }, bootAssetPath, { readFile, lstat, join, isAbsolute, createHash, gzipSync })).rejects.toThrow('not found')
  const code = await remoteBootRead(f.root, f.expected, { source }, bootAssetPath, { readFile, lstat, join, isAbsolute, createHash, gzipSync })
  expect(JSON.stringify(code)).not.toContain('token=generated')
})
it('serializes its remote program without capturing bundler helpers or project imports', () => {
  expect(remoteBootRead.toString()).not.toMatch(/__vite|__name|__import/)
})
