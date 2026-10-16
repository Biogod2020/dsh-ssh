// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { remotePage } from '../src/remote/page.ts'

afterEach(() => { window.dispatchEvent(new Event('pagehide')); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); document.body.innerHTML = ''; document.documentElement.lang = '' })

it('escapes host identity and session navigation without allowing embedded script execution', () => {
  const html = remotePage('<html><head></head><body><div id="root"></div></body></html>', {
    alias: '</strong><script>alert(1)</script>', returnUrl: 'http://127.0.0.1:3080/?a="&b=1',
    hostId: 'a'.repeat(24), recoveryProof: 'b'.repeat(64), sessionId: '</script><img src=x>',
  })
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  expect(parsed.querySelector('strong')?.textContent).toBe('</strong><script>alert(1)</script>')
  expect(parsed.querySelectorAll('script')).toHaveLength(2)
  expect(parsed.querySelector('img')).toBeNull()
  new Function(parsed.head.querySelector('script')!.textContent!)()
  expect(JSON.parse(localStorage.getItem('dsh.sessions.current')!).sessionId).toBe('</script><img src=x>')
})

it('serializes a self-contained lamp and decorates native workspace rows after mounting', async () => {
  vi.useFakeTimers()
  document.documentElement.lang = 'en'
  const fetchStatus = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ready: true }) })
  vi.stubGlobal('fetch', fetchStatus)
  const html = remotePage('<html><head></head><body><div id="root"></div></body></html>', {
    alias: 'fixture', returnUrl: 'http://127.0.0.1:3080/', hostId: 'a'.repeat(24), recoveryProof: 'b'.repeat(64),
  })
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  document.body.innerHTML = parsed.body.innerHTML
  new Function(parsed.body.querySelector('script')!.textContent!)()
  document.querySelector('#root')!.innerHTML = '<div role="treeitem" class="projectRow_test"><span class="projectText_test">project</span></div>'
  await vi.advanceTimersByTimeAsync(0)
  expect(document.querySelector('[data-dsh-remote-lamp]')?.getAttribute('aria-label')).toBe('SSH · Connected')
  fetchStatus.mockResolvedValue({ ok: true, json: async () => ({ ready: false }) })
  await vi.advanceTimersByTimeAsync(5000)
  expect(document.querySelector('[data-dsh-remote-lamp]')?.getAttribute('aria-label')).toBe('SSH · Connection lost')
})

it('offers recovery after a lost gateway and carries the selected session in a fragment', async () => {
  vi.useFakeTimers()
  const fetchStatus = vi.fn().mockRejectedValue(new Error('gateway closed'))
  vi.stubGlobal('fetch', fetchStatus)
  localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: 'session-42' }))
  const html = remotePage('<html><head></head><body><div id="root"></div></body></html>', {
    alias: 'fixture', returnUrl: 'http://127.0.0.1:3080/', hostId: 'a'.repeat(24), recoveryProof: 'b'.repeat(64),
  })
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  document.body.innerHTML = parsed.body.innerHTML
  new Function(parsed.body.querySelector('script')!.textContent!)()
  const link = document.querySelector<HTMLAnchorElement>('#dsh-remote-recover')!
  await vi.advanceTimersByTimeAsync(5000)
  expect(link.hidden).toBe(false)
  expect(link.target).toBe('_blank')
  link.addEventListener('click', event => event.preventDefault())
  link.click()
  const target = new URL(link.href)
  expect(target.origin).toBe('http://127.0.0.1:3080')
  expect(target.search).toBe('')
  expect(JSON.parse(new URLSearchParams(target.hash.slice(1)).get('dsh-ssh-recover')!)).toEqual({
    hostId: 'a'.repeat(24), proof: 'b'.repeat(64), sessionId: 'session-42',
  })
})

function mountLamp() {
  const html = remotePage('<html><head></head><body><div id="root"></div></body></html>', {
    alias: 'fixture', returnUrl: 'http://127.0.0.1:3080/', hostId: 'a'.repeat(24), recoveryProof: 'b'.repeat(64),
  })
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML
  new Function(document.body.querySelector('script')!.textContent!)()
}

it('clears stale connected state while hidden and ignores late health results until a fresh visible check', async () => {
  vi.useFakeTimers(); document.documentElement.lang = 'en'
  let release!: (value: object) => void
  const fetchStatus = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ready: true }) })
    .mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    .mockResolvedValue({ ok: true, json: async () => ({ ready: false }) })
  vi.stubGlobal('fetch', fetchStatus); mountLamp(); await vi.advanceTimersByTimeAsync(5000)
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange'))
  expect(document.querySelector('#dsh-remote-status')?.textContent).toBe('Status unconfirmed')
  expect(fetchStatus.mock.calls[1]![1].signal.aborted).toBe(true)
  release({ ok: true, json: async () => ({ ready: true }) }); await vi.advanceTimersByTimeAsync(20000)
  expect(fetchStatus).toHaveBeenCalledTimes(2)
  expect(document.querySelector('#dsh-remote-status')?.textContent).toBe('Status unconfirmed')
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(0)
  expect(document.querySelector('#dsh-remote-status')?.textContent).toBe('Connection lost')
})

it('reports browser offline immediately, then checks once online without replaying any mutation', async () => {
  vi.useFakeTimers(); document.documentElement.lang = 'en'
  const fetchStatus = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ready: true }) })
  vi.stubGlobal('fetch', fetchStatus); mountLamp(); await vi.advanceTimersByTimeAsync(0)
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false); window.dispatchEvent(new Event('offline'))
  expect(document.querySelector('#dsh-remote-status')?.textContent).toBe('Browser offline')
  await vi.advanceTimersByTimeAsync(20000); expect(fetchStatus).toHaveBeenCalledTimes(1)
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true); window.dispatchEvent(new Event('online'))
  await vi.advanceTimersByTimeAsync(0)
  expect(document.querySelector('#dsh-remote-status')?.textContent).toBe('Connected')
  expect(fetchStatus).toHaveBeenCalledTimes(2)
  expect(fetchStatus.mock.calls.every(([path, init]) => path === '/__dsh_remote/status' && !init.method)).toBe(true)
})

it('updates language without replacing the recovery link and resumes after a browser history cache restore', async () => {
  vi.useFakeTimers(); document.documentElement.lang = 'en'
  const fetchStatus = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ready: false }) })
  vi.stubGlobal('fetch', fetchStatus); mountLamp(); await vi.advanceTimersByTimeAsync(5000)
  const link = document.querySelector('#dsh-remote-recover')!; (link as HTMLElement).focus()
  document.documentElement.lang = 'zh'; await vi.advanceTimersByTimeAsync(0)
  expect(document.querySelector('#dsh-remote-recover')).toBe(link)
  expect(link.textContent).toContain('恢复原会话')
  expect(document.activeElement).toBe(link)
  const hide = new Event('pagehide'); Object.defineProperty(hide, 'persisted', { value: true }); window.dispatchEvent(hide)
  await vi.advanceTimersByTimeAsync(10000); expect(fetchStatus).toHaveBeenCalledTimes(2)
  fetchStatus.mockResolvedValue({ ok: true, json: async () => ({ ready: true }) })
  window.dispatchEvent(new Event('pageshow')); await vi.advanceTimersByTimeAsync(0)
  expect(document.querySelector('#dsh-remote-status')?.textContent).toBe('已连接')
  expect((link as HTMLElement).hidden).toBe(true)
})
