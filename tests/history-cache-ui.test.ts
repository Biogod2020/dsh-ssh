// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { mountHistoryCache, readHistoryCopy, renderSavedHistory } from '../src/client/history-cache.ts'
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

it('pages bounded windows without skipping the first half, and late pages cannot replace a detached reader',async()=>{
  document.documentElement.lang='en'
  const records=(first:number,last:number)=>Array.from({length:last-first+1},(_,n)=>({type:'event' as const,event:{seq:first+n,type:'user/message',data:{content:'Generated '+(first+n)}}}))
  const current={...copy,meta:{...copy.meta,cursor:399,records:400},records:records(200,399),page:{beforeSeq:200,hasMore:true}}
  const load=vi.fn(async()=>({...current,records:records(0,199),page:{beforeSeq:0,hasMore:false}}))
  const view=renderSavedHistory(current,load);document.body.append(view)
  const older=[...view.querySelectorAll('button')].find(x=>x.textContent==='Show earlier saved history')!
  expect(view.querySelectorAll('article')).toHaveLength(100);older.click()
  expect(load).not.toHaveBeenCalled();expect(view.querySelectorAll('article')).toHaveLength(200)
  expect(view.textContent).toContain('Generated 200');older.click();await flush()
  expect(load).toHaveBeenCalledWith(200);expect(view.textContent).toContain('Generated 199');expect(view.textContent).not.toContain('Generated 399')
  expect(view.querySelectorAll('article')).toHaveLength(100)
  older.click();expect(view.querySelectorAll('article')).toHaveLength(200);expect(older.hidden).toBe(true)
})

it('refuses a page from another host without changing the currently displayed history',async()=>{
  document.documentElement.lang='en'
  const page={...copy,page:{beforeSeq:0,hasMore:true}}
  const load=vi.fn(async()=>({...copy,meta:{...copy.meta,hostId:'other-host'}}))
  const view=renderSavedHistory(page,load);document.body.append(view)
  ;[...view.querySelectorAll('button')].find(x=>x.textContent==='Show earlier saved history')!.click();await flush()
  expect(view.textContent).toContain('Could not read');expect(view.textContent).toContain('Saved assistant answer')
})

it('continues local paging after the initial remote navigation observer is cancelled',async()=>{
  document.documentElement.lang='en'
  const controller=new AbortController(),value={...copy,page:{beforeSeq:1,hasMore:true}}
  const fetch=vi.fn(async(_input:unknown,init?:RequestInit)=>{init?.signal?.throwIfAborted();return{ok:true,json:async()=>({copy:value})}})
  vi.stubGlobal('fetch',fetch)
  const workspace={id:'fixture',hostId:'host',workspaceId:'project',alias:'fixture',remotePath:'/project',title:'project'}
  const saved=await readHistoryCopy(workspace,'session',controller.signal)
  const view=renderSavedHistory(saved!);document.body.append(view);controller.abort()
  ;[...view.querySelectorAll('button')].find(x=>x.textContent==='Show earlier saved history')!.click();await flush()
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(fetch.mock.calls[1]![1]?.signal).toBeUndefined()
  expect(view.textContent).not.toContain('Could not read')
})

it('offers explicit local download for a large record without inserting its full body or fetching it automatically',()=>{
  document.documentElement.lang='en'
  const view=renderSavedHistory({...copy,records:[{type:'event',event:{seq:1,type:'tool/result'}}],page:{beforeSeq:1,hasMore:true,omitted:[{seq:1,bytes:3*1024*1024}]}})
  document.body.append(view);const a=view.querySelector<HTMLAnchorElement>('a')!
  expect(view.textContent).toContain('large');expect(a.textContent).toBe('Download complete record')
  expect(a.getAttribute('href')).toBe('/api/dsh-ssh/remote/history/event?key='+key+'&seq=1')
  expect(a.download).toBe('history-event-1.json')
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
