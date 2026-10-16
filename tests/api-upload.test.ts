import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SshApi } from '../src/client/api.ts'

class Request {
  static items: Request[] = []
  upload: { onprogress: ((event: { loaded: number }) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onprogress: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  responseText = ''; status = 200
  open = vi.fn(); send = vi.fn(); abort = vi.fn(() => this.onabort?.())
  constructor() { Request.items.push(this) }
  frame(value: string) { this.responseText += value; this.onprogress?.() }
}
const file = new File(['payload'], 'example.txt')
beforeEach(() => { Request.items = []; vi.stubGlobal('XMLHttpRequest', Request) })
afterEach(() => { vi.unstubAllGlobals() })

it('separates browser upload bytes from SSH progress and waits for the final result', async () => {
  const progress = vi.fn()
  const pending = new SshApi().uploadFile(file, 'fixture', '/remote/example.txt', progress)
  const request = Request.items[0]!
  request.upload.onprogress?.({ loaded: file.size })
  expect(progress.mock.calls[0]![0]).toMatchObject({ phase: 'staging', percent: 100, total: file.size })
  request.frame('{"type":"progress","progress":{"phase":"transferring","file":"/remote/example.txt",')
  request.frame('"transferred":3,"total":7,"percent":42.9}}\n')
  expect(progress.mock.calls.at(-1)![0]).toMatchObject({ phase: 'transferring', transferred: 3 })
  request.frame('{"type":"result","ok":true,"transferredBytes":7}')
  request.onload?.()
  expect(await pending).toEqual({ transferredBytes: 7 })
  expect(request.send).toHaveBeenCalledOnce()
})

it('cancels the dispatched request and ignores saved late handlers without retry', async () => {
  const controller = new AbortController(), progress = vi.fn()
  const pending = new SshApi().uploadFile(file, 'fixture', '/remote/example.txt', progress, controller.signal)
  const request = Request.items[0]!, late = request.onprogress
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError', dispatched: true })
  request.responseText = '{"type":"progress","progress":{"phase":"done"}}\n'
  late?.()
  expect(progress).not.toHaveBeenCalled()
  expect(request.abort).toHaveBeenCalledOnce()
  expect(request.send).toHaveBeenCalledOnce()
})

it('does not create a request when already cancelled', async () => {
  const controller = new AbortController(); controller.abort()
  await expect(new SshApi().uploadFile(file, 'fixture', '/remote/a', undefined, controller.signal))
    .rejects.toMatchObject({ dispatched: false })
  expect(Request.items).toHaveLength(0)
})

it('reports an uncertain remote outcome when the result is missing or the connection fails', async () => {
  const pending = new SshApi().uploadFile(file, 'fixture', '/remote/a')
  Request.items[0]!.onload?.()
  await expect(pending).rejects.toThrow('outcome unknown')
  const second = new SshApi().uploadFile(file, 'fixture', '/remote/b')
  Request.items[1]!.onerror?.()
  await expect(second).rejects.toThrow('not retried')
  expect(Request.items).toHaveLength(2)
})

it('preserves an HTTP rejection instead of reporting a successful staging upload', async () => {
  const pending = new SshApi().uploadFile(file, 'fixture', '/remote/a')
  const request = Request.items[0]!
  request.status = 413; request.responseText = '{"error":"upload body too large"}'
  request.onload?.()
  await expect(pending).rejects.toThrow('upload body too large')
})
