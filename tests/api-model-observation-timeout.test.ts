import { afterEach, expect, it, vi } from 'vitest'
import { SshApi } from '../src/client/api.ts'
import { createServer } from 'node:http'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it.each(['policy', 'check', 'open'] as const)('bounds the response wait for a dispatched model %s request without replaying it', async kind => {
  vi.useFakeTimers()
  const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    // Emulate an established controller request whose response never finishes.
    // Cancellation ends only this client's observation; no mutation is resent.
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
  }))
  vi.stubGlobal('fetch', fetch)
  const api = new SshApi()
  const request = kind === 'policy' ? api.setServerModelPolicy('fixture', 42, { mode: 'follow' })
    : kind === 'check' ? api.checkServerModels('fixture', 42) : api.openServerModels('fixture', 42)
  let settled = false
  const outcome = request.then(() => { settled = true }, () => { settled = true })
  // Policy/check allow an ordinary remote RPC budget before this browser
  // stops observing; opening an existing host is a short local operation.
  await vi.advanceTimersByTimeAsync(kind === 'open' ? 9000 : 25000)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(kind === 'open' ? 6000 : 10000)
  expect(settled).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(1)
  await outcome
})

it('bounds parsing after real HTTP headers arrive but the JSON response body stalls', async () => {
  const upstream = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"rows":') })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const port = (upstream.address() as { port: number }).port, nativeFetch = globalThis.fetch
  let receivedHeaders!: () => void
  const headers = new Promise<void>(resolve => { receivedHeaders = resolve })
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    const response = await nativeFetch('http://127.0.0.1:' + port + path, init)
    receivedHeaders(); return response
  })
  vi.stubGlobal('fetch', fetch)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const request = new SshApi().serverModels('fixture', 42)
    const outcome = request.then(() => undefined, error => error as Error)
    await headers
    await vi.advanceTimersByTimeAsync(10000)
    const error = await outcome
    expect(error?.name).toBe('TimeoutError')
    expect(error?.message).not.toContain('invalid JSON')
    expect(fetch).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers(); upstream.closeAllConnections()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
  }
})
