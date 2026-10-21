/** Serialized as an ordinary Client plugin. Uses only the public navigation and
 * catalog services of the remote Host; no prompts, commands or credentials. */
export function navigationClient(): void {
  type Catalog = { byId?: Record<string, { id: string; retainedBy?: { mainView?: number } }> }
  type Workspace = { workspaceId: string; sessionIds: string[] }
  type Ctx = {
    uiWorkspace: { openSession(id: string): void }
    sessions: { list: { getSnapshot(): Catalog } }
    workspaces: { list: { getSnapshot(): { items: Workspace[] } } }
    effect(fn: () => () => void, label: string): void
    root: { inject(deps: string[], apply: (ctx: Ctx) => void): { dispose(): unknown } }
  }
  type Bridge = { state(): { sessionId?: string; workspaceId?: string }; open(sessionId: string): void }
  const target = window as unknown as {
    __ModuleLoader__?: { load(value: unknown): void }
    __dshSshView?: Bridge
    __dshSshNavigationOwner?: { dispose(): unknown }
  }
  target.__ModuleLoader__?.load({ id: '@jay-local/dsh-ssh-navigation', factory: () => ({
    inject: ['uiWorkspace', 'sessions', 'workspaces'],
    apply(ctx: Ctx) {
      // Host manifest reconciliation only owns its server-declared entries.
      // Keep this document's contribution under a page-owned root fiber, so
      // the first Host graph cannot remove the bridge immediately after boot.
      if (target.__dshSshNavigationOwner) return
      const owner = ctx.root.inject(['uiWorkspace', 'sessions', 'workspaces'], install)
      target.__dshSshNavigationOwner = owner
      const pageHide = (event: PageTransitionEvent) => { if (!event.persisted) { void owner.dispose(); window.removeEventListener('pagehide', pageHide) } }
      window.addEventListener('pagehide', pageHide)
    },
  }) })
  function install(ctx: Ctx): void {
      const bridge: Bridge = {
        state() {
          const rows = ctx.sessions.list.getSnapshot().byId
          let sessionId = rows && Object.values(rows).find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id
          // Older supported clients persist the main selection in this public
          // navigation store before their catalog gains reference counts.
          if (!sessionId) try {
            const saved = JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}')
            if (typeof saved.sessionId === 'string') sessionId = saved.sessionId
          } catch { /* An absent selection is legitimate. */ }
          const workspaceId = ctx.workspaces.list.getSnapshot().items.find(item => sessionId && item.sessionIds.includes(sessionId))?.workspaceId
          return { sessionId, workspaceId }
        },
        open(sessionId) {
          if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 || /[\u0000-\u001f\u007f]/.test(sessionId)) throw new Error('Invalid remote Session')
          ctx.uiWorkspace.openSession(sessionId)
        },
      }
      target.__dshSshView = bridge
      document.documentElement.setAttribute('data-dsh-ssh-navigation', 'ready')
      ctx.effect(() => () => {
        if (target.__dshSshView === bridge) { delete target.__dshSshView; document.documentElement.removeAttribute('data-dsh-ssh-navigation') }
      }, 'SSH view: native navigation')
  }
}

/** Extend the document's boot graph before the framework starts. This is a
 * page-local contribution, not a remote installation or live Context mutation. */
export function navigationManifest(): void {
  type Row = { id: string; url: string; rev: string; inject: string[] }
  type Batch = { phase: string; url: string; rev: string; entries: string[] }
  const target = window as unknown as { __DSH_BOOT__?: { entries: Row[]; batches?: Batch[] } }
  const boot = target.__DSH_BOOT__
  if (!boot || !Array.isArray(boot.entries)) return
  const id = '@jay-local/dsh-ssh-navigation', rev = 'native-navigation-2', url = '/__dsh_remote/navigation-client.js?rev=' + rev
  if (boot.entries.some(row => row.id === id)) return
  target.__DSH_BOOT__ = { ...boot, entries: [...boot.entries, { id, url, rev, inject: ['@deepseek-ai/dsh-client-ui-workspace'] }],
    ...(Array.isArray(boot.batches) ? { batches: [...boot.batches, { phase: 'application', url, rev, entries: [id] }] } : {}),
  }
}
