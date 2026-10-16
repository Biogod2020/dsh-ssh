import type { RemoteOperation, RemoteWorkspace, RemotePhase } from '../remote/types.ts'
import { subscribeBodyInvalidations } from './body-mutations.ts'
import { tt } from './panel/helpers.ts'
import { RemoteRequestError, remoteErrorView } from './remote-errors.ts'
import type { LocaleRefreshSource } from './sidebar-entry.ts'
import css from './panel/panel.module.css'
import { gatewayUrl, remotePresentation } from './remote-presentation.ts'

const base = '/api/dsh-ssh/remote/'
interface RequestOptions { signal?: AbortSignal; expectedHostId?: string }
type Progress = (message: string, operation: RemoteOperation) => void
const activityEvent = 'dsh-ssh-operations-changed'
const announceActivity = () => window.dispatchEvent(new Event(activityEvent))
export function remoteProgress(operation: RemoteOperation): string {
  return operation.phase === 'failed' ? operation.message : tt(`remote.phase.${operation.phase}`)
}
async function json<T>(path: string, body?: object, options: RequestOptions = {}): Promise<T> {
  options.signal?.throwIfAborted()
  const controller = new AbortController(), abort = () => controller.abort(options.signal!.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  const deadline = body ? undefined : setTimeout(() => controller.abort(new Error(tt('remote.checkTimedOut'))), 15000)
  try {
    const response = await fetch(base + path, {
      ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' }),
      signal: controller.signal,
    })
    const value = await response.json() as T & { error?: string; errorCode?: string }
    controller.signal.throwIfAborted()
    if (!response.ok) throw new RemoteRequestError(value.error ?? tt('remote.requestFailed'), value.errorCode)
    return value
  } finally { clearTimeout(deadline); options.signal?.removeEventListener('abort', abort) }
}
function wait(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const abort = () => { clearTimeout(timer); reject(signal!.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, 1000)
    signal?.addEventListener('abort', abort, { once: true })
  })
}
async function waitForOperation(operation: RemoteOperation, progress: Progress, options: RequestOptions = {}): Promise<RemoteWorkspace> {
  for (;;) {
    options.signal?.throwIfAborted()
    progress(remoteProgress(operation), operation)
    if (operation.phase === 'failed') throw new RemoteRequestError(operation.message, operation.errorCode)
    if (operation.phase === 'ready' && operation.workspace) return operation.workspace
    await wait(options.signal)
    ;({ operation } = await json<{ operation: RemoteOperation }>('operation?id=' + encodeURIComponent(operation.id), undefined, options))
  }
}
/** Aborting stops this page's observation. Remote installation/startup is retained, never replayed. */
export async function connectRemoteWorkspace(alias: string, remotePath: string, progress: Progress, options: RequestOptions = {}): Promise<RemoteWorkspace> {
  try {
    const { operation } = await json<{ operation: RemoteOperation }>('connect', { alias, remotePath,
      ...(options.expectedHostId ? { expectedHostId: options.expectedHostId } : {}) }, options)
    announceActivity()
    return await waitForOperation(operation, progress, options)
  } finally { announceActivity() }
}
/** Observes an existing receipt. It never starts or retries setup. */
export async function observeRemoteOperation(id: string, progress: Progress, options: RequestOptions = {}): Promise<RemoteWorkspace> {
  const { operation } = await json<{ operation: RemoteOperation }>('operation?id=' + encodeURIComponent(id), undefined, options)
  return waitForOperation(operation, progress, options)
}
export async function openRemoteWorkspace(workspace: RemoteWorkspace, sessionId?: string, options: RequestOptions = {}): Promise<void> {
  options.signal?.throwIfAborted()
  const presentation = remotePresentation()
  if (presentation?.resume(workspace, sessionId)) return
  if (window.location.protocol === 'dsh-app:' && !presentation) throw new Error(tt('remote.desktopUnavailable'))
  const { url } = await json<{ url: string }>('open', { id: workspace.id, ...(sessionId ? { sessionId } : {}) }, options)
  gatewayUrl(url)
  options.signal?.throwIfAborted()
  if (presentation) await presentation.open(workspace, url, options.signal, sessionId)
  else window.location.assign(url)
}
interface RecoveryLink { hostId: string; proof: string; sessionId?: string }
function recoveryFromHash(): RecoveryLink | undefined {
  const raw = new URLSearchParams(window.location.hash.slice(1)).get('dsh-ssh-recover')
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as Partial<RecoveryLink>
    if (!/^[a-f0-9]{24}$/.test(value.hostId ?? '') || !/^[a-f0-9]{64}$/.test(value.proof ?? '')) return undefined
    return { hostId: value.hostId!, proof: value.proof!,
      sessionId: typeof value.sessionId === 'string' && value.sessionId.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value.sessionId) ? value.sessionId : undefined }
  } catch { return undefined }
}
const text = (node: HTMLElement, value: string) => { if (node.textContent !== value) node.textContent = value }

/** A dedicated remote list carries Host + path identities. Its keyed rows preserve keyboard focus. */
export function mountRemoteWorkspaces(locale?: LocaleRefreshSource): () => void {
  const section = document.createElement('section'); section.dataset.dshRemoteWorkspaces = ''; section.className = css.remoteWorkspaceList
  const heading = document.createElement('div'); heading.className = css.remoteWorkspaceHeading; heading.tabIndex = -1
  const headingLabel = document.createElement('span')
  const historyButton = document.createElement('button'); historyButton.type = 'button'; historyButton.className = css.linkButton
  heading.append(headingLabel, historyButton)
  const historyHelp = document.createElement('p'); historyHelp.className = css.hint
  const historyWarning = document.createElement('p'); historyWarning.className = css.hint; historyWarning.setAttribute('role', 'alert')
  const rows = document.createElement('div'); rows.className = css.remoteWorkspaceRows
  const activity = document.createElement('div'); activity.className = css.remoteWorkspaceActivity
  const feedback = document.createElement('div'); feedback.className = css.remoteWorkspaceFeedback
  const target = document.createElement('div'); target.className = css.remoteWorkspaceTarget
  const message = document.createElement('p'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite')
  const explanation = document.createElement('p'); explanation.className = css.hint
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = css.linkButton
  const background = document.createElement('button'); background.type = 'button'; background.className = css.linkButton
  const dismissFeedback = document.createElement('button'); dismissFeedback.type = 'button'; dismissFeedback.className = css.linkButton
  const detail = document.createElement('details'); detail.className = css.remoteErrorDetails
  const summary = document.createElement('summary'), original = document.createElement('pre'); detail.append(summary, original)
  const statusHint = document.createElement('p'); statusHint.className = css.hint
  feedback.append(target, message, explanation, detail, retry, background, dismissFeedback); section.append(heading, rows, historyHelp, activity, feedback, statusHint, historyWarning)
  const keyed = new Map<string, { button: HTMLButtonElement; name: HTMLElement; path: HTMLElement; lamp: HTMLElement; state: HTMLElement }>()
  const cards = new Map<string, { node: HTMLElement; target: HTMLElement; path: HTMLElement; message: HTMLElement; help: HTMLElement; time: HTMLTimeElement; stage: HTMLElement; details: HTMLDetailsElement; summary: HTMLElement; original: HTMLElement; action: HTMLButtonElement }>()
  const recovery = recoveryFromHash(), lifetime = new AbortController(), options = { signal: lifetime.signal }
  let disposed = false, busy = false, stale = true, offline = !navigator.onLine, recoveryFailed = false, recoveryStarted = false
  let timer: ReturnType<typeof setTimeout> | undefined, polling: AbortController | undefined, pollEpoch = 0
  let activeItem: string | undefined, operation: RemoteOperation | undefined, status = '', failure = false
  let failureError: unknown, watch: AbortController | undefined, watchEpoch = 0, dismissing: string | undefined
  let focusOperation: string | undefined
  let items: RemoteWorkspace[] = [], hosts: Array<{ hostId: string; phase: RemotePhase }> = []
  let operations: RemoteOperation[] = []
  let history: RemoteOperation[] = [], showHistory = false, warning: string | undefined
  let ownedFocus: HTMLElement | undefined
  function focusFallback(workspaceId?: string): void {
    const ready = workspaceId ? keyed.get(workspaceId)?.button : undefined
    if (ready && !ready.disabled) { ready.focus(); return }
    if (!historyButton.hidden) { historyButton.focus(); return }
    const next = [...keyed.values()].find(x => !x.button.disabled)?.button ?? [...cards.values()].find(x => !x.action.disabled)?.action
    if (next) { next.focus(); return }
    if (!section.hidden) { heading.focus(); return }
    const add = [...document.querySelectorAll<HTMLButtonElement>('button')].find(x => !x.disabled && (x.getAttribute('aria-label') === tt('workspace.add') || x.textContent === tt('workspace.add')))
    add?.focus()
  }
  function render(): void {
    if (disposed) return
    const focused = document.activeElement
    const detached = focused === document.body && ownedFocus && !ownedFocus.isConnected
    const anchor = (detached ? ownedFocus : focused) ?? null
    let lostFocus = !!detached, completedWorkspace: string | undefined
    const sidebar = document.querySelector<HTMLElement>('[data-pane="sidebar"] [role="tree"], [class*="sidebarCol"] [role="tree"]')
      ?? document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
    if (sidebar && section.parentElement !== sidebar) {
      if (section.contains(anchor)) lostFocus = true
      sidebar.append(section)
    }
    const title = tt('remote.workspaces'); section.setAttribute('aria-label', title); text(headingLabel, title)
    heading.hidden = !items.length && !operations.length && !history.length && !status && !warning; section.hidden = heading.hidden
    historyButton.hidden = !history.length; historyButton.setAttribute('aria-expanded', String(showHistory))
    text(historyButton, tt(showHistory ? 'remote.historyClose' : 'remote.history'))
    historyHelp.hidden = !showHistory; text(historyHelp, tt('remote.historyHelp'))
    historyWarning.hidden = !warning
    const issue = warning ? remoteErrorView(new RemoteRequestError(warning, 'ssh/activity-unavailable')) : undefined
    text(historyWarning, issue ? `${issue.summary} ${issue.help ?? ''}` : '')
    const ids = new Set(items.map(x => x.id))
    for (const [id, row] of keyed) if (!ids.has(id)) { if (row.button.contains(anchor)) lostFocus = true; row.button.remove(); keyed.delete(id) }
    items.forEach((item, index) => {
      let row = keyed.get(item.id)
      if (!row) {
        const button = document.createElement('button'); button.type = 'button'; button.className = css.remoteWorkspaceRow; button.dataset.remoteWorkspaceId = item.id
        const lamp = document.createElement('span'); lamp.className = css.workspaceDot; lamp.setAttribute('aria-hidden', 'true')
        const copy = document.createElement('span'); copy.className = css.remoteWorkspaceCopy
        const name = document.createElement('span'); name.className = css.remoteWorkspaceName
        const path = document.createElement('span'); path.className = css.remoteWorkspacePath
        const state = document.createElement('span'); state.className = css.remoteWorkspaceState
        copy.append(name, path, state); button.append(lamp, copy); row = { button, lamp, name, path, state }; keyed.set(item.id, row)
      }
      const phase = busy && activeItem === item.id ? operation?.phase ?? 'connecting' : stale ? undefined : hosts.find(x => x.hostId === item.hostId)?.phase
      const state = !phase ? 'unknown' : phase === 'ready' ? 'connected' : phase === 'failed' || phase === 'disconnected' ? phase : 'connecting'
      row.lamp.dataset.state = state; row.state.dataset.state = state
      const label = offline ? tt('remote.offline') : phase ? tt(`remote.phase.${phase}`) : tt('remote.unknown')
      text(row.name, item.title); text(row.path, item.remotePath); text(row.state, label)
      row.button.title = `${item.alias}:${item.remotePath}`; row.button.setAttribute('aria-label', `${tt('remote.open', { alias: item.alias, path: item.remotePath })} · ${label}`)
      row.button.disabled = busy || offline
      row.button.onclick = () => { if (!busy && !offline) void run(item) }
      if (rows.children[index] !== row.button) {
        if (row.button.contains(anchor)) lostFocus = true
        rows.insertBefore(row.button, rows.children[index] ?? null)
      }
    })
    const visible = (showHistory ? history : operations).filter(x => !(status && operation?.id === x.id))
    const operationIds = new Set(visible.map(x => x.id))
    for (const [id, card] of cards) if (!operationIds.has(id)) {
      if (card.node.contains(anchor)) { lostFocus = true; completedWorkspace = history.find(x => x.id === id && x.phase === 'ready')?.workspace?.id }
      card.node.remove(); cards.delete(id)
    }
    visible.forEach((item, index) => {
      let card = cards.get(item.id)
      if (!card) {
        const node = document.createElement('div'); node.className = css.remoteWorkspaceFeedback; node.dataset.remoteOperationId = item.id
        const target = document.createElement('div'); target.className = css.remoteWorkspaceTarget
        const path = document.createElement('span'); path.className = css.remoteWorkspacePath
        const message = document.createElement('p'), help = document.createElement('p'); help.className = css.hint
        const time = document.createElement('time'); time.className = css.remoteWorkspaceTimestamp
        const stage = document.createElement('p'); stage.className = css.hint
        const details = document.createElement('details'); details.className = css.remoteErrorDetails
        const summary = document.createElement('summary'), original = document.createElement('pre'); details.append(summary, original)
        const actions = document.createElement('div'); actions.className = css.remoteWorkspaceActions
        const action = document.createElement('button'); action.type = 'button'; action.className = css.linkButton; actions.append(action)
        node.append(target, path, time, message, stage, help, details, actions); card = { node, target, path, time, message, stage, help, details, summary, original, action }; cards.set(item.id, card)
      }
      const failed = item.phase === 'failed', view = failed ? remoteErrorView(new RemoteRequestError(item.message, item.errorCode)) : undefined
      const ready = item.phase === 'ready', terminal = failed || ready
      card.node.dataset.state = view?.unconfirmed ? 'unknown' : failed ? 'failed' : ready ? 'ready' : 'connecting'; text(card.target, item.alias); text(card.path, item.remotePath ?? '')
      card.path.title = item.remotePath ?? ''; text(card.message, terminal ? view?.summary ?? tt('remote.setupCompleted') : offline ? tt('remote.offline') : stale ? tt('remote.unknown') : remoteProgress(item))
      card.message.setAttribute('role', failed && !view?.unconfirmed ? 'alert' : 'status')
      const updated = new Date(item.updatedAt ?? item.createdAt ?? NaN)
      card.time.hidden = !Number.isFinite(updated.getTime())
      if (!card.time.hidden) { card.time.dateTime = updated.toISOString(); text(card.time, tt('remote.updatedAt', { time: updated.toLocaleString(document.documentElement.lang || 'en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })) }
      card.stage.hidden = !item.lastPhase; text(card.stage, item.lastPhase ? tt('remote.lastPhase', { phase: tt(`remote.phase.${item.lastPhase}`) }) : '')
      card.help.hidden = !view?.help || (showHistory && !!item.dismissed); text(card.help, view?.help ?? '')
      card.details.hidden = !view?.details; text(card.summary, tt('remote.errorDetails')); text(card.original, view?.details ?? '')
      card.action.disabled = busy || offline || stale || dismissing !== undefined || !!item.dismissed || (ready && !items.some(x => x.id === item.workspace?.id))
      text(card.action, tt(item.dismissed ? 'remote.dismissed' : ready ? 'remote.openPrepared' : view?.unconfirmed ? 'remote.dismissRecord' : failed ? 'remote.dismiss' : 'remote.observe'))
      card.action.onclick = () => { if (ready && item.workspace) void run(item.workspace); else if (failed) void dismiss(item.id); else void observe(item) }
      if (activity.children[index] !== card.node) {
        if (card.node.contains(anchor)) lostFocus = true
        activity.insertBefore(card.node, activity.children[index] ?? null)
      }
    })
    feedback.hidden = !status
    target.hidden = !operation; text(target, operation ? `${operation.alias}${operation.remotePath ? ' · ' + operation.remotePath : ''}` : '')
    const view = failure ? remoteErrorView(failureError) : undefined
    text(message, view?.summary ?? (operation && !failure ? remoteProgress(operation) : status)); message.setAttribute('role', failure && !view?.unconfirmed ? 'alert' : 'status')
    feedback.dataset.state = view?.unconfirmed ? 'unknown' : failure ? 'failed' : busy ? 'connecting' : 'ready'; section.setAttribute('aria-busy', String(busy))
    explanation.hidden = !status || (!view?.help && !recovery && !(failure && operation && operation.phase !== 'failed'))
    text(explanation, view?.help ?? tt(recovery ? 'remote.recoveryHelp' : 'remote.setupHelp'))
    detail.hidden = !view?.details; text(summary, tt('remote.errorDetails')); text(original, view?.details ?? '')
    background.hidden = !busy || !operation || ['ready', 'failed'].includes(operation.phase); text(background, tt('remote.background'))
    dismissFeedback.hidden = !failure || operation?.phase !== 'failed'; dismissFeedback.disabled = busy || offline || dismissing !== undefined
    text(dismissFeedback, tt(view?.unconfirmed ? 'remote.dismissRecord' : 'remote.dismiss'))
    retry.hidden = !recoveryFailed; retry.disabled = busy || offline; text(retry, tt('remote.retryRecovery'))
    statusHint.hidden = (!items.length && !operations.length && !history.length) || (!offline && !stale) || busy
    text(statusHint, offline ? tt('remote.offlineHelp') : tt('remote.statusUnavailable'))
    if (lostFocus && (document.activeElement === document.body || !document.activeElement?.isConnected)) {
      if (anchor instanceof HTMLElement && anchor.isConnected && section.contains(anchor) && !anchor.closest('[hidden]') && !anchor.matches(':disabled')) anchor.focus()
      else focusFallback(completedWorkspace)
    }
  }
  historyButton.onclick = () => { showHistory = !showHistory; render(); historyButton.focus() }
  function finish(epoch: number, focusId?: string, recoveryRetry = false): void {
    if (epoch !== watchEpoch) return
    if (disposed) return
    busy = false; watch = undefined; render(); refresh()
    const focus = document.activeElement
    if (focus === document.body || (focus && section.contains(focus))) {
      if (recoveryRetry && recoveryFailed) retry.focus()
      else if (focusId) keyed.get(focusId)?.button.focus()
    }
  }
  function begin(): { epoch: number; options: RequestOptions; progress: Progress } {
    watch?.abort(); focusOperation = undefined
    const epoch = ++watchEpoch, controller = new AbortController(); watch = controller
    let focused = false
    return { epoch, options: { signal: controller.signal }, progress: (message, next) => {
      if (!disposed && epoch === watchEpoch) {
        status = message; operation = next; render()
        if (!focused && !background.hidden) {
          focused = true
          if (document.activeElement === document.body || section.contains(document.activeElement)) background.focus()
        }
      }
    } }
  }
  function report(error: unknown, epoch: number): void {
    if (!disposed && epoch === watchEpoch) { failure = true; failureError = error; status = remoteErrorView(error).summary }
  }
  background.onclick = () => {
    focusOperation = operation?.id
    watchEpoch++; watch?.abort(); watch = undefined; busy = false; operation = undefined; status = ''; failure = false; recoveryFailed = false; render(); refresh()
  }
  async function run(item: RemoteWorkspace): Promise<void> {
    const attempt = begin()
    busy = true; activeItem = item.id; operation = undefined; failure = false; status = tt('remote.phase.connecting'); render()
    try { const workspace = await connectRemoteWorkspace(item.alias, item.remotePath, attempt.progress, { ...attempt.options, expectedHostId: item.hostId }); await openRemoteWorkspace(workspace, undefined, attempt.options) }
    catch (error) { report(error, attempt.epoch) }
    finally { finish(attempt.epoch, item.id) }
  }
  async function observe(item: RemoteOperation): Promise<void> {
    if (busy || offline || disposed) return
    const attempt = begin(); busy = true; operation = item; failure = false; status = remoteProgress(item); render()
    try {
      const workspace = await observeRemoteOperation(item.id, attempt.progress, attempt.options)
      await openRemoteWorkspace(workspace, recovery && recovery.hostId === item.hostId ? recovery.sessionId : undefined, attempt.options)
    } catch (error) { report(error, attempt.epoch) }
    finally { finish(attempt.epoch) }
  }
  async function dismiss(id: string): Promise<void> {
    if (busy || offline || disposed || dismissing) return
    const origin = document.activeElement
    const ownedFocus = origin === document.body || section.contains(origin)
    dismissing = id; render()
    try {
      await json('dismiss', { id }, options); operations = operations.filter(x => x.id !== id)
      history = history.map(x => x.id === id ? { ...x, dismissed: true } : x)
      if (operation?.id === id) { status = ''; operation = undefined; failure = false; recoveryFailed = false }
    }
    catch (error) { report(error, watchEpoch) }
    finally {
      if (!disposed) {
        dismissing = undefined; render(); refresh()
        const focused = document.activeElement
        if (ownedFocus && (focused === origin || focused === document.body || !focused?.isConnected)) focusFallback()
      }
    }
  }
  dismissFeedback.onclick = () => { if (operation?.phase === 'failed') void dismiss(operation.id) }
  async function runRecovery(): Promise<void> {
    if (!recovery || busy || disposed || offline) return
    recoveryStarted = true
    const retrying = recoveryFailed
    const attempt = begin()
    busy = true; recoveryFailed = false; failure = false; operation = undefined; activeItem = items.find(x => x.hostId === recovery.hostId)?.id
    status = tt('remote.recovering'); render()
    try {
      const { operation } = await json<{ operation: RemoteOperation }>('recover', { hostId: recovery.hostId, proof: recovery.proof }, attempt.options)
      const workspace = await waitForOperation(operation, attempt.progress, attempt.options)
      await openRemoteWorkspace(workspace, recovery.sessionId, attempt.options)
    } catch (error) { if (attempt.epoch === watchEpoch) recoveryFailed = true; report(error, attempt.epoch) }
    finally { finish(attempt.epoch, undefined, retrying) }
  }
  retry.onclick = () => { void runRecovery() }
  async function poll(): Promise<void> {
    if (disposed || document.hidden || offline) return
    const epoch = ++pollEpoch, controller = new AbortController(); polling = controller
    try {
      const result = await json<{ workspaces: RemoteWorkspace[]; hosts: typeof hosts; operations?: RemoteOperation[]; history?: RemoteOperation[]; warning?: string }>('workspaces', undefined, { signal: controller.signal })
      if (epoch !== pollEpoch || disposed) return
      items = result.workspaces; hosts = result.hosts; operations = result.operations ?? []; history = result.history ?? operations; warning = result.warning; stale = false
    } catch { if (epoch !== pollEpoch || disposed) return; stale = true }
    finally {
      if (epoch === pollEpoch && !disposed) { polling = undefined; render(); timer = setTimeout(() => { void poll() }, 5000) }
      if (epoch === pollEpoch && !disposed && focusOperation && !stale) {
        const button = cards.get(focusOperation)?.action
        const completed = history.find(x => x.id === focusOperation && x.phase === 'ready')?.workspace?.id
        focusOperation = undefined
        if (document.activeElement === document.body || section.contains(document.activeElement)) {
          if (button && !button.disabled) button.focus(); else focusFallback(completed)
        }
      }
    }
  }
  function refresh(): void {
    clearTimeout(timer); pollEpoch++; polling?.abort(); polling = undefined; stale = true; render()
    if (!document.hidden && !offline) void poll()
  }
  const offlineChanged = () => { offline = true; refresh() }
  const onlineChanged = () => { offline = false; refresh(); if (recovery && !recoveryStarted) void runRecovery() }
  // Native sidebar rebuilds detach our subtree before the body observer reattaches it.
  // Remember only its last focused node; an explicit focus or pointer action elsewhere relinquishes it.
  const focusChanged = (event: FocusEvent) => {
    if (event.target instanceof HTMLElement) {
      if (section.contains(event.target)) ownedFocus = event.target
      else if (event.target !== document.body) ownedFocus = undefined
    }
  }
  const pointerChanged = (event: PointerEvent) => { if (!section.contains(event.target as Node | null)) ownedFocus = undefined }
  document.addEventListener('focusin', focusChanged); document.addEventListener('pointerdown', pointerChanged)
  const unsubscribe = subscribeBodyInvalidations(render), stopLocale = locale?.subscribe(render)
  document.addEventListener('visibilitychange', refresh); window.addEventListener('offline', offlineChanged); window.addEventListener('online', onlineChanged)
  window.addEventListener(activityEvent, refresh)
  render(); void poll()
  if (recovery) { window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search); void runRecovery() }
  return () => {
    disposed = true; lifetime.abort(); watchEpoch++; watch?.abort(); clearTimeout(timer); pollEpoch++; polling?.abort(); unsubscribe(); stopLocale?.()
    document.removeEventListener('visibilitychange', refresh); window.removeEventListener('offline', offlineChanged); window.removeEventListener('online', onlineChanged); section.remove()
    document.removeEventListener('focusin', focusChanged); document.removeEventListener('pointerdown', pointerChanged); ownedFocus = undefined
    window.removeEventListener(activityEvent, refresh)
  }
}
