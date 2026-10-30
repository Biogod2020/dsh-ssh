import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { projectEntry } from './slot-projection.tsx'
import { isRemoteNavigationKey, remoteNavigation, remoteSessionKey, remoteWorkspaceKey, resolveRemoteNavigation, type RemoteNavigationSnapshot } from './remote-navigation.ts'
import { remoteSelection, remotePresentation, subscribeRemoteSelection, type RemoteSelection } from './remote-presentation.ts'
import { tt } from './panel/helpers.ts'
import { WorkspaceOrder, orderedWorkspaces } from './workspace-order.ts'
import { remoteWorkspaceName } from './workspace-label.ts'
import { NativeSessionAdapter, mountNativeSessionOverlays } from './native-session-adapter.tsx'
import css from './panel/panel.module.css'

// Presentation-only projections. Neither Controller nor the local Host receives
// these identities. Every action must be routed before leaving this component.
type Row = { id: string; title?: string; displayTitle: string; cwd?: string; running: boolean; blank: boolean; updatedAt: number; retainedBy: Record<string, number>; [key: string]: unknown }
type List = { ids: string[]; byId: Record<string, Row>; [key: string]: unknown }
type Workspace = { workspaceId: string; path: string; title: string; sessionIds: readonly string[]; [key: string]: unknown }
type Workspaces = { items: readonly Workspace[]; [key: string]: unknown }
type Hook = <T>(selector: (state: any) => T, equal?: (a: T, b: T) => boolean) => T
type Props = Record<string, any>
type MenuOwner = readonly [boolean, (open: boolean) => void]

/** Request state belongs to this menu opening, not to the whole sidebar. */
function RemoteHostMenu({ sessionId, remote, menu, navigate, report, renderNative }: {
  sessionId: string; remote: RemoteNavigationSnapshot; menu?: MenuOwner; navigate(key: string): boolean; report(message: string): void; renderNative(): ReturnType<typeof createElement>
}) {
  const [settings, setSettings] = useState<{ busy?: boolean; error?: 'settings' | 'draft' }>({})
  const [hostActions, setHostActions] = useState(false)
  const settingsAttempt = useRef(0)
  const open = menu?.[0] ?? true
  const target = resolveRemoteNavigation(sessionId, remote)
  const catalog = target && remote.catalogs.get(target.workspace.id)
  const connected = !!target && navigator.onLine && remote.hosts?.get(target.workspace.hostId) === 'ready' && catalog?.stale === false
  useEffect(() => {
    ++settingsAttempt.current; setSettings({}); setHostActions(false)
    return () => { ++settingsAttempt.current }
  }, [open, sessionId])
  if (!hostActions) return <>
    {!connected && <>
      <span role="status">{tt('remote.actionConnectionRequired')}</span>
      <MenuItemButton disabled={!navigator.onLine || !target} onSelect={() => {
        if (target) { menu?.[1](false); remoteNavigation.reconnect(target.workspace) }
      }}>{tt('remote.reconnectHost')}</MenuItemButton>
    </>}
    {renderNative()}
    <MenuItemButton separatorBefore onSelect={() => setHostActions(true)}>{tt('remote.hostActions')}</MenuItemButton>
  </>
  return <>
    <MenuItemButton onSelect={() => setHostActions(false)}>{tt('remote.conversationActions')}</MenuItemButton>
    <MenuItemButton separatorBefore onSelect={() => { menu?.[1](false); navigate(sessionId) }}>{tt('remote.openConversation')}</MenuItemButton>
    <MenuItemButton disabled={settings.busy} onSelect={() => {
      const attempt = ++settingsAttempt.current
      const target = resolveRemoteNavigation(sessionId, remote)
      if (!target) { setSettings({ error: 'settings' }); return }
      const presentation = remotePresentation()
      setSettings({ busy: true })
      void Promise.resolve().then(() => presentation?.settings?.(target.workspace)).then(ok => {
        if (attempt !== settingsAttempt.current) return
        setSettings({ error: ok ? undefined : 'settings' }); if (ok) menu?.[1](false)
      }).catch(error => { if (attempt === settingsAttempt.current) setSettings({ error: error?.name === 'DraftSaveError' ? 'draft' : 'settings' }) })
    }}>{tt('remote.modelSettings')}</MenuItemButton>
    {settings.error && <span role="alert">{tt(settings.error === 'draft' ? 'remote.unsavedDraft' : 'remote.settingsUnavailable')}</span>}
    <MenuItemButton onSelect={() => {
      menu?.[1](false)
      void remotePresentation()?.reclaim?.().catch(()=>report(tt('remote.unsavedDraft')))
    }}>{tt('remote.reclaimViews')}</MenuItemButton>
    <MenuItemButton onSelect={() => {
      const target = resolveRemoteNavigation(sessionId, remote)
      if (!target) return
      const attempt = ++settingsAttempt.current
      void Promise.resolve().then(() => remotePresentation()?.close?.(target.workspace)).then(() => {
        if (attempt === settingsAttempt.current) menu?.[1](false)
      }).catch(() => { if (attempt === settingsAttempt.current) setSettings({ error: 'draft' }) })
    }}>{tt('remote.closeView')}</MenuItemButton>
  </>
}

export function combineNavigation(list: List, workspaces: Workspaces, remote: RemoteNavigationSnapshot, selected?: RemoteSelection, order: readonly string[] = []) {
  const byId = { ...list.byId }, ids = [...list.ids], items = workspaces.items.map(item => item.path.replaceAll('\\', '/').includes('/ssh-workspaces/')
    ? { ...item, title: `${item.title} · ${tt('remote.localHistory')}` } : item)
  if (selected) for (const [id, row] of Object.entries(byId)) if (row.retainedBy.mainView) byId[id] = {
    ...row, blank: false, retainedBy: { ...row.retainedBy, mainView: 0 },
  }
  const pinnedSessionIds = Array.isArray(workspaces.pinnedSessionIds) ? [...workspaces.pinnedSessionIds] : []
  const archivedSessionIds = Array.isArray(workspaces.archivedSessionIds) ? [...workspaces.archivedSessionIds] : []
  for (const workspace of remote.workspaces) {
    const catalog = remote.catalogs.get(workspace.id)
    const sessions = [...catalog?.sessions ?? [], ...catalog?.archivedSessions ?? []]
    const sessionIds: string[] = []
    for (const session of sessions) {
      const id = remoteSessionKey(workspace, session.sessionId)
      const title = session.title || tt('remote.newSessionTitle')
      byId[id] = { id, title, displayTitle: title, cwd: `${workspace.alias}:${workspace.remotePath}`, running: !catalog?.stale && session.running,
        blank: false, updatedAt: session.updatedAt, retainedBy: { mainView: selected?.workspaceId === workspace.id && selected.sessionId === session.sessionId ? 1 : 0 } }
      ids.push(id); sessionIds.push(id)
      if (session.pinned && !catalog?.archivedSessions?.includes(session)) pinnedSessionIds.push(id)
      if (catalog?.archivedSessions?.includes(session)) archivedSessionIds.push(id)
    }
    if (!sessions.length && (!catalog || catalog.checkedAt === undefined || catalog.stale)) {
      const id = remoteSessionKey(workspace)
      const title = tt('remote.sessionsNotLoaded')
      byId[id] = { id, title, displayTitle: title, cwd: `${workspace.alias}:${workspace.remotePath}`, running: false, blank: false, updatedAt: 0, retainedBy: {} }
      ids.push(id); sessionIds.push(id)
    }
    items.push({ workspaceId: remoteWorkspaceKey(workspace), path: `ssh://${workspace.alias}${workspace.remotePath}`, title: remoteWorkspaceName(workspace), sessionIds,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(Math.max(0, ...sessions.map(session => session.updatedAt))).toISOString() })
  }
  return { list: { ...list, ids, byId }, workspaces: { ...workspaces, items: orderedWorkspaces(items, order), pinnedSessionIds, archivedSessionIds } }
}

export function NativeWorkspaces({ original, workspaceOrder, sessionAdapter, ...props }: Props & { original: ComponentType<Props>; workspaceOrder?: WorkspaceOrder; sessionAdapter?: NativeSessionAdapter }) {
  const adapter = useMemo(() => sessionAdapter ?? new NativeSessionAdapter(), [sessionAdapter])
  const adapterState = useSyncExternalStore(adapter.subscribe, adapter.getSnapshot)
  const order = useMemo(() => workspaceOrder ?? new WorkspaceOrder(), [workspaceOrder])
  const workspaceIds = useSyncExternalStore(order.subscribe, order.getSnapshot)
  const [navigationIssue, setNavigationIssue] = useState(false)
  const [actionIssue, setActionIssue] = useState('')
  const lifetime = useRef(0)
  useLayoutEffect(() => { ++lifetime.current; return () => { ++lifetime.current } }, [])
  // This optional hook is a fixed contract for the lifetime of its native
  // entry. It also lets a newer global panel win over a pending local click.
  const localPanel = props.usePanelInfo?.((info: Props) => info.activePanelId) ?? null
  const panel = useRef(localPanel); panel.current = localPanel
  const localList = props.useSessions((state: List) => state)
  const localWorkspaces = props.useWorkspaces((state: Workspaces) => state)
  const remote = useSyncExternalStore(remoteNavigation.subscribe, remoteNavigation.getSnapshot)
  const selected = useSyncExternalStore(subscribeRemoteSelection, remoteSelection)
  const combined = useMemo(() => combineNavigation(localList, localWorkspaces, remote, selected, workspaceIds), [localList, localWorkspaces, remote, selected, workspaceIds])
  const useSessions: Hook = selector => selector(combined.list)
  const useWorkspaces: Hook = selector => selector(combined.workspaces)
  const usePanelInfo: Hook = (selector, equal) => props.usePanelInfo((info: Props) => selector(selected ? { ...info, activePanelId: null } : info), equal)
  const useSessionStatus: Hook = (selector, equal) => props.useSessionStatus((statuses: Map<string, Props>) => {
    const next = new Map(statuses)
    for (const workspace of remote.workspaces) for (const session of remote.catalogs.get(workspace.id)?.sessions ?? []) next.set(remoteSessionKey(workspace, session.sessionId), {
      running: remote.catalogs.get(workspace.id)?.stale ? undefined : session.running, pendingInteraction: undefined, completionUnread: false,
    })
    return selector(next)
  }, equal)
  const navigate = (key: string, create = false): boolean => {
    if (!isRemoteNavigationKey(key)) return false
    setNavigationIssue(false)
    const target = resolveRemoteNavigation(key, remote)
    if (target) remoteNavigation.open(target.workspace, target.sessionId, create)
    return true
  }
  const localAction = (action: () => void) => {
    remoteNavigation.cancelOpen(); const intent = remoteNavigation.intent(), expectedPanel = panel.current, epoch = lifetime.current
    setNavigationIssue(false)
    const presentation = remotePresentation(), guard = presentation?.beforeLeave
    if (!guard) { action(); return }
    void Promise.resolve().then(() => guard.call(presentation)).then(() => {
      if (epoch === lifetime.current && intent === remoteNavigation.intent() && expectedPanel === panel.current) action()
    }).catch(() => { if (epoch === lifetime.current && intent === remoteNavigation.intent()) setNavigationIssue(true) })
  }
  const localOnly = (action: string) => (...args: any[]) => {
    if (args.some(isRemoteNavigationKey)) throw new Error(tt('remote.actionInRemote'))
    return props[action](...args)
  }
  const renderSlot = (name: string, owner: Props, ...rest: any[]) => {
    if (isRemoteNavigationKey(owner?.sessionId)) {
      if (name === 'sidebar.session.row.hover') return <span>{tt('remote.remoteSession')}</span>
      if (name === 'sidebar.workspaces.session.menu.item') return <RemoteHostMenu
        sessionId={owner.sessionId} remote={remote} menu={rest[0]?.hookContext} navigate={navigate}
        report={setActionIssue} renderNative={() => props.renderSlot(name, owner, ...rest)} />
      if (name === 'sidebar.workspaces.session.row.action') return props.renderSlot(name, owner, ...rest)
      return null // Native row actions address the local Host; never pass a remote id.
    }
    return props.renderSlot(name, owner, ...rest)
  }
  return <>{createElement(original, { ...props, useSessions, useWorkspaces, useSessionStatus, usePanelInfo, renderSlot,
    open: (id: string) => { if (!navigate(id)) localAction(() => props.open(id)) },
    startSession: (id?: string, options?: unknown) => { if (!id || !navigate(id, true)) localAction(() => props.startSession(id, options)) },
    requestSessionRename: (id: string, title: string) => { if (isRemoteNavigationKey(id)) adapter.requestRename(id, title); else props.requestSessionRename(id, title) },
    unarchiveSession: (id: string) => isRemoteNavigationKey(id) ? adapter.mutate(id, 'unarchive') : props.unarchiveSession?.(id),
    archiveSession: (id: string) => isRemoteNavigationKey(id) ? adapter.archive(id) : props.archiveSession?.(id),
    renameSession: (id: string, title: string) => isRemoteNavigationKey(id) ? adapter.renameDirect(id, title) : props.renameSession?.(id, title),
    forkSession: (id: string) => { if (isRemoteNavigationKey(id)) adapter.run(() => adapter.fork(id), id); else return props.forkSession?.(id) },
    ...Object.fromEntries((['pinSession', 'unpinSession'] as const).map(action => [action, (id: string) => isRemoteNavigationKey(id)
      ? adapter.mutate(id, action === 'pinSession' ? 'pin' : 'unpin') : props[action]?.(id)])),
    renameWorkspace: localOnly('renameWorkspace'), deleteWorkspace: localOnly('deleteWorkspace'),
    insertWorkspaceBefore: async (id: string, before?: string) => {
      setActionIssue('')
      try {
        const saved = order.move(id, before, combined.workspaces.items.map(item => item.workspaceId))
        if (!saved) setActionIssue(tt('remote.workspaceOrderTemporary'))
      } catch {
        setActionIssue(tt('remote.workspaceOrderFailed'))
        throw new Error(tt('remote.workspaceOrderFailed'))
      }
    },
  })}{navigationIssue && <p role="alert">{tt('remote.unsavedDraft')}</p>}{(actionIssue || adapterState.issue) && <p role="alert">{actionIssue || adapterState.issue} <button type="button" className={css.linkButton} onClick={() => { setActionIssue(''); adapter.report('') }}>{tt('remote.dismissIssue')}</button></p>}
  </>
}

/** Reuse the actual native browser, store, folder rows and keyboard/search UI. */
export function mountNativeWorkspaces(ctx: Context, adapter = new NativeSessionAdapter()): () => void {
  const workspaceOrder = new WorkspaceOrder()
  const slots = ctx.slots as unknown as Parameters<typeof projectEntry>[0] & { inject(name: string, callback: () => () => void): () => void }
  const stopOverlays = mountNativeSessionOverlays(slots, adapter)
  let original: StoredEntry | undefined, release: (() => void) | undefined, syncing = false
  const wrappers = new Set<unknown>()
  const sync = () => {
    if (syncing) return
    syncing = true
    try {
      const next = [...slots.entries('sidebar.workspaces')].filter(entry => !wrappers.has(entry.component))
        .sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0]
      if (original === next) return
      release?.(); release = undefined; original = next
      if (!next) { remoteNavigation.native(false); return }
      const projected = projectEntry(slots, 'sidebar.workspaces', next, props => <NativeWorkspaces {...props} workspaceOrder={workspaceOrder} sessionAdapter={adapter} original={next.component as ComponentType<Props>} />, (next.options.priority ?? 0) - 100, adapter.renderChild)
      wrappers.add(projected.component); release = projected.dispose; remoteNavigation.native(true)
    } finally { syncing = false }
  }
  const stopNative = slots.inject('sidebar.workspaces', () => { sync(); const unsubscribe = slots.subscribe('sidebar.workspaces', sync); return () => { unsubscribe(); release?.(); original = undefined; wrappers.clear(); remoteNavigation.native(false) } })
  return () => { stopNative(); stopOverlays() }
}

/** Keep the native New Session controls pointed at the visible Host without
 * retargeting any local Controller, global service or persisted Session. */
export function mountNativeSessionControls(ctx: Context): () => void {
  const slots = ctx.slots as unknown as Parameters<typeof projectEntry>[0] & { inject(name: string, callback: () => () => void): () => void }
  const disposers = ['sidebar', 'shell.leading'].map(name => {
    let release: (() => void) | undefined, original: StoredEntry | undefined, syncing = false
    const wrappers = new Set<unknown>()
    const sync = () => {
      if (syncing) return
      syncing = true
      try {
        const next = [...slots.entries(name)].filter(entry => !wrappers.has(entry.component)).sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0]
        if (next === original) return
        release?.(); release = undefined; original = next
        if (!next) return
        const projected = projectEntry(slots, name, next, props => createElement(next.component as ComponentType<Props>, { ...props,
          startSession: (...args: unknown[]) => {
            const selection = remoteSelection()
            const workspace = selection && remoteNavigation.getSnapshot().workspaces.find(item => item.id === selection.workspaceId)
            if (workspace) remoteNavigation.open(workspace, undefined, true)
            else (props.startSession as (...args: unknown[]) => void)(...args)
          },
        }), (next.options.priority ?? 0) - 100)
        wrappers.add(projected.component); release = projected.dispose
      } finally { syncing = false }
    }
    return slots.inject(name, () => { sync(); const unsubscribe = slots.subscribe(name, sync); return () => { unsubscribe(); release?.(); original = undefined; wrappers.clear() } })
  })
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
