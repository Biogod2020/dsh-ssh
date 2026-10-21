import type { RemoteWorkspace } from '../remote/types.ts'
import type { LocaleRefreshSource } from './sidebar-entry.ts'
import { gatewayUrl, registerRemotePresentation, selectRemoteView } from './remote-presentation.ts'
import { mountDesktopWorkspaceSeat, type DesktopShellContext } from './desktop-workspace-seat.tsx'
import { tt } from './panel/helpers.ts'
import css from './panel/panel.module.css'
import { remoteNavigation } from './remote-navigation.ts'

/** The shipped Desktop guest API; no Electron imports or private IPC channels. */
interface BrowserBridge {
  acquire(workspace: string): Promise<{ lease: string; partition: string }>
  release(lease: string): Promise<void>
  onOpenRequested(lease: string, listener: (url: string) => void): () => void
}
interface Guest extends HTMLElement {
  loadURL(url: string): Promise<void>
  executeJavaScript<T>(code: string): Promise<T>
}
interface View {
  workspace: RemoteWorkspace; sessionId?: string; guest: Guest; lease: string
  origin: string; ready: boolean; releaseLinks: () => void; focusTimer?: ReturnType<typeof setTimeout>
  cancel?: () => void
}

/** Keep complete remote clients in isolated Desktop guests inside this window. */
export function mountDesktopWorkspaces(locale?: LocaleRefreshSource, ctx?: DesktopShellContext): (() => void) | undefined {
  const bridge = (window as unknown as { dshDesktop?: { browser?: BrowserBridge } }).dshDesktop?.browser
  if (!bridge || typeof bridge.acquire !== 'function' || typeof bridge.release !== 'function' || typeof bridge.onOpenRequested !== 'function') return undefined
  const views = new Map<string, View>()
  const surface = document.createElement('section'); surface.dataset.dshRemoteDesktop = ''; surface.hidden = true
  surface.className = css.desktopWorkspace; surface.setAttribute('role', 'region')
  const toolbar = document.createElement('header'); toolbar.className = css.desktopWorkspaceToolbar
  const back = document.createElement('button'), close = document.createElement('button')
  back.type = close.type = 'button'; back.className = close.className = css.ghostButton
  const title = document.createElement('strong'); title.className = css.desktopWorkspaceTitle
  const host = document.createElement('div'); host.className = css.desktopWorkspaceBody
  const loading = document.createElement('div'); loading.className = css.desktopWorkspaceLoading; loading.setAttribute('role', 'status')
  toolbar.append(back, title, close); surface.append(toolbar, loading, host); document.body.append(surface)
  let active: View | undefined, disposed = false, opening = false
  const viewKey = (workspace: RemoteWorkspace) => workspace.hostId
  const identities = new Map<string, string>()
  const selected = () => selectRemoteView(!surface.hidden && active ? { workspaceId: active.workspace.id, sessionId: active.sessionId } : undefined)
  const seat = ctx ? mountDesktopWorkspaceSeat(ctx, (visible, bounds) => {
    surface.dataset.docked = 'true'
    if (bounds) Object.assign(surface.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px` })
    surface.hidden = !visible || !active; selected()
  }) : undefined
  let priorFocus: HTMLElement | null = null
  const inert = new Map<HTMLElement, boolean>()
  const isolate = () => {
    if (surface.hidden || seat) return
    for (const child of document.body.children) if (child instanceof HTMLElement && child !== surface && !inert.has(child)) {
      inert.set(child, child.inert); child.inert = true
    }
  }
  const observer = new MutationObserver(isolate); observer.observe(document.body, { childList: true })
  const render = () => {
    back.textContent = tt('remote.returnLocal'); close.textContent = tt('remote.closeView')
    title.textContent = active ? `${active.workspace.alias} · ${active.workspace.remotePath}` : ''
    surface.setAttribute('aria-label', tt('remote.desktopWorkspace'))
    loading.hidden = !active || active.ready
    loading.textContent = active ? `${active.workspace.title} · ${tt('remote.loadingConversation')}` : ''
    for (const view of views.values()) {
      view.guest.hidden = view !== active
      view.guest.style.display = view === active ? 'flex' : 'none'
      // A hidden WebContents suspends animation frames used by the native
      // renderer during boot. Cover it with the loading surface instead.
      view.guest.style.visibility = 'visible'
    }
  }
  const hide = () => {
    surface.hidden = true
    seat?.hide(); selected()
    for (const [child, value] of inert) child.inert = value
    inert.clear()
    if (priorFocus?.isConnected) priorFocus.focus()
  }
  const show = (view: View) => {
    if (surface.hidden) priorFocus = document.activeElement as HTMLElement | null
    active = view; surface.hidden = false; render(); seat?.select(); isolate(); selected()
    clearTimeout(view.focusTimer)
    view.focusTimer = setTimeout(() => { if (!disposed && !surface.hidden && active === view) view.guest.focus() }, 0)
  }
  const drop = (view: View) => {
    const key = viewKey(view.workspace)
    if (views.get(key) !== view) return
    view.cancel?.(); view.cancel = undefined
    clearTimeout(view.focusTimer); view.releaseLinks(); views.delete(key)
    view.guest.remove(); void bridge.release(view.lease).catch(() => {})
    if (active === view) { hide(); active = undefined }
  }
  back.onclick = hide
  close.onclick = () => { if (active && window.confirm(tt('remote.closeViewConfirm'))) drop(active) }
  const stopLocale = locale?.subscribe(render)
  const unregister = registerRemotePresentation({
    close(workspace) {
      const view = views.get(viewKey(workspace))
      if (view && window.confirm(tt('remote.closeViewConfirm'))) drop(view)
    },
    resume(workspace, sessionId) {
      if (identities.has(workspace.id) && identities.get(workspace.id) !== workspace.hostId) throw new Error(tt('remote.desktopIdentityChanged'))
      const view = views.get(viewKey(workspace))
      if (!view || !view.ready) return false
      if (view.workspace.id !== workspace.id || (sessionId && view.sessionId !== sessionId)) return false
      show(view); return true
    },
    async open(workspace, url, signal, sessionId) {
      signal?.throwIfAborted()
      const target = gatewayUrl(url)
      target.searchParams.set('dsh-remote-view', 'desktop')
      if (disposed || opening) throw new Error(tt('remote.desktopUnavailable'))
      const key = viewKey(workspace)
      const old = views.get(key)
      if (identities.has(workspace.id) && identities.get(workspace.id) !== workspace.hostId) throw new Error(tt('remote.desktopIdentityChanged'))
      identities.set(workspace.id, workspace.hostId)
      if (old?.ready) {
        // Backend open already checked Host and Workspace membership. Select
        // through the remote Client's ordinary public navigation service;
        // never navigate its document or recreate its conversation drafts.
        if (old.origin !== target.origin || !sessionId) throw new Error(tt('remote.desktopIdentityChanged'))
        try { await old.guest.executeJavaScript(`window.__dshSshView.open(${JSON.stringify(sessionId)})`) }
        catch { throw new Error(tt('remote.desktopLoadFailed')) }
        signal?.throwIfAborted()
        old.workspace = workspace; old.sessionId = sessionId
        old.guest.setAttribute('aria-label', `${workspace.alias} · ${workspace.remotePath}`)
        show(old); return
      }
      if (views.size >= 8) throw new Error(tt('remote.desktopViewLimit'))
      if (old) drop(old)
      opening = true
      let reservation: Awaited<ReturnType<BrowserBridge['acquire']>>
      try { reservation = await bridge.acquire(`dsh-ssh:${workspace.hostId}`) }
      finally { opening = false }
      if (disposed || signal?.aborted) {
        await bridge.release(reservation.lease)
        signal?.throwIfAborted(); throw new Error(tt('remote.desktopUnavailable'))
      }
      const guest = document.createElement('webview') as Guest
      guest.setAttribute('partition', reservation.partition); guest.setAttribute('name', reservation.lease)
      guest.setAttribute('data-sidebar-browser-frame', ''); guest.setAttribute('aria-label', `${workspace.alias} · ${workspace.remotePath}`)
      guest.className = css.desktopWorkspaceGuest
      const view: View = { workspace, sessionId, guest, lease: reservation.lease, origin: target.origin, ready: false, releaseLinks: () => {} }
      // No secondary window and no replacement of the retained conversation
      // document. Session switches use the native navigation service above.
      view.releaseLinks = bridge.onOpenRequested(view.lease, () => {})
      views.set(key, view); show(view)
      try {
        await new Promise<void>((resolve, reject) => {
          let loading = false, settled = false
          const finish = (cause?: Error) => {
            if (settled) return
            settled = true; clearTimeout(deadline); signal?.removeEventListener('abort', abort)
            guest.removeEventListener('dom-ready', ready); guest.removeEventListener('did-fail-load', failed)
            view.cancel = undefined
            if (cause) reject(cause); else resolve()
          }
          const abort = () => finish(new Error(tt('remote.desktopLoadFailed')))
          const ready = () => {
            if (loading || settled) return
            loading = true
            // The first document must be about:blank#lease so the Desktop
            // main process can authenticate guest ownership before navigation.
            void guest.loadURL(target.href).then(() => finish(), () => finish(new Error(tt('remote.desktopLoadFailed'))))
          }
          const failed = (event: Event) => {
            const failure = event as Event & { isMainFrame?: boolean; errorCode?: number }
            if (failure.isMainFrame && failure.errorCode !== -3) finish(new Error(tt('remote.desktopLoadFailed')))
          }
          const deadline = setTimeout(() => finish(new Error(tt('remote.desktopLoadFailed'))), 30000)
          view.cancel = abort
          signal?.addEventListener('abort', abort, { once: true })
          guest.addEventListener('dom-ready', ready); guest.addEventListener('did-fail-load', failed)
          guest.setAttribute('src', `about:blank#${view.lease}`); host.append(guest)
        })
        const deadline = Date.now() + 45000
        while (true) {
          signal?.throwIfAborted()
          if (disposed || !views.has(key)) throw new Error(tt('remote.desktopLoadFailed'))
          const ready = await guest.executeJavaScript<boolean>('Boolean(window.__dshSshView && document.querySelector("#root [class*=centerCol]"))')
          if (ready) break
          if (Date.now() > deadline) throw new Error(tt('remote.desktopLoadFailed'))
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        view.ready = true; render()
        guest.addEventListener('render-process-gone', () => { view.ready = false; render(); loading.textContent = tt('remote.desktopLoadFailed') })
      } catch (cause) { drop(view); throw cause }
    },
  })
  let checking = false
  const syncSelection = async () => {
    const view = active
    if (checking || disposed || surface.hidden || !view?.ready) return
    checking = true
    try {
      const state = await view.guest.executeJavaScript<{ sessionId?: string; workspaceId?: string }>('window.__dshSshView.state()')
      if (disposed || active !== view || surface.hidden || !state?.sessionId) return
      const workspace = remoteNavigation.getSnapshot().workspaces.find(item => item.hostId === view.workspace.hostId && item.workspaceId === state.workspaceId)
      if (!workspace || (view.workspace.id === workspace.id && view.sessionId === state.sessionId)) return
      view.workspace = workspace; view.sessionId = state.sessionId; selected(); void remoteNavigation.refresh(workspace)
    } catch { /* A carrier/page failure is shown by its normal reconnect UI. */ }
    finally { checking = false }
  }
  const selectionTimer = setInterval(() => { void syncSelection() }, 1000)
  render()
  return () => {
    if (disposed) return
    disposed = true; clearInterval(selectionTimer); unregister(); observer.disconnect(); stopLocale?.()
    for (const view of [...views.values()]) drop(view)
    hide(); seat?.dispose(); selectRemoteView(); surface.remove()
  }
}
