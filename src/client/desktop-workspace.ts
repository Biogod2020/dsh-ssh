import type { RemoteWorkspace } from '../remote/types.ts'
import type { LocaleRefreshSource } from './sidebar-entry.ts'
import { gatewayUrl, registerRemotePresentation, selectRemoteView } from './remote-presentation.ts'
import { mountDesktopWorkspaceSeat, type DesktopShellContext } from './desktop-workspace-seat.tsx'
import { tt } from './panel/helpers.ts'
import css from './panel/panel.module.css'
import { remoteNavigation } from './remote-navigation.ts'
import { readHistoryCopy, renderSavedHistory } from './history-cache.ts'
import { createWebGuest } from './web-guest.ts'
import { remoteErrorView } from './remote-errors.ts'

/** The shipped Desktop guest API; no Electron imports or private IPC channels. */
interface BrowserBridge {
  acquire(workspace: string): Promise<{ lease: string; partition: string }>
  release(lease: string): Promise<void>
  onOpenRequested(lease: string, listener: (url: string) => void): () => void
}
interface Guest extends HTMLElement {
  loadURL(url: string): Promise<void>
  executeJavaScript<T>(code: string): Promise<T>
  control?<T>(method:string,args?:unknown[]):Promise<T>
  disposeControl?():void
}
interface View {
  workspace: RemoteWorkspace; sessionId?: string; guest: Guest; lease: string
  origin: string; ready: boolean; releaseLinks: () => void; focusTimer?: ReturnType<typeof setTimeout>
  cancel?: () => void
  usedAt:number; releasing?:Promise<boolean>; visibility?:boolean
}

function control<T>(view:View, method:string, ...args:unknown[]):Promise<T> {
  if(view.guest.control)return view.guest.control<T>(method,args)
  const scripts:Record<string,string>={
    ready:'Boolean(window.__dshSshView && document.querySelector("#root [class*=centerCol]"))',
    state:'window.__dshSshView.state()', inspect:'window.__dshSshView.inspection()',
    flush:'(async()=>{window.__dshSshView?.cancelNavigation?.();return window.__dshSshDrafts?await window.__dshSshDrafts.flush():true})()',
    recovery:'Boolean(window.__dshSshDrafts?.openRecovery?.())', settings:'Boolean(window.__dshSshView?.settings?.())',
    open:`window.__dshSshView.open(${JSON.stringify(args[0])})`,
    select:`(async()=>Boolean(await window.__dshSshView?.select?.(${JSON.stringify(args[0])},${JSON.stringify(args[1])})))()`,
  }
  return view.guest.executeJavaScript<T>(scripts[method] ?? `window.__dshSshRelease.command(${JSON.stringify(method)},${JSON.stringify(args)})`)
}

/** Keep complete remote clients in isolated Desktop guests inside this window. */
export function mountDesktopWorkspaces(locale?: LocaleRefreshSource, ctx?: DesktopShellContext): (() => void) | undefined {
  const desktopBridge = (window as unknown as { dshDesktop?: { browser?: BrowserBridge } }).dshDesktop?.browser
  // Use the same ownership/pool policy in real dsh web, with isolated origins
  // and typed postMessage commands instead of Electron APIs.
  const web = !desktopBridge && !!ctx && location.protocol === 'http:'
  const bridge:BrowserBridge|undefined = desktopBridge ?? (web ? {
    acquire:async()=>({lease:crypto.randomUUID(),partition:''}),release:async()=>{},onOpenRequested:()=>()=>{},
  }:undefined)
  if (!bridge || typeof bridge.acquire !== 'function' || typeof bridge.release !== 'function' || typeof bridge.onOpenRequested !== 'function') return undefined
  const views = new Map<string, View>()
  const surface = document.createElement('section'); surface.dataset.dshRemoteDesktop = ''; surface.hidden = true
  surface.className = css.desktopWorkspace; surface.setAttribute('role', 'region')
  const toolbar = document.createElement('header'); toolbar.className = css.desktopWorkspaceToolbar
  const back = document.createElement('button'), close = document.createElement('button')
  const reclaim = document.createElement('button');reclaim.type='button';reclaim.className=css.ghostButton
  const poolStatus=document.createElement('p');poolStatus.className=css.desktopPoolStatus;poolStatus.setAttribute('role','status');poolStatus.hidden=true
  back.type = close.type = 'button'; back.className = close.className = css.ghostButton
  const title = document.createElement('strong'); title.className = css.desktopWorkspaceTitle
  const host = document.createElement('div'); host.className = css.desktopWorkspaceBody
  const loading = document.createElement('div'); loading.className = css.desktopWorkspaceLoading; loading.setAttribute('role', 'status')
  const saved = document.createElement('div'); saved.className = css.desktopHistory; saved.hidden = true
  const viewport = document.createElement('div'); viewport.className = css.desktopWorkspaceViewport; viewport.append(host, loading, saved)
  toolbar.append(back, title, reclaim, close); surface.append(toolbar,poolStatus,viewport); document.body.append(surface)
  let active: View | undefined, disposed = false, opening = false, suspended = false
  let preview: { workspace: RemoteWorkspace; sessionId: string } | undefined, previewEpoch = 0
  let pendingPreview: typeof preview
  const previewFailures = new Map<string, string>()
  const savedStatus = document.createElement('p'); savedStatus.className = css.hint
  const resumeSaved = document.createElement('button'); resumeSaved.type = 'button'; resumeSaved.className = css.ghostButton
  resumeSaved.onclick = () => { const target = preview; if (target) remoteNavigation.open(target.workspace, target.sessionId) }
  const viewKey = (workspace: RemoteWorkspace) => workspace.hostId
  const identities = new Map<string, string>()
  const selected = () => { const value = preview ?? active; selectRemoteView(!surface.hidden && value ? { workspaceId: value.workspace.id, sessionId: value.sessionId } : undefined) }
  const seat = ctx ? mountDesktopWorkspaceSeat(ctx, (visible, bounds) => {
    surface.dataset.docked = 'true'
    if (bounds) Object.assign(surface.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px` })
    surface.hidden = !visible || (!active && !preview); selected()
    queueMicrotask(()=>{if(!disposed)render()})
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
    reviewDraft.textContent = tt('remote.reviewUnsavedDraft')
    reclaim.textContent=tt('remote.reclaimViews')
    resumeSaved.textContent = tt('cache.resumeLive')
    const value = preview ?? active
    title.textContent = value ? `${value.workspace.alias} · ${value.workspace.remotePath}` : ''
    surface.setAttribute('aria-label', tt('remote.desktopWorkspace'))
    loading.hidden = !!preview || !active || active.ready
    // Cover the live guest without removing it from layout: native clients
    // may need animation frames to finish booting behind the saved history.
    saved.hidden = !preview
    loading.textContent = active ? `${active.workspace.title} · ${tt('remote.loadingConversation')}` : ''
    for (const view of views.values()) {
      view.guest.hidden = view !== active
      view.guest.style.display = view === active ? 'flex' : 'none'
      // A hidden WebContents suspends animation frames used by the native
      // renderer during boot. Cover it with the loading surface instead.
      view.guest.style.visibility = 'visible'
      view.guest.inert = view !== active || surface.hidden || !!preview
      const visible = !view.guest.inert
      if(view.ready && view.visibility!==visible){if(view.visibility===true&&!visible)view.usedAt=Date.now();view.visibility=visible;void control(view,'visible',visible).catch(()=>{})}
    }
  }
  const hide = () => {
    ++previewEpoch; preview = pendingPreview = undefined; saved.replaceChildren()
    surface.hidden = true
    seat?.hide(); selected()
    render()
    for (const [child, value] of inert) child.inert = value
    inert.clear()
    if (priorFocus?.isConnected) priorFocus.focus()
  }
  const show = (view: View) => {
    const candidate = pendingPreview ?? preview
    if (view.ready || candidate?.workspace.id !== view.workspace.id || candidate.workspace.hostId !== view.workspace.hostId
      || candidate.workspace.workspaceId !== view.workspace.workspaceId || candidate.sessionId !== view.sessionId) {
      ++previewEpoch; preview = pendingPreview = undefined; saved.replaceChildren()
    }
    if (surface.hidden) priorFocus = document.activeElement as HTMLElement | null
    active = view; view.usedAt=Date.now();surface.hidden = false; render(); seat?.select(); isolate(); selected()
    clearTimeout(view.focusTimer)
    view.focusTimer = setTimeout(() => { if (!disposed && !surface.hidden && active === view) view.guest.focus() }, 0)
  }
  const drop = (view: View) => {
    const key = viewKey(view.workspace)
    if (views.get(key) !== view) return
    view.cancel?.(); view.cancel = undefined
    clearTimeout(view.focusTimer); view.releaseLinks(); views.delete(key)
    view.guest.remove(); view.guest.disposeControl?.();void bridge.release(view.lease).catch(() => {})
    if (active === view) { active = undefined; if (preview) { render(); selected() } else hide() }
  }
  let sweeping=false
  const visible = (view:View) => active===view&&!surface.hidden&&!preview
  async function sweep(force=false,reserve=0):Promise<void>{
    if(disposed||sweeping)return
    sweeping=true
    let released=0,protectedViews=0
    try{
      const samples=new Map<View,number>()
      for(const view of views.values())if(view.ready)try{
        const sample=await control<any>(view,'inspect'),bytes=sample?.memory?.bytes
        if(Number.isSafeInteger(bytes)&&bytes>0)samples.set(view,bytes)
      }catch{/* Unknown memory still has a bounded warm-view policy. */}
      for(const view of [...views.values()].sort((a,b)=>a.usedAt-b.usedAt)){
        if(disposed)break
        const overBudget=[...samples.values()].reduce((a,b)=>a+b,0)>512*1024*1024
        if(!force&&views.size+reserve<=3&&!overBudget&&Date.now()-view.usedAt<5*60000)continue
        if(!view.ready||visible(view)||view.releasing)continue
        const owner=view.usedAt
        view.releasing=(async()=>{
          let token:string|undefined
          try{
            const prepared=await control<{token?:string}|null>(view,'prepareRelease');token=prepared?.token
            if(!token)surface.dataset.reclaimBlocked=String(await control(view,'releaseReason'))
            if(!token||disposed||visible(view)||view.usedAt!==owner||views.get(viewKey(view.workspace))!==view)return false
            if(!await control<boolean>(view,'commitRelease',token))return false
            // A successful commit is irreversible. Navigation waits for this
            // Promise and will reopen from disk after this exact owner drops.
            drop(view);samples.delete(view);return true
          }catch{return false}
          finally{if(views.get(viewKey(view.workspace))===view)await control(view,'cancelRelease').catch(()=>{})}
        })()
        if(await view.releasing)released++;else protectedViews++
        view.releasing=undefined
      }
      if(force||released){poolStatus.hidden=false;poolStatus.textContent=tt('remote.reclaimedViews',{count:released,protected:protectedViews})}
    }finally{sweeping=false}
  }
  reclaim.onclick=()=>{reclaim.disabled=true;void sweep(true).finally(()=>{reclaim.disabled=false})}
  const poolTimer=setInterval(()=>{void sweep()},30000)
  const draftNotice = document.createElement('p'); draftNotice.className = css.hint; draftNotice.setAttribute('role', 'alert'); draftNotice.hidden = true
  const draftMessage = document.createElement('span'), reviewDraft = document.createElement('button'); reviewDraft.type = 'button'; reviewDraft.className = css.ghostButton
  draftNotice.append(draftMessage, reviewDraft); toolbar.after(draftNotice)
  reviewDraft.onclick = () => {
    const view = active
    if (!view?.ready || !view.guest.isConnected || reviewDraft.disabled) return
    reviewDraft.disabled = true
    void control<boolean>(view,'recovery').then(opened => {
      if (!opened && !disposed && active === view && views.get(viewKey(view.workspace)) === view) {
        draftMessage.textContent = tt('remote.reviewCurrentDraft'); view.guest.focus()
      }
    }).catch(() => {
      if (!disposed && active === view && views.get(viewKey(view.workspace)) === view) draftMessage.textContent = tt('remote.draftRecoveryUnavailable')
    })
      .finally(() => { reviewDraft.disabled = false })
  }
  const draftError = () => Object.assign(new Error(tt('remote.unsavedDraft')), { name: 'DraftSaveError' })
  async function flushView(view: View | undefined): Promise<void> {
    if (!view?.ready || !view.guest.isConnected) return
    try {
      const saved = await control<boolean>(view,'flush')
      if(saved===false)throw draftError()
      draftNotice.hidden = true
    } catch {
      if(!view.ready)return
      draftMessage.textContent = tt('remote.unsavedDraft'); draftNotice.hidden = false; throw draftError()
    }
  }
  back.onclick = () => {
    remoteNavigation.cancelOpen();const intent=remoteNavigation.intent()
    void flushView(active).then(()=>{if(!disposed&&intent===remoteNavigation.intent())hide()}).catch(()=>{})
  }
  close.onclick = () => {
    if(preview){hide();return}
    const view=active
    if(view&&window.confirm(tt('remote.closeViewConfirm'))){
      remoteNavigation.cancelOpen();const intent=remoteNavigation.intent()
      void flushView(view).then(()=>{if(!disposed&&intent===remoteNavigation.intent())drop(view)}).catch(()=>{})
    }
  }
  const stopLocale = locale?.subscribe(render)
  const unregister = registerRemotePresentation({
    suspend() { suspended = true; hide(); unregister() },
    reclaim:()=>sweep(true),
    beforeLeave: () => flushView(active),
    async archived(workspace, sessionId) {
      const matches = () => {
        const value = preview ?? active
        return !disposed && !surface.hidden && value?.workspace.id === workspace.id
          && value.workspace.hostId === workspace.hostId && value.workspace.workspaceId === workspace.workspaceId
          && value.sessionId === sessionId
      }
      if (!matches()) return
      const intent = remoteNavigation.intent()
      await flushView(active)
      // Archive has already committed. Clear only its selected surface; keep
      // the Host guest and its other work alive, and never interrupt a new selection.
      if (matches() && intent === remoteNavigation.intent()) hide()
    },
    async settings(workspace) {
      if (suspended) return false
      const view=views.get(viewKey(workspace))
      if(view?.releasing)await view.releasing
      if(disposed||!view?.ready||view.workspace.hostId!==workspace.hostId||identities.get(view.workspace.id)!==workspace.hostId)return false
      remoteNavigation.cancelOpen()
      const intent=remoteNavigation.intent()
      if(view!==active)await flushView(active)
      if(disposed||views.get(viewKey(workspace))!==view||intent!==remoteNavigation.intent())return false
      show(view)
      try{return await control<boolean>(view,'settings')}
      catch{return false}
    },
    async preview(workspace, sessionId, signal) {
      if (suspended) return
      const epoch = ++previewEpoch
      pendingPreview = { workspace, sessionId }
      previewFailures.delete(workspace.id)
      const copy = await readHistoryCopy(workspace, sessionId, signal)
      if (!copy || disposed || epoch !== previewEpoch || signal?.aborted) return
      if (copy.meta.hostId !== workspace.hostId || copy.meta.workspaceId !== workspace.workspaceId || copy.meta.sessionId !== sessionId) return
      if (surface.hidden) priorFocus = document.activeElement as HTMLElement | null
      preview = pendingPreview; pendingPreview = undefined; saved.replaceChildren(renderSavedHistory(copy))
      savedStatus.textContent = previewFailures.get(workspace.id) ?? tt('cache.reconnecting'); saved.prepend(savedStatus, resumeSaved)
      surface.hidden = false; render(); seat?.select(); isolate(); selected()
    },
    previewFailed(workspace, error) {
      const message = error === undefined ? tt('cache.unavailable') : tt('cache.reconnectFailed', { reason: remoteErrorView(error).summary })
      previewFailures.set(workspace.id, message)
      if (preview?.workspace.id === workspace.id) savedStatus.textContent = message
    },
    async close(workspace) {
      const view = views.get(viewKey(workspace))
      if(view?.releasing){await view.releasing;if(views.get(viewKey(workspace))!==view)return}
      if (view && window.confirm(tt('remote.closeViewConfirm'))) {
        if(view===active)remoteNavigation.cancelOpen()
        const intent=remoteNavigation.intent()
        await flushView(view); if(!disposed&&intent===remoteNavigation.intent())drop(view)
      }
    },
    async resume(workspace, sessionId, signal) {
      if (suspended) return false
      signal?.throwIfAborted()
      if (identities.has(workspace.id) && identities.get(workspace.id) !== workspace.hostId) throw new Error(tt('remote.desktopIdentityChanged'))
      const view = views.get(viewKey(workspace))
      if(view?.releasing){await view.releasing;signal?.throwIfAborted();if(views.get(viewKey(workspace))!==view)return false}
      if (!view || !view.ready) return false
      if(view!==active||view.workspace.id!==workspace.id||sessionId&&view.sessionId!==sessionId)await flushView(active)
      signal?.throwIfAborted()
      // The remote shell may clear its own selection after archiving. Its
      // current selection, not our last-opened metadata, owns this decision.
      if (view.workspace.id !== workspace.id || sessionId) {
        if (!sessionId) return false
        let accepted = false
        try {
          accepted = await control<boolean>(view,'select',workspace.workspaceId,sessionId)
        } catch(error) { if(String(error).includes('DSH_DRAFT_UNSAVED'))throw draftError();return false }
        signal?.throwIfAborted()
        if (!accepted || disposed || views.get(viewKey(workspace)) !== view || !view.ready) return false
        identities.set(workspace.id, workspace.hostId)
        view.workspace = workspace; view.sessionId = sessionId
        view.guest.setAttribute('aria-label', `${workspace.alias} · ${workspace.remotePath}`)
      }
      signal?.throwIfAborted();show(view); return true
    },
    async open(workspace, url, signal, sessionId) {
      signal?.throwIfAborted()
      const target = gatewayUrl(url)
      target.searchParams.set('dsh-remote-view', 'desktop')
      await flushView(active); signal?.throwIfAborted()
      if (disposed || opening || suspended) throw new Error(tt('remote.desktopUnavailable'))
      const key = viewKey(workspace)
      const old = views.get(key)
      if (identities.has(workspace.id) && identities.get(workspace.id) !== workspace.hostId) throw new Error(tt('remote.desktopIdentityChanged'))
      identities.set(workspace.id, workspace.hostId)
      if (old?.ready) {
        // Backend open already checked Host and Workspace membership. Select
        // through the remote Client's ordinary public navigation service;
        // never navigate its document or recreate its conversation drafts.
        if (old.origin !== target.origin || !sessionId) throw new Error(tt('remote.desktopIdentityChanged'))
        try { if(await control(old,'open',sessionId)===false)throw new Error('Navigation superseded') }
        catch(error) { if(String(error).includes('DSH_DRAFT_UNSAVED'))throw draftError();throw new Error(tt('remote.desktopLoadFailed')) }
        signal?.throwIfAborted()
        old.workspace = workspace; old.sessionId = sessionId
        old.guest.setAttribute('aria-label', `${workspace.alias} · ${workspace.remotePath}`)
        show(old); return
      }
      if(views.size>=3)await sweep(false,1)
      signal?.throwIfAborted()
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
      const guest = (web ? createWebGuest() : document.createElement('webview')) as Guest
      guest.setAttribute('partition', reservation.partition); guest.setAttribute('name', reservation.lease)
      guest.setAttribute('data-sidebar-browser-frame', ''); guest.setAttribute('aria-label', `${workspace.alias} · ${workspace.remotePath}`)
      guest.className = css.desktopWorkspaceGuest
      const view: View = { workspace, sessionId, guest, lease: reservation.lease, origin: target.origin, ready: false, releaseLinks: () => {},usedAt:Date.now() }
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
          const deadline = setTimeout(() => finish(new Error(tt('remote.desktopPageTimedOut'))), 120000)
          view.cancel = abort
          signal?.addEventListener('abort', abort, { once: true })
          guest.addEventListener('dom-ready', ready); guest.addEventListener('did-fail-load', failed)
          if (web) {
            // Web iframes have no Desktop lease handshake. Assign their real
            // destination before attachment, so an initial blank navigation
            // cannot race and cancel the cross-origin document navigation.
            ready(); host.append(guest)
          } else {
            guest.setAttribute('src', `about:blank#${view.lease}`); host.append(guest)
          }
        })
        const deadline = Date.now() + 120000
        while (true) {
          signal?.throwIfAborted()
          if (disposed || !views.has(key)) throw new Error(tt('remote.desktopLoadFailed'))
          const ready = await control<boolean>(view,'ready')
          if (ready) break
          if (Date.now() > deadline) throw new Error(tt('remote.desktopClientTimedOut'))
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        view.ready = true; show(view)
        void sweep()
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
      const state = await control<{ sessionId?: string; workspaceId?: string }>(view,'state')
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
    disposed = true; clearInterval(selectionTimer);clearInterval(poolTimer);unregister(); observer.disconnect(); stopLocale?.()
    for (const view of [...views.values()]) drop(view)
    hide(); seat?.dispose(); selectRemoteView(); surface.remove()
  }
}
