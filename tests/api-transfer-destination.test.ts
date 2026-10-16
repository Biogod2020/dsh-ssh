import { afterEach, expect, it, vi } from 'vitest'
import { SshApi, TransferDestinationHostChangedError } from '../src/client/api.ts'
import { SSH_API } from '../src/protocol.ts'
afterEach(() => vi.unstubAllGlobals())
it('requests one frozen absolute path without caching and forwards cancellation', async () => {
  const stop = new AbortController(), fetch = vi.fn(async () => Response.json({ exists: false, checkedAt: 12 })); vi.stubGlobal('fetch', fetch)
  expect(await new SshApi().inspectDestination('original', '/original/a b', 12, stop.signal)).toEqual({ exists: false, checkedAt: 12 })
  const [url, options] = fetch.mock.calls[0]! as unknown as [string, RequestInit]
  expect(url.split('?')[0]).toBe(SSH_API.transferDestination); expect(new URLSearchParams(url.split('?')[1])).toEqual(new URLSearchParams({ alias: 'original', path: '/original/a b', expectedUpdatedAt: '12' }))
  expect(options.cache).toBe('no-store'); stop.abort(); expect(options.signal?.aborted).toBe(true); expect(fetch).toHaveBeenCalledOnce()
})
it.each([{ exists: 'false', checkedAt: 12 }, { exists: false, checkedAt: -1 }, { exists: true, type: 'file', size: -1, mtimeMs: 0, checkedAt: 12 }, { exists: true, type: 'file', size: 4, mtimeMs: null, checkedAt: 12 }])('rejects invalid metadata rather than inventing a result %#', async value => {
  const fetch = vi.fn(async () => Response.json(value)); vi.stubGlobal('fetch', fetch)
  await expect(new SshApi().inspectDestination('original', '/file', 12)).rejects.toThrow(); expect(fetch).toHaveBeenCalledOnce()
})
it('preserves host/version errors and never retries a rejected check', async () => {
  const fetch = vi.fn(async () => Response.json({ error: 'Host configuration changed' }, { status: 409 })); vi.stubGlobal('fetch', fetch)
  const error = await new SshApi().inspectDestination('original', '/file', 12).catch(error => error)
  expect(error).toBeInstanceOf(TransferDestinationHostChangedError); expect(error.message).toBe('Host configuration changed'); expect(fetch).toHaveBeenCalledOnce()
})
