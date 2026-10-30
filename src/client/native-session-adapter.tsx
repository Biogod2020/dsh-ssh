import { createElement, useEffect, useMemo, useRef, useSyncExternalStore, type ComponentType } from 'react'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteWorkspace } from '../remote/types.ts'
import type { SessionActivitySummary } from '../remote/session-activity.ts'
import { isRemoteNavigationKey, remoteNavigation, remoteSessionKey, resolveRemoteNavigation } from './remote-navigation.ts'
import { archiveRemoteSession, forkRemoteSession, mutateRemoteSession } from './remote-session-action.ts'
import { RemoteRequestError } from './remote-errors.ts'
import { remotePresentation, remoteSelection } from './remote-presentation.ts'
import { projectEntry } from './slot-projection.tsx'
import { tt } from './panel/helpers.ts'

type Props = Record<string, any>
interface BoundSession { key: string; workspace: RemoteWorkspace; sessionId: string }
interface Request extends BoundSession { nonce: number; currentTitle: string; displayTitle: string; activity?: SessionActivitySummary[] }
interface ArchiveNotice extends BoundSession { seq: number; stopped: boolean }
interface State { rename: Request | null; archive: Request | null; notice: ArchiveNotice | null; renameAvailable: boolean; archiveAvailable: boolean; issue: string }
const menuSlot = 'sidebar.workspaces.session.menu.item', rowSlot = 'sidebar.workspaces.session.row.action'
const menuActions = new Set(['pin', 'rename', 'fork', 'archive', 'session-id']), rowActions = new Set(['pin', 'archive'])

/** The only remote-specific layer: identity, observations and native Host RPC.
 * Menus, labels, icons, clipboard feedback and forms remain runtime components. */
export class NativeSessionAdapter {
  private state: State = { rename: null, archive: null, notice: null, renameAvailable: false, archiveAvailable: false, issue: '' }
  private listeners = new Set<() => void>()
  private serial = 0
  getSnapshot = (): State => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(change: Partial<State>) { this.state = { ...this.state, ...change }; for (const listener of this.listeners) listener() }
  report = (issue: string) => this.update({ issue })
  dismissNotice(notice: ArchiveNotice) { if (this.state.notice === notice) this.update({ notice: null }) }
  async undoArchive(notice: ArchiveNotice) {
    this.assert(notice)
    await mutateRemoteSession(notice.workspace, notice.sessionId, 'unarchive')
  }
  overlay(kind: 'rename' | 'archive', available: boolean) {
    const field = kind === 'rename' ? 'renameAvailable' : 'archiveAvailable'
    if (this.state[field] !== available) this.update({ [field]: available, ...(!available ? { [kind]: null } : {}) })
  }
  bind(key: string): BoundSession {
    const target = resolveRemoteNavigation(key)
    if (!target?.sessionId) throw new Error(tt('remote.desktopIdentityChanged'))
    return { key, workspace: { ...target.workspace }, sessionId: target.sessionId }
  }
  private assert(bound: BoundSession, key = bound.key) {
    const target = resolveRemoteNavigation(bound.key), state = remoteNavigation.getSnapshot()
    if (key !== bound.key || !target || target.sessionId !== bound.sessionId || target.workspace.hostId !== bound.workspace.hostId
      || target.workspace.workspaceId !== bound.workspace.workspaceId || target.workspace.alias !== bound.workspace.alias) throw new Error(tt('remote.desktopIdentityChanged'))
    const catalog = state.catalogs.get(bound.workspace.id)
    if (!navigator.onLine || state.hosts?.get(bound.workspace.hostId) !== 'ready' || catalog?.stale || catalog?.workspaceId !== bound.workspace.workspaceId) throw new Error(tt('remote.actionConnectionRequired'))
  }
  private title(bound: BoundSession) {
    const catalog = remoteNavigation.getSnapshot().catalogs.get(bound.workspace.id)
    return [...catalog?.sessions ?? [], ...catalog?.archivedSessions ?? []].find(row => row.sessionId === bound.sessionId)?.title ?? ''
  }
  requestRename = (key: string, currentTitle?: string) => {
    try {
      const bound = this.bind(key); this.assert(bound)
      if (!this.state.renameAvailable) throw new Error(tt('remote.nativeActionsUnavailable'))
      if (this.state.rename || this.state.archive) throw new Error(tt('remote.actionPending'))
      const title = currentTitle ?? this.title(bound)
      this.update({ rename: { ...bound, nonce: ++this.serial, currentTitle: title, displayTitle: title }, issue: '' })
    } catch (error) { this.report(error instanceof Error ? error.message : tt('remote.actionUnconfirmed')) }
  }
  settle(kind: 'rename' | 'archive', request: Request) { if (this.state[kind] === request) this.update({ [kind]: null }) }
  async rename(request: Request, key: string, title: string) {
    if (this.state.rename !== request) throw new Error(tt('remote.desktopIdentityChanged'))
    this.assert(request, key)
    await mutateRemoteSession(request.workspace, request.sessionId, 'rename', title)
  }
  async renameDirect(key: string, title: string) {
    const bound = this.bind(key); this.assert(bound)
    await mutateRemoteSession(bound.workspace, bound.sessionId, 'rename', title)
  }
  async fork(key: string) {
    const bound = this.bind(key); this.assert(bound)
    const intent = remoteNavigation.intent()
    const child = await forkRemoteSession(bound.workspace, bound.sessionId, this.title(bound))
    if (child.titleUnconfirmed) this.report(tt('remote.forkTitleUnconfirmed'))
    if (intent === remoteNavigation.intent()) remoteNavigation.open(bound.workspace, child.sessionId)
  }
  private async afterArchive(bound: BoundSession) {
    const selected = remoteSelection()
    if (selected?.workspaceId === bound.workspace.id && selected.sessionId === bound.sessionId) {
      try { await remotePresentation()?.archived?.(bound.workspace, bound.sessionId) }
      catch { this.report(tt('remote.unsavedDraft')) } // Archive succeeded; do not repeat it to recover the view.
    }
  }
  async archive(key: string) {
    const bound = this.bind(key); this.assert(bound)
    try {
      await archiveRemoteSession(bound.workspace, bound.sessionId)
      this.update({ notice: { ...bound, seq: ++this.serial, stopped: false } })
      await this.afterArchive(bound)
    }
    catch (error) {
      if (!(error instanceof RemoteRequestError) || error.errorCode !== 'workspace/session-active' || !error.activity?.length || !this.state.archiveAvailable) throw error
      this.assert(bound)
      if (this.state.rename || this.state.archive) throw new Error(tt('remote.actionPending'))
      const title = this.title(bound)
      this.update({ archive: { ...bound, nonce: ++this.serial, currentTitle: title, displayTitle: title || bound.sessionId, activity: error.activity }, issue: '' })
    }
  }
  async confirmArchive(request: Request, key: string) {
    if (this.state.archive !== request) throw new Error(tt('remote.desktopIdentityChanged'))
    this.assert(request, key)
    const catalog = remoteNavigation.getSnapshot().catalogs.get(request.workspace.id)
    if (!catalog?.archivedSessions?.some(row => row.sessionId === request.sessionId)) await archiveRemoteSession(request.workspace, request.sessionId, true)
    this.update({ notice: { ...request, seq: ++this.serial, stopped: true } })
    await this.afterArchive(request)
  }
  async mutate(key: string, action: 'pin' | 'unpin' | 'unarchive') {
    const bound = this.bind(key); this.assert(bound)
    await mutateRemoteSession(bound.workspace, bound.sessionId, action)
  }
  run = (action: () => Promise<unknown>, key?: string) => {
    const target = key ? resolveRemoteNavigation(key) : undefined
    const context = target ? `${target.workspace.alias} · ${target.sessionId ? this.title({ key: key!, workspace: target.workspace, sessionId: target.sessionId }) || target.sessionId : target.workspace.title}` : undefined
    this.report('')
    void action().catch(error => {
      const message = error instanceof Error && error.name === 'DraftSaveError' ? tt('remote.unsavedDraft')
      : error instanceof RemoteRequestError && error.errorCode === 'session/fork-unavailable'
      ? tt('remote.forkUnavailable') : error instanceof Error && [tt('remote.desktopIdentityChanged'), tt('remote.actionConnectionRequired'), tt('remote.actionPending')].includes(error.message)
        ? error.message : tt('remote.actionUnconfirmed')
      this.report(context ? `${context}: ${message}` : message)
    })
  }
  renderChild = (slot: string, entry: StoredEntry, props: Props) => {
    if (!isRemoteNavigationKey(props.sessionId)) return createElement(entry.component as ComponentType<Props>, props)
    if (slot !== menuSlot && slot !== rowSlot) return null
    return <RemoteNativeEntry key={props.sessionId} adapter={this} slot={slot} entry={entry} owner={props} />
  }
}

function RemoteNativeEntry({ adapter, slot, entry, owner }: { adapter: NativeSessionAdapter; slot: string; entry: StoredEntry; owner: Props }) {
  const remote = useSyncExternalStore(remoteNavigation.subscribe, remoteNavigation.getSnapshot)
  const state = useSyncExternalStore(adapter.subscribe, adapter.getSnapshot)
  const target = resolveRemoteNavigation(owner.sessionId, remote), action = entry.options.id ?? ''
  if (!target?.sessionId || !(slot === menuSlot ? menuActions : rowActions).has(action)) return null
  const bound = { key: owner.sessionId, workspace: target.workspace, sessionId: target.sessionId }
  const catalog = remote.catalogs.get(bound.workspace.id)
  const ready = navigator.onLine && remote.hosts?.get(bound.workspace.hostId) === 'ready' && catalog?.stale === false && catalog.workspaceId === bound.workspace.workspaceId
  if (action !== 'session-id' && !ready || action === 'rename' && !state.renameAvailable) return null
  if (typeof owner.t !== 'function' || slot === menuSlot && typeof owner.useMenuOpenState !== 'function') return null
  // Each source entry keeps its own native UI and locale. Never forward its
  // local business capabilities into a remote occurrence.
  const props: Props = { sessionId: bound.key, displayTitle: owner.displayTitle, t: owner.t,
    useMenuOpenState: owner.useMenuOpenState, useShortcuts: useNoLocalShortcuts }
  const invoke = (id: string, effect: () => Promise<unknown>) => adapter.run(async () => {
    if (id !== bound.key) throw new Error(tt('remote.desktopIdentityChanged'))
    // bind at dispatch as well, preventing a stale menu from changing Hosts.
    const current = adapter.bind(bound.key)
    if (current.workspace.hostId !== bound.workspace.hostId || current.workspace.workspaceId !== bound.workspace.workspaceId) throw new Error(tt('remote.desktopIdentityChanged'))
    await effect()
  }, bound.key)
  if (action === 'pin' || action === 'archive') {
    props.useArchived = remoteSetHook(bound.workspace, 'archived')
    if (action === 'pin') Object.assign(props, { usePinned: remoteSetHook(bound.workspace, 'pinned'),
      pinSession: (id: string) => invoke(id, () => adapter.mutate(bound.key, 'pin')),
      unpinSession: (id: string) => invoke(id, () => adapter.mutate(bound.key, 'unpin')) })
    else Object.assign(props, { archiveSession: (id: string) => invoke(id, () => adapter.archive(bound.key)),
      unarchiveSession: (id: string) => invoke(id, () => adapter.mutate(bound.key, 'unarchive')) })
  } else if (action === 'rename') props.requestSessionRename = (id: string, title: string) => {
    if (id === bound.key) adapter.requestRename(bound.key, title); else adapter.report(tt('remote.desktopIdentityChanged'))
  }
  else if (action === 'fork') Object.assign(props, { useSessionAccess: (id: string, method: string) => {
    const live = useSyncExternalStore(remoteNavigation.subscribe, remoteNavigation.getSnapshot)
    return id === bound.key && method === 'session/fork' && live.hosts?.get(bound.workspace.hostId) === 'ready'
  }, forkSession: (id: string) => invoke(id, () => adapter.fork(bound.key)) })
  else {
    if (typeof owner.copySessionId !== 'function') return null
    props.sessionId = bound.sessionId
    props.copySessionId = owner.copySessionId // Native clipboard + native feedback; no remote write.
  }
  return createElement(entry.component as ComponentType<Props>, props)
}

function remoteSetHook(workspace: RemoteWorkspace, kind: 'pinned' | 'archived') {
  return <T,>(select: (value: Set<string>) => T): T => {
    const remote = useSyncExternalStore(remoteNavigation.subscribe, remoteNavigation.getSnapshot)
    const catalog = remote.catalogs.get(workspace.id)
    const rows = kind === 'archived' ? catalog?.archivedSessions ?? [] : (catalog?.sessions ?? []).filter(row => row.pinned)
    return select(new Set(rows.map(row => remoteSessionKey(workspace, row.sessionId))))
  }
}
function useNoLocalShortcuts<T>(select: (rows: readonly unknown[]) => T): T {
  useSyncExternalStore(remoteNavigation.subscribe, remoteNavigation.getSnapshot)
  return select([]) // Native global commands still belong to the local Host.
}

/** Mirror the registered official forms under private ids; local forms stay untouched. */
export function mountNativeSessionOverlays(slots: Parameters<typeof projectEntry>[0], adapter: NativeSessionAdapter): () => void {
  const sources = { rename: 'workspace.session-rename', archive: 'workspace.session-archive', notice: 'workspace.row-toast' } as const
  const copies = new Map<string, { source: StoredEntry; dispose: () => void }>()
  let syncing = false
  const sync = () => {
    if (syncing) return
    syncing = true
    try {
      for (const kind of ['rename', 'archive', 'notice'] as const) {
        const source = [...slots.entries('shell.overlay')].filter(entry => entry.options.id === sources[kind])
          .sort((a,b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0]
        const previous = copies.get(kind)
        if (previous?.source === source) continue
        previous?.dispose(); copies.delete(kind)
        if (kind !== 'notice') adapter.overlay(kind, false)
        if (!source) continue
        const clone = { ...source, locale: kind === 'notice' ? 'workspace' : source.locale, options: { ...source.options, id: `dsh-ssh.remote.${sources[kind]}` } }
        const projection = projectEntry(slots, 'shell.overlay', clone, props => kind === 'notice'
          ? <RemoteArchiveNotice adapter={adapter} owner={props} />
          : <RemoteNativeOverlay adapter={adapter} kind={kind} original={source.component as ComponentType<Props>} owner={props} />)
        copies.set(kind, { source, dispose: projection.dispose })
        if (kind !== 'notice') adapter.overlay(kind, true)
      }
    } finally { syncing = false }
  }
  const unsubscribe = slots.subscribe('shell.overlay', sync); sync()
  return () => { unsubscribe(); for (const copy of copies.values()) copy.dispose(); copies.clear(); adapter.overlay('rename', false); adapter.overlay('archive', false) }
}

/** Use the official Toast factory, timing and locale; only Undo targets our Host. */
function RemoteArchiveNotice({ adapter, owner }: { adapter: NativeSessionAdapter; owner: Props }) {
  const { notice } = useSyncExternalStore(adapter.subscribe, adapter.getSnapshot)
  const local = owner.useToast?.((value: unknown) => value), shown = useRef<ArchiveNotice | null>(null)
  useEffect(() => {
    if (shown.current !== notice) {
      shown.current = notice
      if (notice && local) owner.dismissToast?.()
    } else if (local && notice) adapter.dismissNotice(notice)
  }, [local, notice, adapter, owner.dismissToast])
  if (!notice || typeof owner.renderFactorySlot !== 'function' || typeof owner.t !== 'function') return null
  const dismiss = () => adapter.dismissNotice(notice)
  return owner.renderFactorySlot('workspace.toast.content', {
    seq: notice.seq, text: owner.t(notice.stopped ? 'toast.stoppedAndArchived' : 'toast.archived'), tone: 'success', holdMs: 6000,
    actions: [{ label: owner.t('toast.archivedUndo'), onClick: () => { dismiss(); adapter.run(() => adapter.undoArchive(notice), notice.key) } }], onDone: dismiss,
  })
}

function RemoteNativeOverlay({ adapter, kind, original, owner }: { adapter: NativeSessionAdapter; kind: 'rename' | 'archive'; original: ComponentType<Props>; owner: Props }) {
  const state = useSyncExternalStore(adapter.subscribe, adapter.getSnapshot), request = state[kind]
  const projected = useMemo(() => request ? { ...request, sessionId: request.key } : null, [request])
  const local = kind === 'rename' ? owner.useRenameRequest((value: unknown) => value) : owner.useArchiveRequest((value: unknown) => value)
  useEffect(() => { if (local && request) adapter.settle(kind, request) }, [local, request, adapter, kind])
  const props: Props = { t: owner.t }
  // Always bind the same native Hook contract, including its null projection.
  const useRequest = <T,>(select: (value: Request | null) => T): T => { useSyncExternalStore(adapter.subscribe, adapter.getSnapshot); return select(local ? null : projected) }
  if (kind === 'rename') Object.assign(props, { useRenameRequest: useRequest, settleSessionRename: () => { if (request) adapter.settle(kind, request) },
    renameSession: (id: string, title: string) => request ? adapter.rename(request, id, title) : Promise.reject(new Error(tt('remote.desktopIdentityChanged'))) })
  else Object.assign(props, { useArchiveRequest: useRequest, settleSessionArchive: () => { if (request) adapter.settle(kind, request) },
    stopAndArchiveSession: (id: string) => request ? adapter.confirmArchive(request, id) : Promise.reject(new Error(tt('remote.desktopIdentityChanged'))) })
  return createElement(original, props)
}
