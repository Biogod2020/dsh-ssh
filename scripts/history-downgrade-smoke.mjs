/** Exercise the actual packaged offline exporter and its v1 reader. An optional
 * old DSH consumer runs in a private generated Home, without SSH/model requests. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, open, readFile, readdir, lstat, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const run = promisify(execFile), archive = process.argv[2], output = process.argv[3], legacyDsh = process.argv[4], legacyArchive = process.argv[5]
assert(archive && isAbsolute(archive), 'usage: node --experimental-transform-types scripts/history-downgrade-smoke.mjs ABSOLUTE_ARCHIVE [REPORT_JSON] [ABSOLUTE_DSH ABSOLUTE_LEGACY_ARCHIVE]')
if (legacyDsh || legacyArchive) assert(legacyDsh && legacyArchive && isAbsolute(legacyDsh) && isAbsolute(legacyArchive), 'Supply both legacy consumer paths')
const root = await mkdtemp(join(tmpdir(), 'dsh-downgrade-archive-')), extracted = join(root, 'archive'), source = join(root, 'history'), target = join(root, 'export')
await mkdir(extracted, { mode: 0o700 }); await mkdir(source, { mode: 0o700 })
const members = ['package/package.json', 'package/scripts/export-history-v1.mjs', 'package/src/remote/history-store.ts',
  'package/src/remote/history-cache.ts', 'package/src/remote/history-storage-audit.ts']
const names = (await run('tar', ['-tzf', archive], { maxBuffer: 8 * 1024 * 1024 })).stdout.trim().split('\n')
assert(names.every(name => name.startsWith('package/') && !name.split('/').includes('..')))
for (const member of members) assert(names.includes(member), 'Missing packaged exporter dependency: ' + member)
await run('tar', ['-xzf', archive, '-C', extracted, ...members])
const packageRoot = join(extracted, 'package'), cli = join(packageRoot, 'scripts/export-history-v1.mjs')
const { SegmentedHistoryCache } = await import(pathToFileURL(join(packageRoot, 'src/remote/history-store.ts')).href)
const { RemoteHistoryCache, historyKey } = await import(pathToFileURL(join(packageRoot, 'src/remote/history-cache.ts')).href)
const key = historyKey('generated-host-a', 'project', 'same-session'), cleared = historyKey('generated-host-b', 'project', 'same-session')
const records = Array.from({ length: 600 }, (_, seq) => ({ type: 'event', event: { seq, type: seq === 7 ? 'tool/result' : 'user/message',
  data: { content: seq === 7 ? 'Generated large output '.repeat(100000) : 'Generated 中英文 retained event ' + seq } } }))
const meta = { key, hostId: 'generated-host-a', workspaceId: 'project', sessionId: 'same-session', alias: 'fixture-a', remotePath: '/generated/a',
  title: 'Generated retained history', savedAt: Date.now(), remoteUpdatedAt: 1, cursor: records.length - 1, complete: true }
const hash = value => createHash('sha256').update(value).digest('hex')
async function snapshot(directory) {
  const result = {}
  for (const name of await readdir(directory, { recursive: true })) {
    const path = join(directory, name), info = await lstat(path)
    // Writer lease metadata may change during a verified offline export.
    if (info.isFile() && !/(?:^|\/)(?:control\.json|writer\.lock|recovery\.lock|owner-[^/]+\.tmp)$/.test(name)) result[name] = hash(await readFile(path))
  }
  return result
}
async function controlData() {
  const { writerEpoch: _leaseIdentity, ...data } = JSON.parse(await readFile(join(source, 'v2/control.json'), 'utf8'))
  return data
}
async function noRetainedLocks() {
  for (const name of ['writer.lock', 'recovery.lock']) await assert.rejects(lstat(join(source, 'v2', name)), { code: 'ENOENT' })
}
const environment = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', HOME: root }
const invoke = destination => run(process.execPath, ['--experimental-transform-types', cli, source, destination], {
  env: environment, timeout: 30000, maxBuffer: 1024 * 1024,
})
async function acceptLegacyRuntime(expected) {
  if (!legacyDsh) return false
  assert.equal(hash(await readFile(legacyArchive)), '0aa53cabb1714fbdee68946efa7394b9efabc079c1017de07ce0a5646c26b1ec')
  const home = join(root, 'legacy-home'), dshHome = join(home, '.dsh'), logPath = join(root, 'legacy-server.log')
  await mkdir(home, { mode: 0o700 })
  const env = { PATH: process.env.PATH, USER: process.env.USER, LOGNAME: process.env.USER, LANG: 'en_US.UTF-8', SHELL: '/bin/sh', HOME: home, DSH_HOME: dshHome }
  await run(legacyDsh, ['plugin', '--profile', 'web', 'add', legacyArchive, '--ignore-scripts'], { env, cwd: home, timeout: 60000 })
  await writeFile(join(dshHome, 'profiles/web/cordis.patch.yml'), '- id: product-analytics\n  disabled: true\n- id: desktop-product-telemetry\n  disabled: true\n', { mode: 0o600 })
  await mkdir(join(dshHome, 'remote-workspaces'), { recursive: true, mode: 0o700 })
  await cp(target, join(dshHome, 'remote-workspaces/history'), { recursive: true, errorOnExist: true, force: false })
  const log = await open(logPath, 'wx', 0o600), child = spawn(legacyDsh, ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'], { env, cwd: home, stdio: ['ignore', log.fd, log.fd] })
  await log.close()
  let spawnError; child.once('error', error => spawnError = error)
  try {
    let login
    for (let n = 0; n < 300; n++) {
      if (spawnError) throw spawnError
      assert.equal(child.exitCode, null, 'Legacy runtime exited before startup')
      assert.equal(child.signalCode, null, 'Legacy runtime was interrupted before startup')
      const match = (await readFile(logPath, 'utf8')).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]
      if (match) { login = new URL(match); break }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert(login, 'Legacy runtime startup did not settle')
    const auth = await fetch(login, { redirect: 'manual', signal: AbortSignal.timeout(10000) }); await auth.body?.cancel(); assert.equal(auth.status, 303)
    const headers = { Cookie: auth.headers.getSetCookie().map(line => line.split(';')[0]).join('; '), Origin: login.origin }
    const get = async path => {
      const response = await fetch(login.origin + '/api/dsh-ssh/' + path, { headers, signal: AbortSignal.timeout(10000) })
      assert.equal(response.status, 200, 'Legacy API read failed'); return response.json()
    }
    const summary = await get('remote/history')
    assert.equal(summary.entries.length, 1); assert.equal(summary.entries[0].key, key)
    assert.deepEqual((await get('remote/history/read?key=' + key)).copy, expected)
    assert.equal((await get('remote/history/read?key=' + cleared)).copy, undefined)
    assert.deepEqual((await get('connections')).connections, [])
    return true
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) await new Promise((resolve, reject) => {
      const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 5000)
      const deadline = setTimeout(() => { clearTimeout(kill); child.unref(); reject(new Error('Legacy test process termination could not be confirmed')) }, 10000)
      child.once('exit', () => { clearTimeout(kill); clearTimeout(deadline); resolve() }); child.kill('SIGTERM')
    })
  }
}
let cache, holder
try {
  const legacy = new RemoteHistoryCache(source); await legacy.list()
  await legacy.save(meta, records, legacy.token())
  await legacy.save({ ...meta, key: cleared, hostId: 'generated-host-b', alias: 'fixture-b', remotePath: '/generated/b' }, records, legacy.token())
  const original = await legacy.read(key), clearedOriginal = await legacy.read(cleared)
  cache = new SegmentedHistoryCache(source); await cache.prepare(key, cache.token(key)); await cache.prepare(cleared, cache.token(cleared))
  const increment = [600, 601, 602].map(seq => ({ type: 'event', event: { seq, type: 'assistant/message', data: { content: 'Generated after migration ' + seq } } }))
  await cache.append({ ...meta, cursor: 602, title: 'Updated after migration', remoteUpdatedAt: 2 }, increment, cache.token(key))
  const expected = await cache.read(key)
  assert.equal(expected.meta.firstSavedAt, original.meta.firstSavedAt)
  await cache.clear([cleared]); await cache.close(); cache = undefined
  // Old bytes deliberately remain in the disposable source to prove that a
  // downgrade is governed by current barriers, never migration backups.
  await writeFile(join(source, cleared + '.json'), JSON.stringify(clearedOriginal), { mode: 0o600 })
  await mkdir(join(source, 'v2', cleared), { mode: 0o700 })
  await writeFile(join(source, 'v2', cleared, 'legacy.v1.json'), JSON.stringify(clearedOriginal), { mode: 0o600 })
  holder = new SegmentedHistoryCache(source); await holder.prepare(key, holder.token(key))
  const before = await snapshot(source), controlBefore = await controlData(), barriers = controlBefore.fences, refusedTarget = join(root, 'refused-export')
  const heldLock = await readFile(join(source, 'v2/writer.lock'))
  let refused = false
  try { await invoke(refusedTarget) } catch (error) { assert.notEqual(error.code, 0); assert.match(error.stderr, /Another history writer is active/); refused = true }
  assert(refused, 'An exporter must refuse a live source writer')
  await assert.rejects(lstat(refusedTarget), { code: 'ENOENT' })
  assert.deepEqual(await snapshot(source), before)
  assert.deepEqual(await readFile(join(source, 'v2/writer.lock')), heldLock, 'Refusal must preserve the active writer lease')
  assert.deepEqual(await controlData(), controlBefore)
  await holder.close(); holder = undefined
  await noRetainedLocks()
  const exported = await invoke(target), result = JSON.parse(exported.stdout.trim())
  assert.deepEqual(result, { verified: true, sessions: 1, records: 603, historyRecordsUnchanged: true, automaticRestore: false })
  const reader = new RemoteHistoryCache(target), status = await reader.list(), restored = await reader.read(key)
  assert.equal(status.warning, undefined); assert.equal(status.entries.length, 1); assert(restored)
  assert.deepEqual(restored.records, [...records, ...increment])
  assert.deepEqual(restored.meta, { ...expected.meta, bytes: restored.meta.bytes })
  assert.equal(await reader.read(cleared), undefined)
  assert(!(await readdir(target)).includes(cleared + '.json'))
  assert.deepEqual(await snapshot(source), before, 'Export must preserve all source history, including retained disabled bytes')
  const targetBefore = await snapshot(target)
  refused = false
  try { await invoke(target) } catch (error) { assert.notEqual(error.code, 0); assert.match(error.stderr, /already exists/); refused = true }
  assert(refused, 'An existing export must never be overwritten')
  assert.deepEqual(await snapshot(target), targetBefore)
  assert.deepEqual(await snapshot(source), before)
  const control = JSON.parse(await readFile(join(source, 'v2/control.json'), 'utf8'))
  assert.equal(control.fences[cleared].enabled, false)
  assert.deepEqual(control.fences, barriers)
  assert.deepEqual(await controlData(), controlBefore, 'Only the verified writer lease identity may change')
  await noRetainedLocks()
  const legacyRuntimeRead = await acceptLegacyRuntime(restored)
  const report = { passed: true, archiveSha256: hash(await readFile(archive)), exporterSha256: hash(await readFile(cli)),
    packagedExporter: true, retainedSessions: 1, retainedEvents: 603, appendedEvents: 3, firstSavedAtPreserved: true,
    allOtherMetadataPreserved: true, sourceHistoryFilesUnchanged: true, clearedArchivesNotRevived: true, perSessionBarriersUnchanged: true,
    activeWriterRefused: true, existingTargetNotOverwritten: true, sourceControlDataUnchanged: true, exporterLocksReleased: true,
    automaticRestore: false, modelRequests: 0,
    legacyRuntimeRead, ...(legacyRuntimeRead ? { legacyPluginVersion: '0.3.24-jay.39' } : {}) }
  if (output) await writeFile(resolve(output), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(report))
} finally { await holder?.close(); await cache?.close(); await rm(root, { recursive: true, force: true }) }
