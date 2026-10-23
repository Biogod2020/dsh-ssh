import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal, MenuItemButton, IconArchiveOutlineRegular, IconUnarchiveOutlineRegular, IconPinOutlineRegular, IconPinFillRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { projectEntry } from './slot-projection.tsx'
import { isRemoteNavigationKey, remoteNavigation, remoteSessionKey, remoteWorkspaceKey, resolveRemoteNavigation, type RemoteNavigationSnapshot } from './remote-navigation.ts'
import { remoteSelection, remotePresentation, subscribeRemoteSelection, type RemoteSelection } from './remote-presentation.ts'
import { tt } from './panel/helpers.ts'
import { archiveRemoteSession, mutateRemoteSession, type RemoteSessionAction } from './remote-session-action.ts'
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

function RemoteSessionActions({ sessionId, remote, menu, row = false, rename, report }: {
  sessionId: string; remote: RemoteNavigationSnapshot; menu?: MenuOwner; row?: boolean; rename(key: string, title: string): void; report(message: string): void
}) {
  const [busy, setBusy] = useState(false), pending = useRef(false)
  const target = resolveRemoteNavigation(sessionId, remote), catalog = target && remote.catalogs.get(target.workspace.id)
  const archived = !!catalog?.archivedSessions?.some(value => value.sessionId === target?.sessionId)
  const session = [...catalog?.sessions ?? [], ...catalog?.archivedSessions ?? []].find(value => value.sessionId === target?.sessionId)
  if (!target?.sessionId || !session) return null
  const disabled = busy || catalog?.stale === true || !navigator.onLine
  const run = (action: RemoteSessionAction) => {
    if (disabled || pending.current) return
    pending.current = true; setBusy(true); report('')
    void (async () => {
      if (action === 'archive') { if (!await archiveRemoteSession(target.workspace, target.sessionId!)) return }
      else await mutateRemoteSession(target.workspace, target.sessionId!, action)
      menu?.[1](false)
    })().catch(() => report(tt('remote.actionUnconfirmed'))).finally(() => { pending.current = false; setBusy(false) })
  }
  const archiveLabel = tt(archived ? 'remote.unarchiveSession' : 'remote.archiveSession')
  const pinLabel = tt(session.pinned ? 'remote.unpinSession' : 'remote.pinSession')
  if (row) return <>
    <button type="button" className={css.remoteSessionAction} disabled={disabled} aria-label={archiveLabel} title={archiveLabel} onClick={event => { event.stopPropagation(); run(archived ? 'unarchive' : 'archive') }}>
      {archived ? <IconUnarchiveOutlineRegular size={14} /> : <IconArchiveOutlineRegular size={14} />}
    </button>
    {!archived && <button type="button" className={css.remoteSessionAction} disabled={disabled} aria-label={pinLabel} title={pinLabel} onClick={event => { event.stopPropagation(); run(session.pinned ? 'unpin' : 'pin') }}>
      {session.pinned ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} />}
    </button>}
  </>
  return <>
    <MenuItemButton disabled={disabled} onSelect={() => { menu?.[1](false); rename(sessionId, session.title) }}>{tt('remote.renameSession')}</MenuItemButton>
    <MenuItemButton disabled={disabled} onSelect={() => run(archived ? 'unarchive' : 'archive')}>{archiveLabel}</MenuItemButton>
    {!archived && <MenuItemButton disabled={disabled} onSelect={() => run(session.pinned ? 'unpin' : 'pin')}>{pinLabel}</MenuItemButton>}
  </>
}

/** Request state belongs to this menu opening, not to the whole sidebar. */
function RemoteSessionMenu({ sessionId, remote, menu, navigate, rename, report }: {
  sessionId: string; remote: RemoteNavigationSnapshot; menu?: MenuOwner; navigate(key: string): boolean; rename(key: string, title: string): void; report(message: string): void
}) {
  const [settings, setSettings] = useState<{ busy?: boolean; error?: 'settings' | 'draft' }>({})
  const settingsAttempt = useRef(0)
  const open = menu?.[0] ?? true
  useEffect(() => {
    ++settingsAttempt.current; setSettings({})
    return () => { ++settingsAttempt.current }
  }, [open, sessionId])
  return <>
    <MenuItemButton onSelect={() => { menu?.[1](false); navigate(sessionId) }}>{tt('remote.openConversation')}</MenuItemButton>
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
      const target = resolveRemoteNavigation(sessionId, remote)
      if (!target) return
      const attempt = ++settingsAttempt.current
      void Promise.resolve().then(() => remotePresentation()?.close?.(target.workspace)).then(() => {
        if (attempt === settingsAttempt.current) menu?.[1](false)
      }).catch(() => { if (attempt === settingsAttempt.current) setSettings({ error: 'draft' }) })
    }}>{tt('remote.closeView')}</MenuItemButton>
    <RemoteSessionActions sessionId={sessionId} remote={remote} menu={menu} rename={rename} report={report} />
  </>
}

export function combineNavigation(list: List, workspaces: Workspaces, remote: RemoteNavigationSnapshot, selected?: RemoteSelection) {
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
    items.push({ workspaceId: remoteWorkspaceKey(workspace), path: `ssh://${workspace.alias}${workspace.remotePath}`, title: workspace.title, sessionIds,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(Math.max(0, ...sessions.map(session => session.updatedAt))).toISOString() })
  }
  return { list: { ...list, ids, byId }, workspaces: { ...workspaces, items, pinnedSessionIds, archivedSessionIds } }
}

export function NativeWorkspaces({ original, ...props }: Props & { original: ComponentType<Props> }) {
  const [navigationIssue, setNavigationIssue] = useState(false)
  const [actionIssue, setActionIssue] = useState('')
  const [renameTarget, setRenameTarget] = useState<{ key: string; title: string; hostId: string }>()
  const [renameBusy, setRenameBusy] = useState(false), renamePending = useRef(false)
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
  const combined = useMemo(() => combineNavigation(localList, localWorkspaces, remote, selected), [localList, localWorkspaces, remote, selected])
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
  const requestRemoteRename = (key: string, title: string) => {
    const target = resolveRemoteNavigation(key, remote)
    if (!target?.sessionId) { setActionIssue(tt('remote.desktopIdentityChanged')); return }
    setActionIssue(''); setRenameTarget({ key, title, hostId: target.workspace.hostId })
  }
  const renderSlot = (name: string, owner: Props, ...rest: any[]) => {
    if (isRemoteNavigationKey(owner?.sessionId)) {
      if (name === 'sidebar.session.row.hover') return <span>{tt('remote.remoteSession')}</span>
      if (name === 'sidebar.workspaces.session.menu.item') return <RemoteSessionMenu
        sessionId={owner.sessionId} remote={remote} menu={rest[0]?.hookContext} navigate={navigate}
        rename={requestRemoteRename} report={setActionIssue} />
      if (name === 'sidebar.workspaces.session.row.action') return <RemoteSessionActions sessionId={owner.sessionId} remote={remote} row
        rename={requestRemoteRename} report={setActionIssue} />
      return null // Native row actions address the local Host; never pass a remote id.
    }
    return props.renderSlot(name, owner, ...rest)
  }
  return <>{createElement(original, { ...props, useSessions, useWorkspaces, useSessionStatus, usePanelInfo, renderSlot,
    open: (id: string) => { if (!navigate(id)) localAction(() => props.open(id)) },
    startSession: (id?: string, options?: unknown) => { if (!id || !navigate(id, true)) localAction(() => props.startSession(id, options)) },
    requestSessionRename: (id: string, title: string) => { if (isRemoteNavigationKey(id)) requestRemoteRename(id, title); else props.requestSessionRename(id, title) },
    unarchiveSession: (id: string) => {
      const target = resolveRemoteNavigation(id, remote)
      if (!isRemoteNavigationKey(id)) return props.unarchiveSession?.(id)
      if (target?.sessionId) return mutateRemoteSession(target.workspace, target.sessionId, 'unarchive').catch(error => { setActionIssue(tt('remote.actionUnconfirmed')); throw error })
      return Promise.reject(new Error(tt('remote.desktopIdentityChanged')))
    },
    archiveSession: (id: string) => {
      if (!isRemoteNavigationKey(id)) return props.archiveSession?.(id)
      const target = resolveRemoteNavigation(id, remote)
      if (!target?.sessionId) return Promise.reject(new Error(tt('remote.desktopIdentityChanged')))
      return archiveRemoteSession(target.workspace, target.sessionId)
    },
    renameSession: (id: string, title: string) => {
      if (!isRemoteNavigationKey(id)) return props.renameSession?.(id, title)
      const target = resolveRemoteNavigation(id, remote)
      if (!target?.sessionId) return Promise.reject(new Error(tt('remote.desktopIdentityChanged')))
      return mutateRemoteSession(target.workspace, target.sessionId, 'rename', title)
    },
    forkSession: localOnly('forkSession'),
    ...Object.fromEntries((['pinSession', 'unpinSession'] as const).map(action => [action, (id: string) => {
      if (!isRemoteNavigationKey(id)) return props[action]?.(id)
      const target = resolveRemoteNavigation(id, remote)
      if (!target?.sessionId) return Promise.reject(new Error(tt('remote.desktopIdentityChanged')))
      return mutateRemoteSession(target.workspace, target.sessionId, action === 'pinSession' ? 'pin' : 'unpin')
    }])),
    renameWorkspace: localOnly('renameWorkspace'), deleteWorkspace: localOnly('deleteWorkspace'), insertWorkspaceBefore: localOnly('insertWorkspaceBefore'),
  })}{navigationIssue && <p role="alert">{tt('remote.unsavedDraft')}</p>}{actionIssue && <p role="alert">{actionIssue}</p>}
  {renameTarget && <Modal open title={tt('remote.renameSession')} closeLabel={tt('remote.actionCancel')} onClose={() => { if (!renamePending.current) setRenameTarget(undefined) }}
    footer={<><Button disabled={renameBusy} onClick={() => setRenameTarget(undefined)}>{tt('remote.actionCancel')}</Button><Button disabled={renameBusy || !renameTarget.title.trim()} onClick={() => {
      if (renamePending.current) return
      const target = resolveRemoteNavigation(renameTarget.key, remote)
      if (!target?.sessionId || target.workspace.hostId !== renameTarget.hostId) { setActionIssue(tt('remote.desktopIdentityChanged')); return }
      renamePending.current = true; setRenameBusy(true)
      void mutateRemoteSession(target.workspace, target.sessionId, 'rename', renameTarget.title).then(() => setRenameTarget(undefined))
        .catch(() => setActionIssue(tt('remote.actionUnconfirmed'))).finally(() => { renamePending.current = false; setRenameBusy(false) })
    }}>{tt('remote.actionSave')}</Button></>}>
    <input aria-label={tt('remote.sessionName')} data-modal-autofocus value={renameTarget.title} disabled={renameBusy} maxLength={1024}
      onChange={event => setRenameTarget({ ...renameTarget, title: event.target.value })} />
  </Modal>}</>
}

/** Reuse the actual native browser, store, folder rows and keyboard/search UI. */
export function mountNativeWorkspaces(ctx: Context): () => void {
  const slots = ctx.slots as unknown as Parameters<typeof projectEntry>[0] & { inject(name: string, callback: () => () => void): () => void }
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
      const projected = projectEntry(slots, 'sidebar.workspaces', next, props => <NativeWorkspaces {...props} original={next.component as ComponentType<Props>} />, (next.options.priority ?? 0) - 100)
      wrappers.add(projected.component); release = projected.dispose; remoteNavigation.native(true)
    } finally { syncing = false }
  }
  return slots.inject('sidebar.workspaces', () => { sync(); const unsubscribe = slots.subscribe('sidebar.workspaces', sync); return () => { unsubscribe(); release?.(); original = undefined; wrappers.clear(); remoteNavigation.native(false) } })
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
