import type { RemoteWorkspace } from '../remote/types.ts'
import type { LocaleRefreshSource } from './sidebar-entry.ts'
import { gatewayUrl, registerRemotePresentation } from './remote-presentation.ts'
import { tt } from './panel/helpers.ts'
import css from './panel/panel.module.css'

/** The shipped Desktop guest API; no Electron imports or private IPC channels. */
interface BrowserBridge {
  acquire(workspace: string): Promise<{ lease: string; partition: string }>
  release(lease: string): Promise<void>
  onOpenRequested(lease: string, listener: (url: string) => void): () => void
}
interface Guest extends HTMLElement {
  loadURL(url: string): Promise<void>
}
interface View {
  workspace: RemoteWorkspace; sessionId?: string; guest: Guest; lease: string
  origin: string; ready: boolean; releaseLinks: () => void; focusTimer?: ReturnType<typeof setTimeout>
  cancel?: () => void
}

/** Keep complete remote clients in isolated Desktop guests inside this window. */
export function mountDesktopWorkspaces(locale?: LocaleRefreshSource): (() => void) | undefined {
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
  toolbar.append(back, title, close); surface.append(toolbar, host); document.body.append(surface)
  let active: View | undefined, disposed = false, opening = false
  let priorFocus: HTMLElement | null = null
  const inert = new Map<HTMLElement, boolean>()
  const isolate = () => {
    if (surface.hidden) return
    for (const child of document.body.children) if (child instanceof HTMLElement && child !== surface && !inert.has(child)) {
      inert.set(child, child.inert); child.inert = true
    }
  }
  const observer = new MutationObserver(isolate); observer.observe(document.body, { childList: true })
  const render = () => {
    back.textContent = tt('remote.returnLocal'); close.textContent = tt('remote.closeView')
    title.textContent = active ? `${active.workspace.alias} · ${active.workspace.remotePath}` : ''
    surface.setAttribute('aria-label', tt('remote.desktopWorkspace'))
    for (const view of views.values()) {
      view.guest.hidden = view !== active
      view.guest.style.display = view === active ? 'flex' : 'none'
    }
  }
  const hide = () => {
    surface.hidden = true
    for (const [child, value] of inert) child.inert = value
    inert.clear()
    if (priorFocus?.isConnected) priorFocus.focus()
  }
  const show = (view: View) => {
    if (surface.hidden) priorFocus = document.activeElement as HTMLElement | null
    active = view; surface.hidden = false; render(); isolate()
    clearTimeout(view.focusTimer)
    view.focusTimer = setTimeout(() => { if (!disposed && !surface.hidden && active === view) view.guest.focus() }, 0)
  }
  const drop = (view: View) => {
    if (views.get(view.workspace.id) !== view) return
    view.cancel?.(); view.cancel = undefined
    clearTimeout(view.focusTimer); view.releaseLinks(); views.delete(view.workspace.id)
    view.guest.remove(); void bridge.release(view.lease).catch(() => {})
    if (active === view) { hide(); active = undefined }
  }
  back.onclick = hide
  close.onclick = () => { if (active && window.confirm(tt('remote.closeViewConfirm'))) drop(active) }
  const stopLocale = locale?.subscribe(render)
  const unregister = registerRemotePresentation({
    resume(workspace, sessionId) {
      const view = views.get(workspace.id)
      if (!view || !view.ready) return false
      if (view.workspace.hostId !== workspace.hostId) throw new Error(tt('remote.desktopIdentityChanged'))
      if (sessionId && view.sessionId !== sessionId) throw new Error(tt('remote.desktopSessionOpen'))
      show(view); return true
    },
    async open(workspace, url, signal, sessionId) {
      signal?.throwIfAborted()
      const target = gatewayUrl(url)
      target.searchParams.set('dsh-remote-view', 'desktop')
      if (disposed || opening) throw new Error(tt('remote.desktopUnavailable'))
      if (views.size >= 8) throw new Error(tt('remote.desktopViewLimit'))
      const old = views.get(workspace.id)
      if (old?.ready) throw new Error(tt('remote.desktopSessionOpen'))
      if (old) drop(old)
      opening = true
      let reservation: Awaited<ReturnType<BrowserBridge['acquire']>>
      try { reservation = await bridge.acquire(`dsh-ssh:${workspace.hostId}:${workspace.id}`) }
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
      // New-window requests stay in this guest only for this gateway. Other
      // origins are left unopened; never silently launch a system browser.
      view.releaseLinks = bridge.onOpenRequested(view.lease, value => {
        try { if (view.ready && new URL(value).origin === view.origin) void guest.loadURL(value).catch(() => {}) } catch {}
      })
      views.set(workspace.id, view); show(view)
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
        view.ready = true
        guest.addEventListener('render-process-gone', () => { view.ready = false; title.textContent = tt('remote.desktopLoadFailed') })
      } catch (cause) { drop(view); throw cause }
    },
  })
  render()
  return () => {
    if (disposed) return
    disposed = true; unregister(); observer.disconnect(); stopLocale?.()
    for (const view of [...views.values()]) drop(view)
    hide(); surface.remove()
  }
}
