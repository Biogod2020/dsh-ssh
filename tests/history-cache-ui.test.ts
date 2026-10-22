// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { mountHistoryCache, renderSavedHistory } from '../src/client/history-cache.ts'
import type { HistoryDocument } from '../src/remote/history-cache.ts'

const key = 'a'.repeat(64), other = 'b'.repeat(64)
const copy: HistoryDocument = { meta: { key, hostId: 'host', workspaceId: 'project', sessionId: 'session', alias: 'fixture', remotePath: '/project', title: 'Saved chat',
  savedAt: 1, firstSavedAt: 1, remoteUpdatedAt: 1, cursor: 1, complete: true, bytes: 100, records: 2 }, records: [
    { type: 'event', event: { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: '<script>unsafe()</script>' }] } } },
    { type: 'event', event: { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Saved assistant answer' }] } } } },
  ] }
let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve() }
function fixture() {
  document.documentElement.lang = 'en'
  Object.assign(HTMLDialogElement.prototype, { showModal(this: HTMLDialogElement) { this.setAttribute('open', '') }, close(this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')) } })
  const entries = [copy.meta, { ...copy.meta, key: other, hostId: 'other-host', workspaceId: 'other-project', alias: 'second-host' }]
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) => ({ ok: true, json: async () => {
    if (String(input).includes('/read?')) return { copy }
    if (String(input).endsWith('/clear')) { const selected = JSON.parse(init!.body as string).keys; for (let n = entries.length - 1; n >= 0; n--) if (selected.includes(entries[n]!.key)) entries.splice(n, 1); return { ok: true } }
    return { entries, bytes: 200, reminder: true, reasons: ['age'] }
  } }))
  vi.stubGlobal('fetch', fetch)
  cleanup = mountHistoryCache(document.body)
  return { entries, fetch }
}
it('renders saved message text without executing remote HTML or requesting attachments', () => {
  document.documentElement.lang = 'en'; const reader = renderSavedHistory(copy); document.body.append(reader)
  expect(reader.textContent).toContain('<script>unsafe()</script>'); expect(reader.querySelector('script')).toBeNull()
  expect(reader.textContent).toContain('Saved assistant answer')
  expect(reader.textContent).toContain('read only')
})
it('proactively reminds and allows choosing a Host/project and clearing only selected local copies', async () => {
  const f = fixture(); vi.spyOn(window, 'confirm').mockReturnValue(true); await flush()
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Review and clear')
  ;[...document.querySelectorAll('button')].find(x => x.textContent?.startsWith('Local history cache'))!.click(); await flush()
  const host = document.querySelector<HTMLSelectElement>('select[aria-label="Filter host"]')!; host.value = 'host'; host.dispatchEvent(new Event('change'))
  ;[...document.querySelectorAll('button')].find(x => x.textContent === 'Select / deselect filtered copies')!.click()
  ;[...document.querySelectorAll('button')].find(x => x.textContent === 'Clear selected local copies (1)')!.click(); await flush()
  const mutations = f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
  expect(mutations.map(([path]) => path)).toEqual(['/api/dsh-ssh/remote/history/clear'])
  expect(JSON.parse(mutations[0]![1]!.body as string).keys).toEqual([key])
  expect(f.entries.map(x => x.key)).toEqual([other])
  expect(document.querySelector('dialog')!.textContent).toContain('Remote conversations are unchanged')
})
it('keeps clear reversible at the selection step and supports snoozing reminders without deleting copies', async () => {
  const f = fixture(); await flush()
  ;[...document.querySelectorAll('button')].find(x => x.textContent === 'Remind in 7 days')!.click(); await flush()
  expect(f.entries).toHaveLength(2)
  expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([path]) => path)).toEqual(['/api/dsh-ssh/remote/history/snooze'])
})
