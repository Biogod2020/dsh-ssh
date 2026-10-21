import type { RemoteSessionCatalog, RemoteWorkspace } from '../remote/types.ts'
import { remoteSelection, subscribeRemoteSelection } from './remote-presentation.ts'
import { tt } from './panel/helpers.ts'
import css from './panel/panel.module.css'

/** Keyed Session navigation below its Host + remote-directory identity. */
export function remoteSessionRows(workspace: RemoteWorkspace, open: (sessionId?: string, create?: boolean) => void) {
  const node = document.createElement('div'); node.className = css.remoteSessionTree
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = css.remoteSessionToggle
  const list = document.createElement('div'); list.id = `ssh-sessions-${workspace.id}`; list.className = css.remoteSessionList
  toggle.setAttribute('aria-controls', list.id)
  const hint = document.createElement('p'); hint.className = css.remoteSessionHint; hint.setAttribute('role', 'status')
  const entries = document.createElement('div')
  const create = document.createElement('button'); create.type = 'button'; create.className = css.remoteSessionNew
  const keyed = new Map<string, HTMLButtonElement>()
  list.append(hint, entries, create); node.append(toggle, list)
  let catalog: RemoteSessionCatalog | undefined, expanded = true, busy = false, offline = false, disposed = false
  let pending: AbortController | undefined
  const text = (element: HTMLElement, value: string) => { if (element.textContent !== value) element.textContent = value }
  const render = () => {
    const selected = remoteSelection()
    text(toggle, `${expanded ? '▾' : '▸'} ${tt('remote.sessions')}${catalog && (!catalog.stale || catalog.checkedAt !== undefined) ? ` (${catalog.sessions.length})` : ''}`)
    toggle.setAttribute('aria-expanded', String(expanded)); list.hidden = !expanded
    text(create, tt('remote.newSession')); create.disabled = busy || offline
    text(hint, offline ? tt('remote.offline') : catalog?.warning ? tt('remote.sessionsUnavailable') : catalog?.stale ? tt(catalog.checkedAt === undefined ? 'remote.sessionsNotLoaded' : 'remote.sessionsSaved')
      : !catalog ? tt('remote.sessionsLoading') : catalog.sessions.length ? '' : tt('remote.sessionsEmpty'))
    hint.hidden = !hint.textContent
    hint.title = catalog?.checkedAt ? tt('remote.sessionsChecked', { time: new Date(catalog.checkedAt).toLocaleString(document.documentElement.lang || 'en') }) : ''
    const sessions = catalog?.sessions ?? [], ids = new Set(sessions.map(x => x.sessionId))
    for (const [id, button] of keyed) if (!ids.has(id)) {
      if (button === document.activeElement) toggle.focus()
      button.remove(); keyed.delete(id)
    }
    for (const [index, session] of sessions.entries()) {
      let button = keyed.get(session.sessionId)
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.className = css.remoteSessionRow
        button.dataset.remoteSessionId = session.sessionId
        button.onclick = () => { if (!busy && !offline) open(session.sessionId) }
        keyed.set(session.sessionId, button)
      }
      const title = session.title || (session.blank ? tt('remote.newSessionTitle') : session.sessionId)
      const status = catalog?.stale ? tt('remote.unknown') : session.running ? tt('remote.sessionRunning') : ''
      const label = `${title}${status ? ` · ${status}` : ''}`
      if (button.textContent !== title) button.textContent = title
      button.setAttribute('aria-label', label)
      button.title = `${workspace.alias} · ${workspace.remotePath}\n${label}`
      button.disabled = busy || offline
      button.dataset.running = String(!catalog?.stale && session.running)
      if (selected?.workspaceId === workspace.id && selected.sessionId === session.sessionId) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
      if (entries.children[index] !== button) entries.insertBefore(button, entries.children[index] ?? null)
    }
  }
  const refresh = async () => {
    if (disposed || pending || offline || !expanded) return
    const controller = new AbortController(); pending = controller
    const deadline = setTimeout(() => controller.abort(), 10000)
    try {
      const response = await fetch(`/api/dsh-ssh/remote/sessions?id=${encodeURIComponent(workspace.id)}`, { cache: 'no-store', signal: controller.signal })
      if (!response.ok) throw new Error()
      const value = await response.json() as RemoteSessionCatalog
      controller.signal.throwIfAborted()
      if (!Array.isArray(value.sessions) || value.workspaceId !== workspace.workspaceId) throw new Error()
      if (!disposed) catalog = value
    } catch {
      if (!disposed && !offline) catalog = { ...(catalog ?? { workspaceId: workspace.workspaceId, sessions: [] }), stale: true, warning: 'unavailable' }
    } finally { clearTimeout(deadline); if (pending === controller) pending = undefined; if (!disposed) render() }
  }
  toggle.onclick = () => { expanded = !expanded; render(); if (expanded) void refresh() }
  create.onclick = () => { if (!busy && !offline) open(undefined, true) }
  const unsubscribe = subscribeRemoteSelection(render)
  render(); void refresh()
  return {
    node, refresh,
    update(nextBusy: boolean, nextOffline: boolean) {
      busy = nextBusy; offline = nextOffline
      if (offline) { pending?.abort(); if (catalog) catalog = { ...catalog, stale: true } }
      render()
    },
    dispose() { disposed = true; pending?.abort(); unsubscribe(); node.remove() },
  }
}
