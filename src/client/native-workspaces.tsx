import { createElement, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { projectEntry } from './slot-projection.tsx'
import { isRemoteNavigationKey, remoteNavigation, remoteSessionKey, remoteWorkspaceKey, resolveRemoteNavigation, type RemoteNavigationSnapshot } from './remote-navigation.ts'
import { remoteSelection, remotePresentation, subscribeRemoteSelection, type RemoteSelection } from './remote-presentation.ts'
import { tt } from './panel/helpers.ts'
import css from './panel/panel.module.css'

// Presentation-only projections. Neither Controller nor the local Host receives
// these identities. Every action must be routed before leaving this component.
type Row = { id: string; title?: string; displayTitle: string; cwd?: string; running: boolean; blank: boolean; updatedAt: number; retainedBy: Record<string, number>; [key: string]: unknown }
type List = { ids: string[]; byId: Record<string, Row>; [key: string]: unknown }
type Workspace = { workspaceId: string; path: string; title: string; sessionIds: readonly string[]; [key: string]: unknown }
type Workspaces = { items: readonly Workspace[]; [key: string]: unknown }
type Hook = <T>(selector: (state: any) => T, equal?: (a: T, b: T) => boolean) => T
type Props = Record<string, any>

export function combineNavigation(list: List, workspaces: Workspaces, remote: RemoteNavigationSnapshot, selected?: RemoteSelection) {
  const byId = { ...list.byId }, ids = [...list.ids], items = workspaces.items.map(item => item.path.replaceAll('\\', '/').includes('/ssh-workspaces/')
    ? { ...item, title: `${item.title} · ${tt('remote.localHistory')}` } : item)
  if (selected) for (const [id, row] of Object.entries(byId)) if (row.retainedBy.mainView) byId[id] = {
    ...row, blank: false, retainedBy: { ...row.retainedBy, mainView: 0 },
  }
  for (const workspace of remote.workspaces) {
    const catalog = remote.catalogs.get(workspace.id)
    const sessions = catalog?.sessions ?? []
    const sessionIds: string[] = []
    for (const session of sessions) {
      const id = remoteSessionKey(workspace, session.sessionId)
      const title = session.title || tt('remote.newSessionTitle')
      byId[id] = { id, title, displayTitle: title, cwd: `${workspace.alias}:${workspace.remotePath}`, running: !catalog?.stale && session.running,
        blank: false, updatedAt: session.updatedAt, retainedBy: { mainView: selected?.workspaceId === workspace.id && selected.sessionId === session.sessionId ? 1 : 0 } }
      ids.push(id); sessionIds.push(id)
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
  return { list: { ...list, ids, byId }, workspaces: { ...workspaces, items } }
}

function NativeWorkspaces({ original, ...props }: Props & { original: ComponentType<Props> }) {
  const [settings,setSettings]=useState<{id?:string;busy?:boolean;error?:boolean}>({})
  const settingsAttempt=useRef(0)
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
    const target = resolveRemoteNavigation(key, remote)
    if (target) remoteNavigation.open(target.workspace, target.sessionId, create)
    return true
  }
  const localOnly = (action: string) => (...args: any[]) => {
    if (args.some(isRemoteNavigationKey)) throw new Error(tt('remote.actionInRemote'))
    return props[action](...args)
  }
  const renderSlot = (name: string, owner: Props, ...rest: any[]) => {
    if (isRemoteNavigationKey(owner?.sessionId)) {
      if (name === 'sidebar.session.row.hover') return <span>{tt('remote.remoteSession')}</span>
      if (name === 'sidebar.workspaces.session.menu.item') return <>
        <button type="button" role="menuitem" className={css.remoteNavigationMenuItem} onClick={() => {
          rest[0]?.hookContext?.[1]?.(false); navigate(owner.sessionId)
        }}>{tt('remote.openConversation')}</button>
        <button type="button" role="menuitem" className={css.remoteNavigationMenuItem} disabled={settings.id===owner.sessionId&&settings.busy} onClick={()=>{
          const id=owner.sessionId, target=resolveRemoteNavigation(id,remote)
          if(!target)return
          const attempt=++settingsAttempt.current
          setSettings({id,busy:true})
          void Promise.resolve(remotePresentation()?.settings?.(target.workspace)).then(ok=>{
            if(attempt===settingsAttempt.current)setSettings({id,error:!ok})
          }).catch(()=>{if(attempt===settingsAttempt.current)setSettings({id,error:true})})
        }}>{tt('remote.modelSettings')}</button>
        {settings.id===owner.sessionId&&settings.error&&<span role="alert">{tt('remote.settingsUnavailable')}</span>}
        <button type="button" role="menuitem" className={css.remoteNavigationMenuItem} onClick={() => {
          rest[0]?.hookContext?.[1]?.(false)
          const target = resolveRemoteNavigation(owner.sessionId, remote)
          if (target) remotePresentation()?.close?.(target.workspace)
        }}>{tt('remote.closeView')}</button>
      </>
      return null // Native row actions address the local Host; never pass a remote id.
    }
    return props.renderSlot(name, owner, ...rest)
  }
  return createElement(original, { ...props, useSessions, useWorkspaces, useSessionStatus, usePanelInfo, renderSlot,
    open: (id: string) => { if (!navigate(id)) props.open(id) },
    startSession: (id?: string, options?: unknown) => { if (!id || !navigate(id, true)) props.startSession(id, options) },
    requestSessionRename: (id: string, title: string) => { if (!navigate(id)) props.requestSessionRename(id, title) },
    renameWorkspace: localOnly('renameWorkspace'), deleteWorkspace: localOnly('deleteWorkspace'), insertWorkspaceBefore: localOnly('insertWorkspaceBefore'),
  })
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
