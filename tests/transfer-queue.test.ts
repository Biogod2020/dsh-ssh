// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SshApi, prepareDownload } from '../src/client/api.ts'
import { TransferQueue } from '../src/client/transfer-queue.ts'
import type { SshHostSummary } from '../src/protocol.ts'
import { decodeTransferHistory, TRANSFER_HISTORY_BYTES, type TransferHistory } from '../src/client/transfer-history.ts'

const host: SshHostSummary = { alias: 'fixture', host: '127.0.0.1', port: 22, user: 'test', auth: 'key', keyReady: true, proxyJump: [], tags: [], createdAt: 12, updatedAt: 12 }
const files = () => ['first.txt', 'second.txt', 'third.txt'].map(name => new File(['data'], name))
function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
beforeEach(() => { document.documentElement.lang = 'en' })
afterEach(() => { vi.unstubAllGlobals(); document.documentElement.removeAttribute('lang') })

it('dispatches sequentially with frozen target/version and skips a cancelled queued file', async () => {
  const api = new SshApi(), first = deferred<{ transferredBytes: number }>(), queue = new TransferQueue(api), target = { ...host }
  const upload = vi.spyOn(api, 'uploadFile').mockReturnValueOnce(first.promise).mockResolvedValue({ transferredBytes: 4 })
  queue.addUploads(target, '/original/', files()); target.alias = 'changed'; target.updatedAt = 99
  expect(upload).toHaveBeenCalledOnce(); expect(upload.mock.calls[0]?.[2]).toBe('/original/first.txt')
  queue.cancel(2); first.resolve({ transferredBytes: 4 })
  await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2))
  expect(upload.mock.calls[1]?.[1]).toBe('fixture'); expect(upload.mock.calls[1]?.[2]).toBe('/original/third.txt'); expect(upload.mock.calls[1]?.[5]).toBe(12)
  await vi.waitFor(() => expect(queue.snapshot().activeId).toBeUndefined())
  expect(queue.snapshot().jobs[1]).toMatchObject({ phase: 'cancelled', dispatched: false })
})

it('stops the current job, rejects late success, pauses remaining jobs and resumes only never-started files', async () => {
  const api = new SshApi(), first = deferred<{ transferredBytes: number }>(), queue = new TransferQueue(api)
  const upload = vi.spyOn(api, 'uploadFile').mockReturnValueOnce(first.promise).mockResolvedValue({ transferredBytes: 4 })
  queue.addUploads(host, '/remote/', files()); queue.cancel(1)
  expect(upload.mock.calls[0]?.[4]?.aborted).toBe(true); expect(queue.snapshot().paused).toBe(true)
  upload.mock.calls[0]?.[3]?.({ phase: 'done', file: 'late', total: 4, transferred: 4, percent: 100 })
  first.resolve({ transferredBytes: 4 })
  await vi.waitFor(() => expect(queue.snapshot().jobs[0]?.phase).toBe('cancelled'))
  expect(upload).toHaveBeenCalledOnce(); queue.resume(); queue.resume()
  await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(3))
  expect(upload.mock.calls.map(call => call[2])).toEqual(['/remote/first.txt', '/remote/second.txt', '/remote/third.txt'])
})

it('pauses after failure and Stop all cancels every remaining job without dispatch', async () => {
  const api = new SshApi(), queue = new TransferQueue(api)
  const upload = vi.spyOn(api, 'uploadFile').mockRejectedValue(new Error('connection lost; outcome unknown'))
  queue.addUploads(host, '/remote/', files())
  await vi.waitFor(() => expect(queue.snapshot().paused).toBe(true))
  expect(upload).toHaveBeenCalledOnce(); expect(queue.snapshot().jobs[0]?.phase).toBe('error')
  queue.stopAll(); queue.resume()
  expect(upload).toHaveBeenCalledOnce(); expect(queue.snapshot().jobs.slice(1).every(job => job.phase === 'cancelled' && job.dispatched === false)).toBe(true)
})

it('pauses after the current file and preserves queued jobs until explicit resume', async () => {
  const api = new SshApi(), first = deferred<{ transferredBytes: number }>(), queue = new TransferQueue(api)
  const upload = vi.spyOn(api, 'uploadFile').mockReturnValueOnce(first.promise).mockResolvedValue({ transferredBytes: 4 })
  queue.addUploads(host, '/remote/', files()); queue.pause(); first.resolve({ transferredBytes: 4 })
  await vi.waitFor(() => expect(queue.snapshot().activeId).toBeUndefined())
  expect(upload).toHaveBeenCalledOnce(); expect(queue.snapshot().jobs[1]?.phase).toBe('queued')
  queue.resume(); await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(3))
})

it('rejects duplicate destinations and a multiple-file non-directory target before sending anything', () => {
  const api = new SshApi(), queue = new TransferQueue(api), upload = vi.spyOn(api, 'uploadFile')
  expect(() => queue.addUploads(host, '/single.txt', files())).toThrow()
  expect(() => queue.addUploads(host, '/remote/', [new File(['1'], 'same'), new File(['2'], 'same')])).toThrow()
  expect(upload).not.toHaveBeenCalled(); expect(queue.snapshot().jobs).toHaveLength(0)
})

it('selects native destinations during enqueue and opens no file or network until the job starts', async () => {
  const api = new SshApi(), queue = new TransferQueue(api), writer = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) }
  const createWritable = vi.fn(async () => writer), picker = vi.fn(async () => ({ createWritable }))
  vi.stubGlobal('window', { showSaveFilePicker: picker }); const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('test', { headers: { 'content-length': '4' } })); vi.stubGlobal('fetch', fetch)
  queue.pause(); const preparation = prepareDownload('/file.txt', 'picker')
  expect(picker).toHaveBeenCalledOnce(); expect(createWritable).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  queue.addDownload(host, '/file.txt', 'picker', await preparation)
  expect(createWritable).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); queue.resume()
  await vi.waitFor(() => expect(queue.snapshot().jobs[0]?.phase).toBe('done'))
  expect(picker).toHaveBeenCalledOnce(); expect(createWritable).toHaveBeenCalledOnce(); expect(writer.close).toHaveBeenCalledOnce()
  expect(String(fetch.mock.calls[0]?.[0])).toContain('expectedUpdatedAt=12')
})

it('checkpoints saving as unfinished and restores its local filename without replaying disk or network writes', async () => {
  const api = new SshApi(), close = deferred<void>(); let raw: string | null = null
  const history: TransferHistory = { read: () => raw, write: value => { raw = value }, clear: () => { raw = null } }
  const writer = { write: vi.fn(async () => {}), close: vi.fn(() => close.promise), abort: vi.fn(async () => {}) }
  const createWritable = vi.fn(async () => writer), fetch = vi.fn(async () => new Response('test', { headers: { 'content-length': '4' } }))
  vi.stubGlobal('fetch', fetch)
  const queue = new TransferQueue(api, history)
  queue.addDownload(host, '/original.txt', 'picker', { filename: 'chosen-恢复.txt', createWritable })
  await vi.waitFor(() => expect(queue.snapshot().jobs[0]?.phase).toBe('saving'))
  expect(decodeTransferHistory(raw!).jobs[0]).toMatchObject({ phase: 'saving', localName: 'chosen-恢复.txt' })
  const recovered = new TransferQueue(api, history); recovered.resume()
  expect(recovered.snapshot().jobs[0]).toMatchObject({ phase: 'interrupted', localName: 'chosen-恢复.txt' })
  expect(fetch).toHaveBeenCalledOnce(); expect(createWritable).toHaveBeenCalledOnce()
  close.resolve(); await vi.waitFor(() => expect(queue.snapshot().jobs[0]?.phase).toBe('done'))
})

it('replaces the previous local filename when a waiting download is prepared again and rejects invalid saved metadata', async () => {
  const api = new SshApi(); let raw: string | null = null
  const history: TransferHistory = { read: () => raw, write: value => { raw = value }, clear: () => { raw = null } }
  const queue = new TransferQueue(api, history); queue.pause()
  queue.addDownload(host, '/original.txt', 'picker', { filename: 'old-name.txt' })
  const restored = new TransferQueue(api, history)
  expect(restored.snapshot().jobs[0]).toMatchObject({ phase: 'awaitingSave', localName: 'old-name.txt' })
  restored.restoreDownload(1, { filename: 'new-name.txt' })
  expect(decodeTransferHistory(raw!).jobs[0]).toMatchObject({ phase: 'queued', localName: 'new-name.txt' })
  for (const patch of [{ localName: '/absolute/path' }, { localName: 'a\nb' }, { phase: 'saving', saveMode: 'browser' }]) {
    const changed = JSON.parse(raw!); Object.assign(changed.jobs[0], patch)
    expect(() => decodeTransferHistory(JSON.stringify(changed))).toThrow('Invalid transfer recovery record')
  }
})

it('unmount cancels queued work and ignores late completion, including a later reattach', async () => {
  const api = new SshApi(), first = deferred<{ transferredBytes: number }>(), queue = new TransferQueue(api)
  const upload = vi.spyOn(api, 'uploadFile').mockReturnValue(first.promise)
  queue.addUploads(host, '/remote/', files()); queue.detach(); queue.attach(); queue.resume(); first.resolve({ transferredBytes: 4 })
  await first.promise; expect(upload).toHaveBeenCalledOnce()
  expect(queue.snapshot().jobs.every(job => job.phase === 'cancelled')).toBe(true)
})

it('retains 30 completed records while clear history never removes pending transfers', async () => {
  const api = new SshApi(), queue = new TransferQueue(api), upload = vi.spyOn(api, 'uploadFile').mockResolvedValue({ transferredBytes: 4 })
  queue.addUploads(host, '/remote/', Array.from({ length: 40 }, (_, i) => new File(['data'], i + '.txt')))
  await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(40))
  expect(queue.snapshot().jobs).toHaveLength(30)
  queue.pause(); queue.addUploads(host, '/remote/', [new File(['test'], 'pending.txt')]); queue.clearFinished()
  expect(queue.snapshot().jobs).toHaveLength(1); expect(queue.snapshot().jobs[0]?.phase).toBe('queued')
})

function history(initial: string | null = null) {
  let raw = initial
  return { read: vi.fn(() => raw), write: vi.fn((value: string) => { raw = value }), clear: vi.fn(() => { raw = null }),
    get raw() { return raw }, set raw(value: string | null) { raw = value } } satisfies TransferHistory & { raw: string | null }
}
it('recovers an interrupted upload and pending files without replay, then runs only explicitly rebound jobs', async () => {
  const store = history(), api = new SshApi(), first = deferred<{ transferredBytes: number }>(), original = new TransferQueue(api, store), selected = files()
  const upload = vi.spyOn(api, 'uploadFile').mockReturnValueOnce(first.promise).mockResolvedValue({ transferredBytes: 4 })
  original.addUploads(host, '/frozen/', selected)
  upload.mock.calls[0]?.[3]?.({ phase: 'transferring', transferred: 2, total: 4, percent: 50, file: 'first.txt' })
  const recovered = new TransferQueue(api, store)
  expect(recovered.snapshot()).toMatchObject({ paused: true, restored: true, jobs: [{ phase: 'interrupted', transferred: 2, dispatched: true }, { phase: 'awaitingFile' }, { phase: 'awaitingFile' }] })
  original.detach(); first.resolve({ transferredBytes: 4 }); await first.promise
  recovered.resume(); expect(upload).toHaveBeenCalledOnce()
  recovered.restoreUploads(selected.slice(1)); expect(upload).toHaveBeenCalledOnce()
  recovered.resume(); await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(3))
  expect(upload.mock.calls.map(call => call[2])).toEqual(['/frozen/first.txt', '/frozen/second.txt', '/frozen/third.txt'])
  expect(upload.mock.calls.slice(1).every(call => call[1] === host.alias && call[5] === host.updatedAt)).toBe(true)
  expect(recovered.snapshot().jobs[0]?.phase).toBe('interrupted')
})
it('does not skip an earlier unprepared job or accept changed files, and binds selections atomically', async () => {
  const store = history(), api = new SshApi(), original = new TransferQueue(api, store), selected = files()
  original.pause(); original.addUploads(host, '/frozen/', selected); original.detach()
  const recovered = new TransferQueue(api, store), upload = vi.spyOn(api, 'uploadFile').mockResolvedValue({ transferredBytes: 4 })
  const wrong = new File(['changed bytes'], selected[1]!.name, { lastModified: selected[1]!.lastModified })
  expect(() => recovered.restoreUploads([selected[0]!, wrong])).toThrow('does not match')
  expect(recovered.snapshot().jobs.every(job => job.phase === 'awaitingFile')).toBe(true)
  const changedTime = new File(['data'], selected[0]!.name, { lastModified: selected[0]!.lastModified + 1 })
  expect(() => recovered.restoreUploads([changedTime])).toThrow('does not match')
  recovered.restoreUploads([selected[2]!]); recovered.resume(); expect(upload).not.toHaveBeenCalled()
  expect(recovered.snapshot().paused).toBe(true)
  recovered.restoreUploads(selected.slice(0, 2)); recovered.resume()
  await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(3))
  expect(upload.mock.calls.map(call => call[0].name)).toEqual(selected.map(file => file.name))
})
it('persists the active checkpoint before dispatch and blocks network when that checkpoint cannot be saved', async () => {
  const store = history(), api = new SshApi(), queue = new TransferQueue(api, store), upload = vi.spyOn(api, 'uploadFile').mockResolvedValue({ transferredBytes: 4 })
  const save = store.write.getMockImplementation()!
  store.write.mockImplementationOnce(save).mockImplementationOnce(() => { throw new Error('Quota exceeded') })
  queue.addUploads(host, '/frozen/', files().slice(0, 1))
  expect(upload).not.toHaveBeenCalled(); expect(queue.snapshot()).toMatchObject({ paused: true, historyIssue: 'write', jobs: [{ phase: 'queued' }] })
  queue.resume(); expect(upload).not.toHaveBeenCalled()
  expect(decodeTransferHistory(store.raw!).jobs[0]?.phase).toBe('queued')
  queue.retryHistory(); expect(upload).not.toHaveBeenCalled(); queue.resume()
  await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce())
  const checkpoints = store.write.mock.calls.map(call => JSON.parse(call[0]).jobs[0]?.phase)
  expect(checkpoints).toContain('staging')
})
it('keeps a current transfer running on record failure, pauses later files and requires deliberate resume', async () => {
  const store = history(), api = new SshApi(), first = deferred<{ transferredBytes: number }>(), queue = new TransferQueue(api, store)
  const upload = vi.spyOn(api, 'uploadFile').mockReturnValueOnce(first.promise).mockResolvedValue({ transferredBytes: 4 })
  queue.addUploads(host, '/frozen/', files())
  const save = store.write.getMockImplementation()!; store.write.mockImplementation(() => { throw new Error('Storage full') })
  upload.mock.calls[0]?.[3]?.({ phase: 'transferring', transferred: 1, total: 4, percent: 25, file: 'first.txt' })
  expect(upload.mock.calls[0]?.[4]?.aborted).toBe(false); expect(queue.snapshot().historyIssue).toBe('write')
  first.resolve({ transferredBytes: 4 }); await vi.waitFor(() => expect(queue.snapshot().activeId).toBeUndefined())
  expect(queue.snapshot().jobs[0]?.phase).toBe('done'); expect(upload).toHaveBeenCalledOnce()
  expect(new TransferQueue(api, store).snapshot().jobs[0]?.phase).toBe('interrupted')
  store.write.mockImplementation(save); queue.retryHistory(); expect(upload).toHaveBeenCalledOnce()
  queue.resume(); await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(3))
})
it('recovers pending downloads without retaining a writable handle or opening a stream', async () => {
  const store = history(), api = new SshApi(), original = new TransferQueue(api, store), oldWriter = vi.fn()
  const download = vi.spyOn(api, 'downloadFile').mockResolvedValue({ streamed: true, bytes: 4, filename: 'file.txt' })
  original.pause(); original.addDownload(host, '/frozen/file.txt', 'picker', { createWritable: oldWriter }); original.detach()
  expect(store.raw).not.toContain('createWritable')
  const recovered = new TransferQueue(api, store)
  recovered.resume(); expect(download).not.toHaveBeenCalled(); expect(oldWriter).not.toHaveBeenCalled()
  const destination = { createWritable: vi.fn() }; recovered.restoreDownload(1, destination)
  expect(download).not.toHaveBeenCalled(); recovered.resume(); await vi.waitFor(() => expect(download).toHaveBeenCalledOnce())
  expect(download.mock.calls[0]?.slice(0, 2)).toEqual([host.alias, '/frozen/file.txt'])
  expect(download.mock.calls[0]?.slice(4)).toEqual(['picker', destination, host.updatedAt])
  expect(oldWriter).not.toHaveBeenCalled()
})
it('stores only bounded receipt metadata and restores finished records without network requests', async () => {
  const store = history(), api = new SshApi(), original = new TransferQueue(api, store)
  const upload = vi.spyOn(api, 'uploadFile').mockResolvedValue({ transferredBytes: 15 })
  original.addUploads({ ...host, auth: 'password', proxyCommand: 'private-command' }, '/frozen/', [new File(['private-content'], 'receipt.txt')])
  await vi.waitFor(() => expect(original.snapshot().activeId).toBeUndefined())
  expect(store.raw).not.toContain('private-content'); expect(store.raw).not.toContain('private-command'); expect(store.raw).not.toContain('payloads')
  const recovered = new TransferQueue(api, store); recovered.resume()
  expect(recovered.snapshot().jobs[0]).toMatchObject({ phase: 'done', transferred: 15, path: '/frozen/receipt.txt' })
  expect(upload).toHaveBeenCalledOnce()
})
it.each([{ label: 'empty record', raw: '' }, { label: 'invalid JSON', raw: '{broken' }, { label: 'unknown version', raw: JSON.stringify({ version: 99, jobs: [], sequence: 0 }) }, { label: 'oversized', raw: 'x'.repeat(TRANSFER_HISTORY_BYTES + 1) }])('preserves $label records and blocks new work until a deliberate repair', ({ raw }) => {
  const store = history(raw), api = new SshApi(), queue = new TransferQueue(api, store), upload = vi.spyOn(api, 'uploadFile')
  expect(queue.snapshot().historyIssue).toBe('read'); expect(() => queue.addUploads(host, '/frozen/', files())).toThrow('Recovery records unavailable')
  queue.resume(); queue.detach(); expect(store.raw).toBe(raw); expect(store.write).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled()
  store.raw = null; queue.retryHistory(); expect(queue.snapshot().historyIssue).toBeUndefined()
  expect(upload).not.toHaveBeenCalled()
})
it('bounds 100 pending jobs and progress checkpoints without dropping visible progress', async () => {
  const store = history(), api = new SshApi(), first = deferred<{ transferredBytes: number }>(), queue = new TransferQueue(api, store)
  const upload = vi.spyOn(api, 'uploadFile').mockReturnValue(first.promise)
  queue.addUploads(host, '/frozen/', Array.from({ length: 100 }, (_, index) => new File(['data'], `${index}.txt`)))
  expect(() => queue.addUploads(host, '/frozen/', [new File(['test'], 'overflow.txt')])).toThrow('100 pending')
  const writes = store.write.mock.calls.length
  for (let index = 1; index <= 1000; index++) upload.mock.calls[0]?.[3]?.({ phase: 'transferring', transferred: index, total: 1000, percent: index / 10, file: '0.txt' })
  expect(store.write.mock.calls.length - writes).toBeLessThanOrEqual(2)
  expect(queue.snapshot().jobs[0]).toMatchObject({ transferred: 1000, percent: 100 })
  queue.detach(); expect(new TransferQueue(api, store).snapshot().jobs).toHaveLength(100)
  expect(store.raw!.length).toBeLessThan(TRANSFER_HISTORY_BYTES)
  first.resolve({ transferredBytes: 1000 }); await first.promise
})
it('rejects duplicate IDs and invalid targets instead of silently restoring them', () => {
  const store = history(), queue = new TransferQueue(new SshApi(), store); queue.pause(); queue.addUploads(host, '/frozen/', files())
  const saved = JSON.parse(store.raw!), mutations = [
    (value: typeof saved) => { value.jobs[1].id = value.jobs[0].id },
    (value: typeof saved) => { value.jobs[0].path = 'relative' },
    (value: typeof saved) => { value.jobs[0].port = 0 },
    (value: typeof saved) => { delete value.jobs[0].sourceSize },
  ]
  for (const mutate of mutations) { const changed = structuredClone(saved); mutate(changed); expect(() => decodeTransferHistory(JSON.stringify(changed))).toThrow('Invalid') }
})

it('keeps the last readable checkpoint when new result metadata fails validation', async () => {
  const store = history(), api = new SshApi(), queue = new TransferQueue(api, store)
  vi.spyOn(api, 'uploadFile').mockRejectedValue(new Error('x'.repeat(32769)))
  queue.addUploads(host, '/frozen/', files())
  await vi.waitFor(() => expect(queue.snapshot().activeId).toBeUndefined())
  expect(queue.snapshot()).toMatchObject({ paused: true, historyIssue: 'write' })
  expect(queue.snapshot().jobs[0]?.error).toHaveLength(32769)
  expect(() => decodeTransferHistory(store.raw!)).not.toThrow()
  expect(new TransferQueue(api, store).snapshot().jobs[0]?.phase).toBe('interrupted')
})
