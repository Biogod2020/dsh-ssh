/** Verify and pack a source snapshot without replacing a running linked client's lib/. */
import { cp, mkdtemp, symlink, mkdir, readFile, writeFile, unlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const destination = resolve(process.argv[2] ?? project)
const staging = await mkdtemp(join(tmpdir(), 'dsh-ssh-release-'))
const excluded = new Set(['.git', 'node_modules', 'lib', 'coverage'])
await cp(project, staging, { recursive: true, filter: path => {
  const part = path.slice(project.length + 1).split('/')[0]
  return !excluded.has(part) && part !== '.env' && !part.startsWith('.env.') && !/\.(?:tgz|log)$/.test(path)
} })
await symlink(join(project, 'node_modules'), join(staging, 'node_modules'), 'dir')
await mkdir(destination, { recursive: true })
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: staging, stdio: 'inherit' })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} failed (${code}); diagnostics: ${staging}`)))
})
console.log(`Release source snapshot: ${staging}`)
await run('pnpm', ['verify'])
// Symlinked build dependencies can leave a builder's absolute directory in
// region comments and source-map labels. Keep package names and embedded source.
const portablePath = path => {
  const normalized = path.replaceAll('\\', '/')
  const boundary = normalized.lastIndexOf('/node_modules/')
  return boundary < 0 ? path : normalized.slice(boundary + 1)
}
async function portableOutputs(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await portableOutputs(path)
    else if (entry.name.endsWith('.js')) {
      const source = await readFile(path, 'utf8')
      const portable = source.replace(/^([\t ]*\/\/#region )([^\r\n]+)$/gm, (_match, prefix, label) => prefix + portablePath(label))
      if (portable !== source) await writeFile(path, portable)
    } else if (entry.name.endsWith('.map')) {
      const source = JSON.parse(await readFile(path, 'utf8'))
      if (Array.isArray(source.sources)) source.sources = source.sources.map(portablePath)
      await writeFile(path, JSON.stringify(source))
    }
  }
}
await portableOutputs(join(staging, 'lib'))
// Materialize the required pure-JS closure: packing pnpm links can otherwise
// produce paths outside package/. Optional CPU/native crypto bindings are not shipped.
await unlink(join(staging, 'node_modules'))
await mkdir(join(staging, 'node_modules'))
const bundled = new Set()
async function bundle(name, from) {
  if (bundled.has(name)) return
  bundled.add(name)
  const manifest = from.resolve(`${name}/package.json`)
  const source = dirname(manifest)
  await cp(source, join(staging, 'node_modules', name), { recursive: true, dereference: true,
    filter: path => !path.slice(source.length + 1).split('/').some(part => ['node_modules', 'test', 'tests', '.git', '.github'].includes(part)) && !path.endsWith('.node'),
  })
  const pkg = JSON.parse(await readFile(manifest, 'utf8'))
  for (const child of Object.keys(pkg.dependencies ?? {})) await bundle(child, createRequire(manifest))
}
await bundle('ssh2', createRequire(join(project, 'package.json')))
await run('npm', ['pack', '--ignore-scripts', '--pack-destination', destination])
const pkg = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8'))
const archive = join(destination, `${pkg.name.replace(/^@/, '').replaceAll('/', '-')}-${pkg.version}.tgz`)
const { stdout } = await promisify(execFile)('tar', ['-tzf', archive], { maxBuffer: 8 * 1024 * 1024 })
const entries = stdout.trim().split('\n')
assert(entries.every(path => path.startsWith('package/') && !path.split('/').includes('..')), 'archive entries must stay inside package/')
assert(!entries.some(path => path.endsWith('.node')), 'portable SSH bundle must use pure JavaScript')
for (const name of bundled) assert(entries.includes(`package/node_modules/${name}/package.json`), `missing bundled dependency ${name}`)
// The offline exporter imports these shared sources from the archive itself,
// rather than the already-bundled Host entry. Check its root helper as well.
assert(entries.includes('package/src/private-mode.ts'), 'offline history sources require their shared private-mode helper')
const digest = createHash('sha256').update(await readFile(archive)).digest('hex')
await writeFile(`${archive}.sha256`, `${digest}  ${archive.slice(destination.length + 1)}\n`, { mode: 0o600 })
console.log(`Verified ${pkg.name}@${pkg.version}; source lib/ was not replaced. Staging: ${staging}`)
