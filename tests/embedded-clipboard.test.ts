// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { embeddedClipboard } from '../src/remote/clipboard-client.ts'
import { remotePage } from '../src/remote/page.ts'

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); document.getSelection()?.removeAllRanges() })

function fixture() {
  const denied = new DOMException('Clipboard write denied', 'NotAllowedError')
  const native = vi.fn().mockRejectedValue(denied)
  const readText = vi.fn()
  const clipboard = { writeText: native, readText }
  vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue(clipboard as unknown as Clipboard)
  vi.spyOn(navigator, 'userActivation', 'get').mockReturnValue({ isActive: true } as UserActivation)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const copied = vi.fn()
  const exec = vi.fn(() => {
    const event = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { setData: copied } })
    document.activeElement!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    return true
  })
  Object.defineProperty(document, 'execCommand', { configurable: true, writable: true, value: exec })
  // Exercise the exact serialized entry, so closure captures cannot pass.
  new Function(`(${embeddedClipboard.toString()})();`)()
  return { clipboard, native, readText, exec, copied, denied }
}

// jsdom omits these browser accessors; install a configurable baseline for spies.
Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => undefined })
Object.defineProperty(navigator, 'userActivation', { configurable: true, get: () => undefined })

it('copies exact Unicode/multiline code and preserves the composer text, caret and focus', async () => {
  const f = fixture(), composer = document.createElement('textarea')
  composer.value = 'Keep this unsent draft'; document.body.append(composer); composer.focus(); composer.setSelectionRange(2, 8, 'backward')
  const text = '中文 🙂\n```sh\nprintf "<tag> & $HOME"\n```\n'
  await f.clipboard.writeText(text)
  expect(f.copied).toHaveBeenCalledExactlyOnceWith('text/plain', text)
  expect(f.exec).toHaveBeenCalledExactlyOnceWith('copy'); expect(f.native).not.toHaveBeenCalled(); expect(f.readText).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(composer); expect(composer.value).toBe('Keep this unsent draft')
  expect([composer.selectionStart, composer.selectionEnd, composer.selectionDirection]).toEqual([2, 8, 'backward'])
  expect(document.querySelectorAll('textarea')).toHaveLength(1)
})

it('restores backward message selection and leaves no handler on ordinary selection copy', async () => {
  const f = fixture(), text = document.createTextNode('Selected message'), button = document.createElement('button')
  document.body.append(text, button); button.focus()
  document.getSelection()!.setBaseAndExtent(text, 8, text, 2)
  await f.clipboard.writeText('copied code')
  expect(document.getSelection()!.toString()).toBe('lected')
  expect([document.getSelection()!.anchorOffset, document.getSelection()!.focusOffset]).toEqual([8, 2])
  const event = new Event('copy', { bubbles: true, cancelable: true }); button.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false); expect(f.copied).toHaveBeenCalledOnce()
})

it.each(['inactive', 'hidden', 'unfocused'])('retains browser permission policy for %s documents', async state => {
  const f = fixture()
  if (state === 'inactive') vi.spyOn(navigator, 'userActivation', 'get').mockReturnValue({ isActive: false } as UserActivation)
  if (state === 'hidden') vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  if (state === 'unfocused') vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  await expect(f.clipboard.writeText('background')).rejects.toBe(f.denied)
  expect(f.native).toHaveBeenCalledOnce(); expect(f.exec).not.toHaveBeenCalled(); expect(f.readText).not.toHaveBeenCalled()
})

it.each(['false', 'throw'])('does not report success when legacy copy returns %s and native copy rejects', async result => {
  const f = fixture()
  f.exec.mockImplementation(() => { if (result === 'throw') throw Error('copy unavailable'); return false })
  await expect(f.clipboard.writeText('failed')).rejects.toBe(f.denied)
  expect(f.native).toHaveBeenCalledOnce(); expect(document.querySelector('textarea')).toBeNull()
})

it('uses the native result when legacy copy is unavailable, and installs once', async () => {
  const f = fixture(), installed = f.clipboard.writeText
  embeddedClipboard(); expect(f.clipboard.writeText).toBe(installed)
  f.exec.mockReturnValue(false); f.native.mockResolvedValue(undefined)
  await f.clipboard.writeText('native success'); expect(f.native).toHaveBeenCalledExactlyOnceWith('native success')
})

it('installs before upstream scripts in embedded pages and leaves ordinary web pages unchanged', () => {
  const html = '<html><head><script src="/client.js"></script></head><body></body></html>'
  const options = { alias: 'fixture', returnUrl: 'http://127.0.0.1:3080/', hostId: 'a'.repeat(24), recoveryProof: 'b'.repeat(64) }
  const embedded = remotePage(html, { ...options, embedded: true })
  expect(embedded.indexOf('dsh-ssh.embedded-clipboard')).toBeGreaterThan(-1)
  expect(embedded.indexOf('dsh-ssh.embedded-clipboard')).toBeLessThan(embedded.indexOf('src="/client.js"'))
  expect(remotePage(html, options)).not.toContain('dsh-ssh.embedded-clipboard')
})
