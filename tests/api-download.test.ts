import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshApi, prepareDownload } from '../src/client/api.ts'

afterEach(() => { vi.unstubAllGlobals() })

const payload = new TextEncoder().encode('download acceptance')
function response(): Response {
  return new Response(payload, { headers: { 'content-length': String(payload.length),
    'content-disposition': 'attachment; filename="evidence.txt"' } })
}
function destination() {
  const writer = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) }
  const picker = vi.fn(async () => ({ createWritable: async () => writer }))
  vi.stubGlobal('window', { showSaveFilePicker: picker })
  return { writer, picker }
}

describe('browser download lifecycle', () => {
  it('opens the save dialog synchronously and commits only after the complete stream', async () => {
    const { writer, picker } = destination()
    const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch)
    const progress = vi.fn()
    const pending = new SshApi().downloadFile('fixture', '/remote/evidence.txt', progress)
    expect(picker).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
    const result = await pending
    expect(result).toEqual({ filename: 'evidence.txt', streamed: true, bytes: payload.length, blob: undefined })
    expect(writer.write).toHaveBeenCalledWith(payload)
    expect(writer.close).toHaveBeenCalledOnce()
    expect(writer.abort).not.toHaveBeenCalled()
    expect(progress.mock.calls.at(-1)?.[0].phase).toBe('done')
  })

  it('never starts the remote transfer after the user cancels the save dialog', async () => {
    vi.stubGlobal('window', { showSaveFilePicker: vi.fn(async () => { throw new DOMException('Cancelled', 'AbortError') }) })
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(new SshApi().downloadFile('fixture', '/remote/evidence.txt')).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('aborts the destination and releases the response when writing fails', async () => {
    const { writer } = destination()
    writer.write.mockRejectedValueOnce(new Error('Disk full'))
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(payload) }, cancel,
    }))))
    const progress = vi.fn()
    await expect(new SshApi().downloadFile('fixture', '/remote/evidence.txt', progress)).rejects.toThrow('Disk full')
    expect(cancel).toHaveBeenCalledOnce()
    expect(writer.abort).toHaveBeenCalledOnce()
    expect(writer.close).not.toHaveBeenCalled()
    expect(progress.mock.calls.some(([value]) => value.phase === 'done')).toBe(false)
  })

  it('does not commit a truncated response or report completion', async () => {
    const { writer } = destination()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(payload, { headers: { 'content-length': '9999' } })))
    const progress = vi.fn()
    await expect(new SshApi().downloadFile('fixture', '/remote/evidence.txt', progress)).rejects.toThrow('all bytes')
    expect(writer.abort).toHaveBeenCalledOnce()
    expect(writer.close).not.toHaveBeenCalled()
    expect(progress.mock.calls.some(([value]) => value.phase === 'done')).toBe(false)
  })

  it('rolls back the destination if the remote endpoint rejects the request', async () => {
    const { writer } = destination()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"not found"}', { status: 404 })))
    await expect(new SshApi().downloadFile('fixture', '/remote/evidence.txt')).rejects.toThrow('not found')
    expect(writer.abort).toHaveBeenCalledOnce()
    expect(writer.close).not.toHaveBeenCalled()
  })

  it('returns a complete Blob when a save picker is unavailable', async () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('fetch', vi.fn(async () => response()))
    const result = await new SshApi().downloadFile('fixture', '/remote/evidence.txt')
    expect(result.streamed).toBe(false)
    expect(await result.blob?.text()).toBe('download acceptance')
  })

  it('cancels a blocked read, aborts saving and never commits a partial file', async () => {
    const { writer } = destination(), controller = new AbortController()
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(stream) { stream.enqueue(payload) }, cancel,
    }), { headers: { 'content-length': '9999' } })))
    const progress = vi.fn()
    const pending = new SshApi().downloadFile('fixture', '/remote/a', progress, controller.signal)
    await vi.waitFor(() => expect(writer.write).toHaveBeenCalled())
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', dispatched: true })
    expect(cancel).toHaveBeenCalled()
    expect(writer.abort).toHaveBeenCalledOnce()
    expect(writer.close).not.toHaveBeenCalled()
    expect(progress.mock.calls.some(([value]) => value.phase === 'done')).toBe(false)
  })

  it('does not open a picker or dispatch when already stopped', async () => {
    const { picker } = destination(), controller = new AbortController()
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); controller.abort()
    await expect(new SshApi().downloadFile('fixture', '/remote/a', undefined, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError', dispatched: false })
    expect(picker).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })

  it('honors explicit browser download without opening the native save picker', async () => {
    const { picker } = destination()
    vi.stubGlobal('fetch', vi.fn(async () => response()))
    const result = await new SshApi().downloadFile('fixture', '/remote/a', undefined, undefined, 'browser')
    expect(picker).not.toHaveBeenCalled()
    expect(result.streamed).toBe(false)
    expect(await result.blob?.text()).toBe('download acceptance')
  })

  it('reports received bytes and speed even when the transport omits total length', async () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response(payload)))
    const progress = vi.fn()
    const result = await new SshApi().downloadFile('fixture', '/remote/a', progress)
    expect(progress.mock.calls.find(([value]) => value.phase === 'transferring')?.[0])
      .toMatchObject({ transferred: payload.length, total: 0, percent: 0 })
    expect(result.bytes).toBe(payload.length)
  })

  it('keeps a renamed destination and reports saving without declaring success before disk commit', async () => {
    const { writer, picker } = destination()
    picker.mockResolvedValue({ name: 'renamed-恢复.bin', createWritable: async () => writer } as never)
    const chosen = await prepareDownload('/remote/original.bin', 'picker')
    expect(chosen.filename).toBe('renamed-恢复.bin'); expect(writer.write).not.toHaveBeenCalled()
    let commit!: () => void
    writer.close.mockImplementation(() => new Promise<void>(resolve => { commit = resolve }))
    vi.stubGlobal('fetch', vi.fn(async () => response()))
    const progress = vi.fn(), pending = new SshApi().downloadFile('fixture', '/remote/original.bin', progress, undefined, 'picker', chosen)
    await vi.waitFor(() => expect(writer.close).toHaveBeenCalledOnce())
    expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'saving', transferred: payload.length, percent: 100 })
    expect(progress.mock.calls.some(([value]) => value.phase === 'done')).toBe(false)
    commit(); await pending
    expect(progress.mock.calls.at(-1)?.[0].phase).toBe('done'); expect(picker).toHaveBeenCalledOnce()
  })

  it('retains a disk commit failure without reporting successful save or retrying the transfer', async () => {
    const { writer } = destination(); writer.close.mockRejectedValueOnce(new Error('Commit denied'))
    const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch)
    const progress = vi.fn()
    await expect(new SshApi().downloadFile('fixture', '/remote/original', progress)).rejects.toThrow('Commit denied')
    expect(fetch).toHaveBeenCalledOnce(); expect(writer.abort).toHaveBeenCalledOnce()
    expect(progress.mock.calls.some(([value]) => value.phase === 'done')).toBe(false)
  })

  it('reports an uncertain stopped transfer if cancellation arrives while disk commit is pending', async () => {
    const { writer } = destination(), controller = new AbortController(); let commit!: () => void
    writer.close.mockImplementation(() => new Promise<void>(resolve => { commit = resolve }))
    const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch)
    const progress = vi.fn(), pending = new SshApi().downloadFile('fixture', '/remote/original', progress, controller.signal)
    await vi.waitFor(() => expect(writer.close).toHaveBeenCalledOnce())
    controller.abort(); commit()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', dispatched: true })
    expect(fetch).toHaveBeenCalledOnce(); expect(progress.mock.calls.some(([value]) => value.phase === 'done')).toBe(false)
  })
})
