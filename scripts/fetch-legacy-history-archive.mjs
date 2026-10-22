import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const destination = process.argv[2]
assert(destination, 'Supply a new destination for the immutable published jay.39 archive')
const sha256 = '0aa53cabb1714fbdee68946efa7394b9efabc079c1017de07ce0a5646c26b1ec'
const verify = bytes => assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, 'Published legacy archive differs from the frozen jay.39 release')
try {
  const existing = await readFile(resolve(destination)); verify(existing)
  console.log(JSON.stringify({ verified: true, cached: true, version: '0.3.24-jay.39', sha256 })); process.exit(0)
} catch (error) { if (error.code !== 'ENOENT') throw error }
const response = await fetch('https://registry.npmjs.org/@biogod/dsh-ssh/-/dsh-ssh-0.3.24-jay.39.tgz', { signal: AbortSignal.timeout(30000), redirect: 'error' })
assert(response.ok, 'Published legacy archive download failed')
const chunks = []; let size = 0
for await (const chunk of response.body) { size += chunk.length; assert(size <= 3 * 1024 * 1024, 'Frozen archive exceeds its download budget'); chunks.push(chunk) }
const archive = Buffer.concat(chunks); verify(archive)
await writeFile(resolve(destination), archive, { mode: 0o600, flag: 'wx' })
console.log(JSON.stringify({ verified: true, cached: false, version: '0.3.24-jay.39', bytes: size, sha256 }))
