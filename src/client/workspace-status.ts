import type { SshApi } from './api.ts'
import type { ConnectionState, ConnectionStatus } from '../protocol.ts'
import type { SshWorkspace } from '../workspaces.ts'
import { subscribeBodyInvalidations } from './body-mutations.ts'
import { tt } from './panel/helpers.ts'
import css from './panel/panel.module.css'
import type { LocaleRefreshSource } from './sidebar-entry.ts'
import { remoteNavigation, resolveRemoteNavigation } from './remote-navigation.ts'

/** Native rows have no extension slot yet. Add only an owned, non-interactive dot. */
export function mountWorkspaceStatus(api: SshApi, locale?: LocaleRefreshSource): () => void {
  let workspaces: SshWorkspace[] = []
  let statuses: ConnectionStatus[] = []
  let stale = true
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let polling = false
  const dots = new Set<HTMLElement>()
  const render = (): void => {
    if (disposed) return
    const seen = new Set<HTMLElement>()
    for (const row of document.querySelectorAll<HTMLElement>('[data-pane="sidebar"] [role="treeitem"][class*="projectRow"], [class*="sidebarCol"] [role="treeitem"][class*="projectRow"]')) {
      const key = row.getAttribute('data-row-key')
      const remote = key?.startsWith('workspace:') ? resolveRemoteNavigation(key.slice('workspace:'.length))?.workspace : undefined
      const title = row.querySelector('[class*="projectText"] [class*="title"]')?.textContent
      const matches = workspaces.filter(item => item.title === title)
      if (!remote && !matches.length) continue
      const aliases = new Set(matches.map(item => item.alias))
      const workspace = remote ?? matches[0]
      const phase = remote && remoteNavigation.getSnapshot().hosts?.get(remote.hostId)
      const state: ConnectionState | 'unknown' = remote
        ? stale || !phase ? 'unknown' : phase === 'ready' ? 'connected' : phase === 'failed' ? 'failed' : phase === 'disconnected' ? 'disconnected' : 'connecting'
        : stale || aliases.size !== 1 ? 'unknown' : statuses.find(item => item.alias === workspace.alias)?.state ?? 'disconnected'
      let dot = row.querySelector<HTMLElement>('[data-dsh-ssh-status]')
      if (!dot) {
        dot = document.createElement('span')
        dot.className = css.workspaceDot
        dot.setAttribute('data-dsh-ssh-status', '')
        dot.setAttribute('role', 'img')
        row.querySelector('[class*="projectText"]')?.before(dot)
        dots.add(dot)
      }
      dot.dataset.state = state
      const label = tt(`workspace.status.${state}`)
      dot.setAttribute('aria-label', label)
      dot.title = `${workspace.alias}: ${label}`
      seen.add(dot)
    }
    for (const dot of dots) if (!seen.has(dot)) { dot.remove(); dots.delete(dot) }
  }
  const poll = async (): Promise<void> => {
    if (disposed || polling || document.visibilityState === 'hidden') return
    polling = true
    try {
      const result = await Promise.all([api.listWorkspaces(), api.connectionStatus()])
      if (disposed) return
      ;[workspaces, statuses] = result
      stale = false
    } catch { stale = true }
    finally {
      polling = false
      if (!disposed) { render(); timer = setTimeout(() => { void poll() }, 5000) }
    }
  }
  const onVisibility = (): void => {
    clearTimeout(timer)
    // Never leave a green lamp frozen across sleep/offline/resume.
    stale = true; render()
    if (document.visibilityState !== 'hidden') void poll()
  }
  const stopObserve = subscribeBodyInvalidations(render)
  const stopNavigation = remoteNavigation.subscribe(render)
  const stopLocale = locale?.subscribe(render)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('offline', onVisibility)
  window.addEventListener('online', onVisibility)
  void poll()
  return () => {
    disposed = true; clearTimeout(timer); stopObserve(); stopLocale?.(); stopNavigation()
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('offline', onVisibility); window.removeEventListener('online', onVisibility)
    for (const dot of dots) dot.remove()
  }
}
