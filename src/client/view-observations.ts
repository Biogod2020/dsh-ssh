import type { ViewReceipt } from '../remote/view-receipts.ts'
import { tt } from './panel/helpers.ts'
import { remoteNavigation } from './remote-navigation.ts'
import css from './panel/panel.module.css'

const base = '/api/dsh-ssh/remote/view-observations'
/** A local-only recovery reader. Opening it never connects a remote Host. */
export function mountViewObservations(parent: HTMLElement) {
  const launch = document.createElement('button'); launch.type = 'button'; launch.className = css.linkButton; launch.textContent = tt('observations.manage'); launch.hidden = true
  parent.append(launch)
  let disposed = false, dialog: HTMLDialogElement | undefined, current: AbortController | undefined
  const lifetime = new AbortController()
  async function request<T>(path: string, body?: object, signal = lifetime.signal): Promise<T> {
    const result = await fetch(base + path, { cache: 'no-store', signal, ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) })
    if (!result.ok) throw new Error('Local observation reader unavailable')
    return result.json() as Promise<T>
  }
  const button = (label: string, click: () => void) => { const node = document.createElement('button'); node.type = 'button'; node.className = css.ghostButton; node.textContent = label; node.onclick = click; return node }
  type Hosts = { hosts: Array<{ hostId: string; alias?: string }>; next?: string; issue?: string }
  const validHosts = (value: Hosts) => Array.isArray(value.hosts) && value.hosts.length <= 50 && (value.next === undefined || /^[a-f0-9]{24}$/.test(value.next)) && value.hosts.every(row => /^[a-f0-9]{24}$/.test(row.hostId) && (row.alias === undefined || typeof row.alias === 'string'))
  launch.onclick = () => {
    if (disposed || dialog?.isConnected) return
    const owner = document.createElement('dialog'); dialog = owner; owner.className = css.historyCacheDialog
    const controller = new AbortController(); current = controller
    const heading = document.createElement('h2'); heading.textContent = tt('observations.manage')
    const help = document.createElement('p'); help.textContent = tt('observations.help')
    const close = button(tt('cache.close'), () => owner.close())
    const hosts = document.createElement('div'), rows = document.createElement('div'), status = document.createElement('p'), pager = document.createElement('div')
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite')
    hosts.className = css.remoteWorkspaceActions; pager.className = css.remoteWorkspaceActions
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = tt('observations.searchHosts'); search.setAttribute('aria-label', tt('observations.searchHosts'))
    const title = document.createElement('h3')
    owner.append(heading, help, close, search, hosts, title, status, rows, pager); document.body.append(owner)
    let hostPage: Hosts | undefined, chosen: Hosts['hosts'][number] | undefined, epoch = 0, hostStart = ''
    const hostCursors: string[] = [], rowCursors: string[] = []
    type PageMove = 'forward' | 'back'
    const alive = (attempt: number) => !disposed && dialog === owner && owner.isConnected && attempt === epoch
    function renderHosts() {
      hosts.replaceChildren()
      const query = search.value.toLocaleLowerCase()
      for (const host of hostPage?.hosts ?? []) if (!query || `${host.alias ?? ''} ${host.hostId}`.toLocaleLowerCase().includes(query)) {
        const node = button(host.alias || tt('observations.removedHost', { id: host.hostId.slice(0, 8) }), () => {
          chosen = host; rowCursors.length = 0; pager.replaceChildren(); void loadRows('')
        })
        node.setAttribute('aria-pressed', String(chosen?.hostId === host.hostId)); hosts.append(node)
      }
      if (hostCursors.length) hosts.append(button(tt('observations.previousHosts'), () => { void loadHosts(hostCursors.at(-1)!, 'back') }))
      if (hostPage?.next) hosts.append(button(tt('observations.nextHosts'), () => { void loadHosts(hostPage!.next!, 'forward') }))
    }
    search.oninput = renderHosts
    async function loadHosts(after: string, move?: PageMove) {
      const attempt = ++epoch; status.textContent = tt('observations.loading'); rows.replaceChildren(); pager.replaceChildren(); title.textContent = ''
      try {
        const result = await request<Hosts>('/hosts' + (after ? '?after=' + encodeURIComponent(after) : ''), undefined, controller.signal)
        if (!validHosts(result)) throw new Error('Invalid local Host directory')
        if (!alive(attempt)) return
        if (move === 'forward') hostCursors.push(hostStart)
        else if (move === 'back') hostCursors.pop()
        hostStart = after
        hostPage = result; chosen = undefined; renderHosts(); status.textContent = result.issue ? tt('observations.failed') : result.hosts.length ? tt('observations.chooseHost') : tt('observations.empty')
      } catch { if (alive(attempt)) status.textContent = tt('observations.failed') }
    }
    async function loadRows(after: string, move?: PageMove) {
      const host = chosen
      if (!host) return
      const attempt = ++epoch; status.textContent = tt('observations.loading'); rows.replaceChildren(); title.textContent = host.alias || host.hostId.slice(0, 8)
      for (const node of pager.querySelectorAll('button')) node.disabled = true
      try {
        const value = await request<{ entries: ViewReceipt[]; next?: string; issue?: string }>('?hostId=' + host.hostId + (after ? '&after=' + after : ''), undefined, controller.signal)
        if (!Array.isArray(value.entries) || value.entries.length > 50 || value.next !== undefined && !/^[a-f0-9]{64}$/.test(value.next)
          || value.entries.some(row => row.hostId !== host.hostId || row.outcome !== 'unconfirmed')) throw new Error('Invalid local observation page')
        if (!alive(attempt) || chosen !== host) return
        if (move === 'forward') rowCursors.push(after)
        else if (move === 'back') rowCursors.pop()
        pager.replaceChildren()
        renderHosts(); status.textContent = value.issue ? tt('observations.failed') : value.entries.length ? '' : tt('observations.empty')
        for (const entry of value.entries) {
          const row = document.createElement('section'); row.className = css.remoteWorkspaceFeedback; row.dataset.observationId = entry.observationId
          const label = document.createElement('strong'); label.textContent = tt(`observations.category.${entry.category}`)
          const time = document.createElement('time'); time.dateTime = new Date(entry.endedAt).toISOString(); time.textContent = new Date(entry.endedAt).toLocaleString()
          const unknown = document.createElement('p'); unknown.textContent = tt('observations.unconfirmed')
          const details = document.createElement('small'); details.textContent = tt('observations.id', { id: entry.observationId })
          row.append(label, document.createTextNode(' · '), time, unknown, details)
          if (entry.selectedSessionIdAtDispatch) {
            const snapshot = remoteNavigation.getSnapshot()
            const workspace = snapshot.workspaces.find(item => item.hostId === host.hostId && snapshot.catalogs.get(item.id)?.sessions.some(session => session.sessionId === entry.selectedSessionIdAtDispatch))
            if (workspace) row.append(button(tt('observations.openSelected'), () => remoteNavigation.open(workspace, entry.selectedSessionIdAtDispatch)))
          }
          const dismiss = button(tt('observations.dismiss'), () => {
            if (dismiss.disabled) return
            dismiss.disabled = true
            void request('/dismiss', { hostId: host.hostId, observationId: entry.observationId }, controller.signal).then(() => {
              if (alive(attempt) && chosen === host) void loadRows(after)
            }).catch(() => { if (alive(attempt)) { dismiss.disabled = false; status.textContent = tt('observations.failed') } })
          })
          row.append(dismiss); rows.append(row)
        }
        if (rowCursors.length) pager.append(button(tt('observations.previous'), () => { void loadRows(rowCursors.at(-2) ?? '', 'back') }))
        if (value.next) pager.append(button(tt('observations.next'), () => { void loadRows(value.next!, 'forward') }))
      } catch { if (alive(attempt)) { status.textContent = tt('observations.failed'); for (const node of pager.querySelectorAll('button')) node.disabled = false } }
    }
    owner.addEventListener('close', () => {
      ++epoch; controller.abort(); owner.remove()
      if (dialog === owner) { dialog = undefined; current = undefined; if (!disposed) launch.focus() }
    })
    owner.showModal(); void loadHosts('')
  }
  return {
    update(visible: boolean) { launch.hidden = !visible; launch.textContent = tt('observations.manage') },
    dispose() { disposed = true; lifetime.abort(); current?.abort(); dialog?.remove(); launch.remove() },
  }
}
