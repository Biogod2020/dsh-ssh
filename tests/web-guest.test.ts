// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createWebGuest } from '../src/client/web-guest.ts'

let guest: ReturnType<typeof createWebGuest> | undefined
afterEach(() => { guest?.disposeControl(); guest = undefined; document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks() })

it('accepts a usable client before window.load while a noncritical resource is still pending', async () => {
  vi.useFakeTimers(); guest = createWebGuest()
  const loaded = guest.loadURL('http://127.0.0.1:40200/'); document.body.append(guest)
  const loadEvent = vi.fn(); guest.addEventListener('load', loadEvent)
  vi.spyOn(guest.contentWindow!, 'postMessage').mockImplementation(message => {
    window.dispatchEvent(new MessageEvent('message', { source: guest!.contentWindow, origin: 'http://127.0.0.1:40200', data: { type: 'dsh-ssh-reply', id: message.id, value: true } }))
  })
  await vi.advanceTimersByTimeAsync(1); await loaded
  expect(loadEvent).not.toHaveBeenCalled()
})

it('reports core asset failure early and ignores a reply from another origin', async () => {
  vi.useFakeTimers(); guest = createWebGuest()
  const loaded = guest.loadURL('http://127.0.0.1:40200/'); const failed = expect(loaded).rejects.toMatchObject({ name: 'RemoteBootAssetError' })
  document.body.append(guest)
  vi.spyOn(guest.contentWindow!, 'postMessage').mockImplementation(message => {
    window.dispatchEvent(new MessageEvent('message', { source: guest!.contentWindow, origin: 'http://untrusted.invalid', data: { type: 'dsh-ssh-reply', id: message.id, value: true } }))
    window.dispatchEvent(new MessageEvent('message', { source: guest!.contentWindow, origin: 'http://127.0.0.1:40200', data: { type: 'dsh-ssh-reply', id: message.id, error: 'failed', errorCode: 'boot/assets-failed' } }))
  })
  await vi.advanceTimersByTimeAsync(1); await failed
})
