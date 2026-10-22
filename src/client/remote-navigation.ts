import type { RemotePhase, RemoteSessionCatalog, RemoteWorkspace } from '../remote/types.ts'

export interface RemoteNavigationSnapshot {
  workspaces: readonly RemoteWorkspace[]
  catalogs: ReadonlyMap<string, RemoteSessionCatalog>
  native: boolean
  hosts?: ReadonlyMap<string, RemotePhase>
}
let snapshot: RemoteNavigationSnapshot = { workspaces: [], catalogs: new Map(), native: false }
const listeners = new Set<() => void>()
let open: ((workspace: RemoteWorkspace, sessionId?: string, create?: boolean) => void) | undefined
let cancel: (() => void) | undefined
let intent = 0
const pending = new Map<string, AbortController>()
const publish = (next: RemoteNavigationSnapshot) => { snapshot = next; for (const listener of listeners) listener() }
export const remoteNavigation = {
  getSnapshot: () => snapshot,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  native(value: boolean) { publish({ ...snapshot, native: value }) },
  bind(handler: typeof open, stop?: () => void) { open = handler; cancel = stop; return () => { if (open === handler) { open = undefined; cancel = undefined } } },
  /** Stops only local navigation observation; never cancels a remote task. */
  cancelOpen() { ++intent; cancel?.() },
  intent: () => intent,
  update(workspaces: readonly RemoteWorkspace[], hosts: readonly { hostId: string; phase: RemotePhase }[] = []) { publish({ ...snapshot, workspaces, hosts: new Map(hosts.map(host => [host.hostId, host.phase])) }) },
  stale() { publish({ ...snapshot, hosts: new Map(), catalogs: new Map([...snapshot.catalogs].map(([id, catalog]) => [id, { ...catalog, stale: true }])) }) },
  open(workspace: RemoteWorkspace, sessionId?: string, create?: boolean) { ++intent; open?.(workspace, sessionId, create) },
  async refresh(workspace: RemoteWorkspace) {
    if (pending.has(workspace.id)) return
    const controller = new AbortController(); pending.set(workspace.id, controller)
    const deadline = setTimeout(() => controller.abort(), 10000)
    let catalog = snapshot.catalogs.get(workspace.id)
    try {
      const response = await fetch(`/api/dsh-ssh/remote/sessions?id=${encodeURIComponent(workspace.id)}`, { cache: 'no-store', signal: controller.signal })
      if (!response.ok) throw new Error()
      const value = await response.json() as RemoteSessionCatalog
      controller.signal.throwIfAborted()
      if (value.workspaceId !== workspace.workspaceId || !Array.isArray(value.sessions)) throw new Error()
      catalog = value
    } catch {
      catalog = { ...(catalog ?? { workspaceId: workspace.workspaceId, sessions: [] }), stale: true, warning: 'unavailable' }
    } finally {
      clearTimeout(deadline)
      const owned = pending.get(workspace.id) === controller
      if (owned) pending.delete(workspace.id)
      if (owned && snapshot.workspaces.some(item => item.id === workspace.id && item.hostId === workspace.hostId)) {
        const catalogs = new Map(snapshot.catalogs); catalogs.set(workspace.id, catalog!)
        publish({ ...snapshot, catalogs })
      }
    }
  },
  clear() { for (const controller of pending.values()) controller.abort(); pending.clear(); publish({ ...snapshot, workspaces: [], catalogs: new Map() }) },
}

const prefix = 'dsh-ssh-nav:'
export const remoteWorkspaceKey = (workspace: RemoteWorkspace) => prefix + 'w:' + encodeURIComponent(workspace.id)
export const remoteSessionKey = (workspace: RemoteWorkspace, sessionId?: string) => prefix + 's:' + encodeURIComponent(workspace.id) + ':' + encodeURIComponent(sessionId ?? '')
export const isRemoteNavigationKey = (value: unknown): value is string => typeof value === 'string' && value.startsWith(prefix)
export function resolveRemoteNavigation(value: string, state = snapshot): { workspace: RemoteWorkspace; sessionId?: string } | undefined {
  for (const workspace of state.workspaces) {
    if (value === remoteWorkspaceKey(workspace) || value === remoteSessionKey(workspace)) return { workspace }
    for (const session of state.catalogs.get(workspace.id)?.sessions ?? []) if (value === remoteSessionKey(workspace, session.sessionId)) return { workspace, sessionId: session.sessionId }
  }
}
