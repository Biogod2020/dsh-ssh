/** Verify the exact tested archive on npm and the actual mainland mirror CDN. */
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const archive = process.argv[2]
assert(archive, 'usage: node scripts/verify-published.mjs <verified.tgz>')
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
assert.equal(pkg.name, '@biogod/dsh-ssh')
const bytes = await readFile(archive)
const expected = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
const official = 'https://registry.npmjs.org', mirror = 'https://registry.npmmirror.com'
const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(30000) })
async function verify(registry) {
  // Read the canonical package document, as npm clients do. A version URL
  // requested before publication can retain a negative CDN cache entry.
  const metadata = await request(`${registry}/${pkg.name}?t=${Date.now()}&cache=0`, { headers: { 'Cache-Control': 'no-cache' } })
  if (!metadata.ok) return false
  const document = await metadata.json()
  if (document['dist-tags']?.latest !== pkg.version) return false
  const published = document.versions?.[pkg.version]
  if (!published) return false
  assert.equal(published.name, pkg.name)
  assert.equal(published.version, pkg.version)
  // Version metadata may still reference npmjs: fetch the same path through
  // the requested registry to verify what its own download service delivers.
  const tarball = await request(registry + new URL(published.dist.tarball).pathname)
  if (!tarball.ok) return false
  if (registry === mirror) assert.match(new URL(tarball.url).hostname, /(^|\.)npmmirror\.com$/, 'mirror must serve its own archive')
  const actual = Buffer.from(await tarball.arrayBuffer())
  assert.equal(published.dist.integrity, expected, `${registry}: metadata integrity differs`)
  assert.equal('sha512-' + createHash('sha512').update(actual).digest('base64'), expected, `${registry}: archive differs`)
  console.log(`${registry}: ${pkg.name}@${pkg.version}, ${actual.length} bytes, integrity matched; download host ${new URL(tarball.url).hostname}`)
  return { registry, version: pkg.version, bytes: actual.length, integrity: expected, downloadHost: new URL(tarball.url).hostname }
}

// npm can accept a publish before processing exposes the version. Synchronize
// only after its official archive is available, otherwise the mirror may cache
// the previous release for the whole verification window.
let sync
async function syncMirror() {
  // Request only this package, not its dependency tree.
  try {
    const response = await request(`${mirror}/-/package/${encodeURIComponent(pkg.name)}/syncs`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skipDependencies: true, syncDownloadData: false }),
    })
    sync = { status: response.status }
    console.log(`Mirror sync requested: HTTP ${response.status}`)
  } catch (error) { console.log(`Mirror sync request unavailable: ${error.message}; checking published version`) }
}

const results = new Map()
for (let attempt = 0; attempt < 60; attempt++) {
  for (const registry of [official, mirror]) {
    if (results.has(registry) || (registry === mirror && !results.has(official))) continue
    try {
      const result = await verify(registry)
      if (result) {
        results.set(registry, result)
        if (registry === official) await syncMirror()
      }
    } catch (error) {
      if (error.code === 'ERR_ASSERTION') throw error
      console.log(`${registry}: ${error.message}; waiting for availability`)
    }
  }
  if (results.size === 2) break
  console.log('Waiting for npm/mirror availability…')
  await new Promise(resolve => setTimeout(resolve, 10000))
}
assert.equal(results.size, 2, 'npm and mirror must both serve the verified archive')
await writeFile(archive + '.registries.json', JSON.stringify({ sync, registries: [...results.values()] }, null, 2))
