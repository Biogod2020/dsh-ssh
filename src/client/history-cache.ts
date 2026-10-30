import type { HistoryDocument, HistoryMeta, HistoryStorageSummary, HistoryStorageAudit } from '../remote/history-cache.ts'
import type { RemoteWorkspace } from '../remote/types.ts'
import { tt } from './panel/helpers.ts'
import css from './panel/panel.module.css'

const base = '/api/dsh-ssh/remote/history'
const requested = new Map<string, number>()
type HistoryLoader = (beforeSeq?: number) => Promise<HistoryDocument | undefined>
const loaders = new WeakMap<HistoryDocument, HistoryLoader>()
async function request<T>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(base + path, { ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' }), signal })
  if (!response.ok) throw new Error(tt('cache.failed'))
  return response.json() as Promise<T>
}
const identity = (item: RemoteWorkspace, sessionId: string) => JSON.stringify([item.hostId, item.workspaceId, sessionId])
export function markHistoryRequested(item: RemoteWorkspace, sessionId?: string): void { if (sessionId) requested.set(identity(item, sessionId), Date.now()) }
export function warmHistoryCopy(item: RemoteWorkspace, sessionId?: string): void {
  if (!sessionId || Date.now() - (requested.get(identity(item, sessionId)) ?? -Infinity) < 5000) return
  const key = identity(item, sessionId); requested.set(key, Date.now())
  void request('/sync', { id: item.id, sessionId }).catch(() => { requested.delete(key) })
}
export async function readHistoryCopy(item: RemoteWorkspace, sessionId: string, signal?: AbortSignal, beforeSeq?: number): Promise<HistoryDocument | undefined> {
  const copy=(await request<{ copy?: HistoryDocument }>('/read?id=' + encodeURIComponent(item.id) + '&sessionId=' + encodeURIComponent(sessionId)
    + '&limit=200' + (beforeSeq===undefined ? '' : '&beforeSeq='+beforeSeq), undefined, signal)).copy
  // The navigation observer owns only the initial read. Once visible, local
  // paging must keep working even when SSH observation is stopped/offline.
  if (copy) loaders.set(copy,before=>readHistoryCopy(item,sessionId,undefined,before))
  return copy
}
export function renderSavedHistory(copy: HistoryDocument, load: HistoryLoader | undefined = loaders.get(copy)): HTMLElement {
  const body = document.createElement('section'); body.className = css.savedHistory; body.setAttribute('aria-label', tt('cache.savedHistory'))
  const heading = document.createElement('h3'); heading.textContent = copy.meta.title || copy.meta.sessionId
  const status = document.createElement('p'); status.className = css.hint
  status.textContent = `${tt('cache.readOnly')} · ${new Date(copy.meta.savedAt).toLocaleString()}${copy.meta.complete ? '' : ' · ' + tt('cache.partial')}`
  body.append(heading, status)
  let shown = 0
  function text(value: unknown): string {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(text).filter(Boolean).join('\n')
    if (!value || typeof value !== 'object') return ''
    const row = value as Record<string, unknown>
    if (typeof row.text === 'string') return row.text
    if (row.type === 'tool-call') return tt('cache.toolCall', { name: typeof row.name === 'string' ? row.name : tt('cache.tool') })
    if (typeof row.thinking === 'string') return row.thinking
    if (typeof row.content === 'string' || Array.isArray(row.content)) return text(row.content)
    if (row.message) return text(row.message)
    if (row.data) return text(row.data)
    if (row.output) return text(row.output)
    if (row.type === 'tool-result' && row.result !== undefined) return text(row.result) || JSON.stringify(row.result, null, 2)
    if (row.type === 'image' || row.type === 'file') return tt('cache.attachment')
    return ''
  }
  function toolCalls(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) return value.flatMap(toolCalls)
    if (!value || typeof value !== 'object') return []
    const row = value as Record<string, unknown>
    if (row.type === 'tool-call') return [row]
    // Only message content belongs in the reader. Replay state, raw provider
    // streams and usage accounting are available in the original event file.
    return toolCalls(row.content ?? row.message ?? row.data)
  }
  const visible=(value:HistoryDocument)=>value.records.filter(row=>['user/message','assistant/message','tool/call','tool/result'].includes(row.event.type)||value.page?.omitted?.some(x=>x.seq===row.event.seq))
  let entries = visible(copy)
  const list = document.createElement('div'), older = document.createElement('button'); older.type = 'button'; older.className = css.ghostButton
  older.textContent = tt('cache.older')
  const latest=document.createElement('button');latest.type='button';latest.className=css.ghostButton;latest.textContent=tt('cache.latest');latest.hidden=true
  let generation=0
  const draw = () => {
    const previous = shown; shown = Math.min(entries.length, shown + 100)
    const fragment = document.createDocumentFragment()
    for (const row of entries.slice(entries.length - shown, entries.length - previous)) {
      const article = document.createElement('article'), label = document.createElement('strong'), content = document.createElement('pre')
      label.textContent = tt(row.event.type === 'user/message' ? 'cache.user' : row.event.type === 'assistant/message' ? 'cache.assistant' : 'cache.tool')
      // Text nodes only: remote content, tool output and Markdown never become HTML.
      const omitted=copy.page?.omitted?.find(x=>x.seq===row.event.seq)
      const message = omitted ? '' : text(row.event)
      content.textContent=omitted ? tt('cache.largeRecord',{size:size(omitted.bytes)}) : message || tt('cache.noText')
      article.append(label, content)
      if (!omitted) for (const call of toolCalls(row.event)) {
        if (call.arguments === undefined) continue
        const details = document.createElement('details'), summary = document.createElement('summary'), argumentsText = document.createElement('pre')
        summary.textContent = tt('cache.toolArguments', { name: typeof call.name === 'string' ? call.name : tt('cache.tool') })
        argumentsText.textContent = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments, null, 2)
        details.append(summary, argumentsText); article.append(details)
      }
      if (omitted || !message) {
        const download=document.createElement('a');download.textContent=tt('cache.downloadRecord')
        download.href=base+'/event?key='+encodeURIComponent(copy.meta.key)+'&seq='+row.event.seq
        download.download='history-event-'+row.event.seq+'.json';article.append(download)
      }
      fragment.append(article)
    }
    list.prepend(fragment); older.hidden = copy.page ? shown >= entries.length && (!copy.page.hasMore || !load) : shown >= entries.length
    latest.hidden=!copy.page || !load || (copy.records.at(-1)?.event.seq??copy.meta.cursor)>=copy.meta.cursor
    if (!entries.length && !list.childElementCount) { const empty=document.createElement('p');empty.textContent=tt(copy.page?.hasMore?'cache.emptyWindow':'cache.emptyHistory');list.append(empty) }
  }
  const page=async(before?:number)=>{
    if (!load) return
    const current=++generation;older.disabled=latest.disabled=true
    try {
      const next=await load(before)
      if (current!==generation || !body.isConnected || !next) return
      if (next.meta.key!==copy.meta.key || next.meta.hostId!==copy.meta.hostId || next.meta.workspaceId!==copy.meta.workspaceId || next.meta.sessionId!==copy.meta.sessionId) throw new Error('Saved history identity changed')
      copy=next;entries=visible(copy)
      shown=0;list.replaceChildren();draw()
      heading.textContent=copy.meta.title||copy.meta.sessionId
      status.textContent=`${tt('cache.readOnly')} · ${new Date(copy.meta.savedAt).toLocaleString()}${copy.meta.complete?'':' · '+tt('cache.partial')}`
    } catch { if (current===generation && body.isConnected) status.textContent=tt('cache.failed') }
    finally { if (current===generation) older.disabled=latest.disabled=false }
  }
  older.onclick=()=>{if(copy.page&&load&&shown>=entries.length)void page(copy.page.beforeSeq);else draw()}
  latest.onclick=()=>{void page()};draw();body.append(older,latest,list)
  return body
}

interface Summary { entries: HistoryMeta[]; bytes: number; reminder: boolean; warning?: string; failures?: Record<string, string>; syncing?: string[]; storage?: HistoryStorageSummary }
const size = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`
/** Same-window disk-cache manager. Clear affects local copies only. */
export function mountHistoryCache(parent: HTMLElement): () => void {
  const launch = document.createElement('button'); launch.type = 'button'; launch.className = css.linkButton; launch.textContent = tt('cache.manage')
  const notice = document.createElement('div'); notice.className = css.historyCacheNotice; notice.hidden = true; notice.setAttribute('role', 'status')
  const reminder = document.createElement('span'), review = document.createElement('button'), later = document.createElement('button')
  review.type = later.type = 'button'; review.className = later.className = css.linkButton
  review.textContent = tt('cache.review'); later.textContent = tt('cache.later'); notice.append(reminder, review, later); parent.append(launch, notice)
  const controller = new AbortController(); let disposed = false, dialog: HTMLDialogElement | undefined
  const update = async () => {
    try {
      const value = await request<Summary>('', undefined, controller.signal)
      if (disposed || !Array.isArray(value.entries)) return
      launch.textContent = `${tt('cache.manage')} · ${tt('cache.savedSize', { size: size(value.bytes) })}`
      notice.hidden = !value.reminder && !value.warning && !Object.keys(value.failures ?? {}).length
      reminder.textContent = value.warning || (Object.keys(value.failures ?? {}).length ? tt('cache.syncFailed')
        : value.storage && !value.storage.stale && value.storage.unreferencedBytes > 0 ? tt('cache.extraFiles', { size: size(value.storage.unreferencedBytes) })
          : value.storage && !value.storage.stale && value.storage.incomplete ? tt('cache.fileScanIncomplete')
          : tt('cache.reminder', { size: size(value.bytes), count: String(value.entries.length) }))
    } catch { /* The ordinary controller status owns connection errors. */ }
  }
  const open = async () => {
    if (dialog?.isConnected) return
    dialog = document.createElement('dialog'); dialog.className = css.historyCacheDialog
    const owner = dialog
    const title = document.createElement('h2'); title.textContent = tt('cache.manage')
    const help = document.createElement('p'); help.textContent = tt('cache.help')
    const close = document.createElement('button'); close.type = 'button'; close.textContent = tt('cache.close'); close.className = css.ghostButton
    close.onclick = () => { dialog?.close(); dialog?.remove(); dialog = undefined; launch.focus() }
    dialog.addEventListener('close', () => { dialog?.remove(); dialog = undefined; launch.focus() })
    const filters = document.createElement('div'), host = document.createElement('select'), project = document.createElement('select')
    host.setAttribute('aria-label', tt('cache.host')); project.setAttribute('aria-label', tt('cache.project')); filters.append(host, project)
    const choose = document.createElement('button'); choose.type = 'button'; choose.textContent = tt('cache.selectVisible'); choose.className = css.ghostButton
    const clear = document.createElement('button'); clear.type = 'button'; clear.className = css.ghostButton; clear.textContent = tt('cache.clear'); clear.disabled = true
    const list = document.createElement('div'), reader = document.createElement('div'), status = document.createElement('p'); status.setAttribute('role', 'status')
    const storageStatus = document.createElement('p'), checkStorage = document.createElement('button'), finishClear = document.createElement('button')
    storageStatus.setAttribute('role', 'status'); checkStorage.type = 'button'; checkStorage.className = css.ghostButton; checkStorage.textContent = tt('cache.checkFiles')
    finishClear.type = 'button'; finishClear.className = css.ghostButton; finishClear.textContent = tt('cache.finishClear'); finishClear.hidden = true
    dialog.append(title, help, close, storageStatus, checkStorage, finishClear, filters, choose, clear, status, list, reader); document.body.append(dialog); dialog.showModal()
    const selected = new Set<string>(); let entries: HistoryMeta[] = [], visible: HistoryMeta[] = [], readEpoch=0
    let storage: HistoryStorageAudit | undefined, auditEpoch = 0
    const refreshStorage = async () => {
      const epoch = ++auditEpoch; checkStorage.disabled = true; storageStatus.textContent = tt('cache.checkingFiles')
      try {
        const value = await request<{ storage?: HistoryStorageAudit }>('/audit', undefined, controller.signal)
        if (disposed || dialog !== owner || !owner.isConnected || epoch !== auditEpoch) return
        const audit = value.storage
        if (!audit || !Number.isSafeInteger(audit.fileBytes) || audit.fileBytes < 0 || !audit.byKey) throw new Error('Storage inventory unavailable')
        storage = audit
        finishClear.hidden = !Object.values(audit.byKey).some(value => value.clearedGeneration !== undefined)
        storageStatus.textContent = tt(audit.incomplete ? 'cache.fileSizesPartial' : 'cache.fileSizes', { size: size(audit.fileBytes), time: new Date(audit.observedAt).toLocaleString() })
          + (audit.unreferencedBytes && !audit.stale ? ' · ' + tt('cache.extraFiles', { size: size(audit.unreferencedBytes) }) : '')
          + (audit.incomplete ? ' · ' + tt('cache.fileScanIncomplete') : '')
          + (audit.stale ? ' · ' + tt('cache.fileScanStale') : '')
        render(); void update()
      } catch { if (dialog === owner && owner.isConnected && epoch === auditEpoch) storageStatus.textContent = tt('cache.fileScanFailed') }
      finally { if (dialog === owner && owner.isConnected && epoch === auditEpoch) checkStorage.disabled = false }
    }
    checkStorage.onclick = () => { void refreshStorage() }
    finishClear.onclick = () => {
      const rows = Object.entries(storage?.byKey ?? {}).filter(([, value]) => value.clearedGeneration !== undefined)
      if (!rows.length || !window.confirm(tt('cache.confirmFinishClear', { count: String(rows.length), size: size(rows.reduce((sum, [, value]) => sum + value.fileBytes, 0)) }))) return
      finishClear.disabled = true
      void request('/finish-clear', { selection: rows.map(([key, value]) => ({ key, generation: value.clearedGeneration })) }, controller.signal).then(() => {
        if (dialog !== owner || !owner.isConnected) return
        status.textContent = tt('cache.finishedClear'); void refreshStorage(); void update()
      }).catch(() => { if (dialog === owner && owner.isConnected) status.textContent = tt('cache.finishClearChanged') })
        .finally(() => { if (dialog === owner && owner.isConnected) finishClear.disabled = false })
    }
    const option = (value: string, label: string) => { const element = document.createElement('option'); element.value = value; element.textContent = label; return element }
    const buttons = () => { clear.disabled = !selected.size; clear.textContent = `${tt('cache.clear')} (${selected.size})` }
    const render = () => {
      visible = entries.filter(item => (!host.value || item.hostId === host.value) && (!project.value || item.workspaceId === project.value))
      list.replaceChildren()
      for (const item of visible) {
        const row = document.createElement('div'); row.className = css.historyCacheRow
        const label = document.createElement('label'), check = document.createElement('input'); check.type = 'checkbox'; check.checked = selected.has(item.key)
        const name = document.createElement('span'); name.textContent = `${item.alias} · ${item.remotePath} · ${item.title || item.sessionId} · ${size(storage?.byKey[item.key]?.fileBytes ?? item.bytes)}`
        check.onchange = () => { if (check.checked) selected.add(item.key); else selected.delete(item.key); buttons() }; label.append(check, name)
        const view = document.createElement('button'); view.type = 'button'; view.className = css.linkButton; view.textContent = tt('cache.view')
        view.onclick = () => {
          const epoch=++readEpoch
          const load:HistoryLoader=async before=>(await request<{copy?:HistoryDocument}>('/read?key='+item.key+'&limit=200'+(before===undefined?'':'&beforeSeq='+before),undefined,controller.signal)).copy
          void load().then(copy => {
          if (epoch===readEpoch && dialog?.isConnected && copy) reader.replaceChildren(renderSavedHistory(copy,load))
        }).catch(() => { status.textContent = tt('cache.failed') }) }
        row.append(label, view); list.append(row)
      }
      if (!visible.length) list.textContent = tt('cache.empty')
      buttons()
    }
    const projects = () => {
      project.replaceChildren(option('', tt('cache.allProjects')))
      const unique = new Map(entries.filter(item => !host.value || item.hostId === host.value).map(item => [item.workspaceId, item.remotePath]))
      for (const [id, path] of unique) project.append(option(id, path))
    }
    host.onchange = () => { projects(); render() }; project.onchange = render
    choose.onclick = () => { const all = visible.every(item => selected.has(item.key)); for (const item of visible) if (all) selected.delete(item.key); else selected.add(item.key); render() }
    clear.onclick = () => {
      const estimate = entries.filter(item => selected.has(item.key)).reduce((sum, item) => sum + (storage?.byKey[item.key]?.fileBytes ?? item.bytes), 0)
      if (!selected.size || !window.confirm(tt('cache.confirmClear', { count: String(selected.size) }) + '\n' + tt('cache.clearEstimate', { size: size(estimate) }))) return
      clear.disabled = true
      void request('/clear', { keys: [...selected] }, controller.signal).then(() => {
        ++readEpoch;entries = entries.filter(item => !selected.has(item.key)); selected.clear(); requested.clear(); reader.replaceChildren(); projects(); render(); void update()
        status.textContent = tt('cache.cleared')
        void refreshStorage()
      }).catch(() => { status.textContent = tt('cache.failed'); buttons() })
    }
    try {
      const value = await request<Summary>('', undefined, controller.signal)
      if (!dialog?.isConnected) return
      entries = value.entries; host.append(option('', tt('cache.allHosts')))
      for (const [id, alias] of new Map(entries.map(item => [item.hostId, item.alias]))) host.append(option(id, alias))
      projects(); render(); void refreshStorage()
    } catch { status.textContent = tt('cache.failed') }
  }
  launch.onclick = review.onclick = () => { void open() }
  later.onclick = () => { void request('/snooze', {}, controller.signal).then(update).catch(() => {}) }
  const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void update() }, 60000)
  void update()
  return () => { disposed = true; controller.abort(); clearInterval(timer); dialog?.remove(); launch.remove(); notice.remove() }
}
