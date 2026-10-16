import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { createHash } from 'node:crypto'
import type { Client, SFTPWrapper } from 'ssh2'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { DEFAULTS, type PoolEngine } from '../src/engine/connection-pool.ts'
import { upload } from '../src/engine/sftp.ts'
import { SshEngine } from '../src/engine.ts'
import { HostStore } from '../src/store.ts'
import { TestSshd } from './helpers/sshd.ts'

const directory = mkdtempSync(join(tmpdir(), 'dsh-sftp-cancel-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
afterEach(() => { for (const name of ['source', 'nested']) rmSync(join(directory, name), { recursive: true, force: true }) })
function fixture() {
  let ack: (error: Error | undefined, channel: SFTPWrapper) => void
  const client = Object.assign(new EventEmitter(), { sftp: vi.fn((_callback: typeof ack) => { ack = _callback }), end: vi.fn() })
  const record = { client: client as unknown as Client, hops: [], idleAt: Date.now(), pinned: false, broken: false, inFlight: 0 }
  const engine = { opts: DEFAULTS, pool: new Map([['fixture', record]]) } as unknown as PoolEngine
  let done: (error?: Error) => void
  const channel = Object.assign(new EventEmitter(), {
    end: vi.fn(() => channel.emit('close')),
    stat: vi.fn((_path, callback) => callback(undefined, {})),
    fastPut: vi.fn((_src, _dst, _options, callback) => { done = callback }),
  })
  return { client, engine, record, channel, acknowledge: () => ack(undefined, channel as unknown as SFTPWrapper), complete: () => done() }
}

it('stops while the SFTP acknowledgement is missing and closes the late channel once', async () => {
  const f = fixture(), controller = new AbortController(), path = join(directory, 'source')
  writeFileSync(path, 'source')
  const pending = upload(f.engine, 'fixture', path, '/remote/a', false, undefined, controller.signal)
  controller.abort()
  await expect(pending).rejects.toThrow('outcome unknown')
  expect(f.record.inFlight).toBe(0)
  f.acknowledge()
  expect(f.channel.end).toHaveBeenCalledOnce()
  expect(f.channel.fastPut).not.toHaveBeenCalled()
  expect(f.client.end).not.toHaveBeenCalled()
  expect(f.client.listenerCount('close')).toBe(0)
})

it('does not dispatch the next file or emit completion after cancelling recursive upload', async () => {
  const f = fixture(), controller = new AbortController(), progress = vi.fn(), path = join(directory, 'nested')
  mkdirSync(path); writeFileSync(join(path, 'a'), 'a'); writeFileSync(join(path, 'b'), 'b')
  const pending = upload(f.engine, 'fixture', path, '/remote/tree', true, progress, controller.signal)
  f.acknowledge()
  await vi.waitFor(() => expect(f.channel.fastPut).toHaveBeenCalledOnce())
  controller.abort()
  await expect(pending).rejects.toThrow('not retried')
  f.complete()
  await Promise.resolve()
  expect(f.channel.fastPut).toHaveBeenCalledOnce()
  expect(progress.mock.calls.some(([value]) => value.phase === 'done')).toBe(false)
  expect(f.channel.end).toHaveBeenCalledOnce()
  expect(f.client.end).not.toHaveBeenCalled()
})

it.skipIf(!existsSync('/usr/sbin/sshd'))('cancels real upload and download, streams complete bytes, and keeps pooled SSH usable', async () => {
  const sshd = await TestSshd.start(), store = new HostStore(join(directory, 'hosts.json'))
  store.create({ alias: 'real', host: '127.0.0.1', port: sshd.port, user: process.env.USER!, auth: { kind: 'key', keyPath: sshd.clientKey } })
  const engine = new SshEngine(store, { sftpConcurrency: 1 })
  const payload = Buffer.alloc(4 * 1024 * 1024, 0x7b), src = join(sshd.root, 'source.bin'), dst = join(sshd.root, 'upload.bin')
  const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex')
  writeFileSync(src, payload)
  try {
    const up = new AbortController(), upProgress = vi.fn(value => { if (value.transferred > 0) up.abort() })
    await expect(engine.upload('real', src, dst, false, upProgress, up.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(upProgress.mock.calls.some(([value]) => value.phase === 'done')).toBe(false)
    expect((await engine.exec('real', 'printf ALIVE')).stdout).toBe('ALIVE')
    expect(hash(readFileSync(dst))).not.toBe(hash(payload))
    const down = new AbortController(), local = join(sshd.root, 'partial.bin')
    await expect(engine.download('real', src, local, value => { if (value.transferred > 0) down.abort() }, down.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(statSync(local).size).toBeLessThan(payload.length)
    const chunks: Buffer[] = []
    const sink = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback() } })
    expect((await engine.downloadStream('real', src, sink, size => expect(size).toBe(payload.length))).bytes).toBe(payload.length)
    expect(hash(Buffer.concat(chunks))).toBe(hash(payload))
    const abortStream = new AbortController()
    const stopSink = new Writable({ write(_chunk, _encoding, callback) { abortStream.abort(); callback() } })
    await expect(engine.downloadStream('real', src, stopSink, () => {}, abortStream.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect((await engine.exec('real', 'printf STILL_ALIVE')).stdout).toBe('STILL_ALIVE')
    mkdirSync(join(sshd.root, 'tree', 'nested'), { recursive: true })
    writeFileSync(join(sshd.root, 'tree', 'nested', 'file'), 'recursive payload')
    await engine.upload('real', join(sshd.root, 'tree'), join(sshd.root, 'recursive'), true)
    expect(readFileSync(join(sshd.root, 'recursive', 'nested', 'file'), 'utf8')).toBe('recursive payload')
  } finally { engine.dispose(); sshd.stop() }
}, 15000)
