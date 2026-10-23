/** Serialized as an ordinary Client plugin. Uses only the public navigation and
 * catalog services of the remote Host; no prompts, commands or credentials. */
export function navigationClient(): void {
  type Catalog = { byId?: Record<string, { id: string; retainedBy?: { mainView?: number } }> }
  type Workspace = { workspaceId: string; sessionIds: string[] }
  type Ctx = {
    uiWorkspace: { openSession(id: string): void }
    sessions: { list: { getSnapshot(): Catalog }; retain?(id: string, options: { source: string }): { ready?: Promise<unknown>; release(): void } }
    workspaces: { list: { getSnapshot(): { items: Workspace[]; archivedSessionIds?: string[] } } }
    slots?: {entries(name:string):readonly {options?:{id?:string};store?:{create?():{actions?:{openSection?(id:string):void}}}}[]}
    get?(name: string): unknown
    effect(fn: () => () => void, label: string): void
    root: { inject(deps: string[], apply: (ctx: Ctx) => void): { dispose(): unknown } }
  }
  type Bridge = { state(): { sessionId?: string; workspaceId?: string }; open(sessionId: string): boolean | Promise<boolean>; select(workspaceId: string, sessionId: string): boolean | Promise<boolean>; settings():boolean; cancelNavigation():void; inspection(): object }
  const target = window as unknown as {
    __ModuleLoader__?: { load(value: unknown): void }
    __dshSshView?: Bridge
    __dshSshNavigationOwner?: { dispose(): unknown }
    __dshSshDrafts?: { prepare(sessionId: string, signal?: AbortSignal): Promise<void>; inspection?(): unknown }
    __dshSshOperations?: { inspection(): unknown }
  }
  target.__ModuleLoader__?.load({ id: '@jay-local/dsh-ssh-navigation', factory: () => ({
    inject: ['uiWorkspace', 'sessions', 'workspaces','slots'],
    apply(ctx: Ctx) {
      // Host manifest reconciliation only owns its server-declared entries.
      // Keep this document's contribution under a page-owned root fiber, so
      // the first Host graph cannot remove the bridge immediately after boot.
      if (target.__dshSshNavigationOwner) return
      const owner = ctx.root.inject(['uiWorkspace', 'sessions', 'workspaces','slots'], install)
      target.__dshSshNavigationOwner = owner
      const pageHide = (event: PageTransitionEvent) => { if (!event.persisted) { void owner.dispose(); window.removeEventListener('pagehide', pageHide) } }
      window.addEventListener('pagehide', pageHide)
    },
  }) })
  function install(ctx: Ctx): void {
      let navigationAttempt = 0
      let navigationRead:AbortController|undefined
      const cancelNavigation=()=>{++navigationAttempt;navigationRead?.abort();navigationRead=undefined}
      const attemptNavigation=()=>{cancelNavigation();navigationRead=new AbortController();return{attempt:navigationAttempt,signal:navigationRead.signal}}
      const retained = new Map<string, { reference: { release(): void }; usedAt: number }>()
      const release = (id: string) => { const value = retained.get(id); retained.delete(id); value?.reference.release() }
      const prune = () => {
        const catalog = ctx.workspaces.list.getSnapshot()
        for (const [id, value] of retained) if (Date.now() - value.usedAt >= 5 * 60000
          || !catalog.items.some(item => item.sessionIds.includes(id)) || catalog.archivedSessionIds?.includes(id)) release(id)
      }
      const remember = (id: string | undefined) => {
        if (!id || !ctx.sessions.retain) return
        prune()
        const catalog = ctx.workspaces.list.getSnapshot()
        if (!catalog.items.some(item => item.sessionIds.includes(id)) || catalog.archivedSessionIds?.includes(id)) return
        const previous = retained.get(id)
        if (previous) { retained.delete(id); retained.set(id, { ...previous, usedAt: Date.now() }); return }
        try {
          const reference = ctx.sessions.retain(id, { source: 'sshNavigationCache' })
          const value = { reference, usedAt: Date.now() }; retained.set(id, value)
          void reference.ready?.catch(() => { if (retained.get(id)?.reference === reference) release(id) })
          while (retained.size > 3) release(retained.keys().next().value!)
        } catch { /* Cache availability must not block ordinary navigation. */ }
      }
      const open = (sessionId: string) => {
        // Keep the previous Client alive before uiWorkspace releases mainView.
        // Only visited Sessions are retained: no prefetch or Agent dispatch.
        remember(bridge.state().sessionId)
        ctx.uiWorkspace.openSession(sessionId)
        remember(sessionId)
      }
      const bridge: Bridge = {
        cancelNavigation,
        inspection() {
          // Chromium's optional number estimates a renderer's JS heap. It
          // excludes native/GPU memory and may include a shared realm.
          let heap: unknown
          try { heap = (performance as Performance & { memory?: { usedJSHeapSize?: unknown } }).memory?.usedJSHeapSize } catch { /* Keep unknown. */ }
          let tabs: { kind: string }[] | undefined
          try {
            const sidebar = ctx.get?.('sidebarRight') as { openTabs?: { getSnapshot?(): unknown } } | undefined
            const value = sidebar?.openTabs?.getSnapshot?.()
            if (Array.isArray(value) && value.length <= 10000 && value.every(row => row && typeof row.kind === 'string')) tabs = value
          } catch { /* Missing contracts cannot prove a view is idle. */ }
          let drafts: object | null = null
          try {
            const value = target.__dshSshDrafts?.inspection?.() as any
            const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
            const states = ['loading', 'saved', 'unsaved', 'saving', 'conflict', 'error']
            if (value && count(value.pendingUnmountSaves) && count(value.failedUnmountSaves)
              && Array.isArray(value.sessions) && value.sessions.length <= 256 && value.sessions.every((row: any) =>
                row && typeof row.sessionId === 'string' && row.sessionId.length > 0 && row.sessionId.length <= 256
                && states.includes(row.status) && count(row.revision) && typeof row.persisted === 'boolean'
                && typeof row.hasReferences === 'boolean' && typeof row.hasAttachments === 'boolean')) {
              drafts = { pendingUnmountSaves: value.pendingUnmountSaves, failedUnmountSaves: value.failedUnmountSaves,
                sessions: value.sessions.map((row: any) => ({ sessionId: row.sessionId, status: row.status, revision: row.revision,
                  persisted: row.persisted, hasReferences: row.hasReferences, hasAttachments: row.hasAttachments,
                  inputPhase: ['plain', 'submitting', 'adjudicating'].includes(row.inputPhase) ? row.inputPhase : 'unknown' })) }
            }
          } catch { /* No draft text or extension fields enter diagnostics. */ }
          let navigation: ReturnType<Bridge['state']> | null = null
          try { navigation = bridge.state() } catch { /* Keep unknown. */ }
          let lifecycle: object = { scope: 'observation-only', pendingRequests: null, unconfirmedOperations: null }
          try {
            const value = target.__dshSshOperations?.inspection() as any, unary = value?.unary
            if (value?.version === 1 && value.scope === 'unary-observation' && value.fullCoverage === false
              && value.automaticReleaseEligible === false && value.pendingRequests === null && value.unconfirmedOperations === null
              && Number.isSafeInteger(unary?.observedPendingRequests) && unary.observedPendingRequests >= 0
              && typeof unary.rpcDecoratorAttached === 'boolean' && typeof unary.scopedFetchObserved === 'boolean') {
              lifecycle = { scope: 'unary-observation', pendingRequests: null, unconfirmedOperations: null,
                unary: { observedPendingRequests: unary.observedPendingRequests, rpcDecoratorAttached: unary.rpcDecoratorAttached, scopedFetchObserved: unary.scopedFetchObserved } }
            }
          } catch { /* Partial or missing observation cannot authorize release. */ }
          return {
            version: 1, sampledAt: Date.now(), navigation,
            memory: { kind: 'renderer-js-heap-estimate', bytes: typeof heap === 'number' && Number.isSafeInteger(heap) && heap > 0 ? heap : null },
            // openTabs includes inactive Sessions. This never closes a tab.
            sidebar: tabs ? { tabs: tabs.length, terminals: tabs.filter(row => row.kind === 'terminal').length } : null,
            drafts,
            // Sampling alone is not an atomic suspension or acknowledgement
            // barrier. Missing operation observations remain explicitly unknown.
            lifecycle,
          }
        },
        settings() {
          cancelNavigation()
          // Reach the owning remote shell's public slot/store contract only.
          // Missing contracts never fall back to the local Host's settings.
          if(!ctx.slots?.entries('settings.section').some(row=>row.options?.id==='models'))return false
          const shell=ctx.slots.entries('sidebar.settings').find(row=>typeof row.store?.create==='function')
          const actions=shell?.store?.create?.().actions
          if(typeof actions?.openSection!=='function')return false
          actions.openSection('models');return true
        },
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
          const {attempt,signal}=attemptNavigation()
          const apply = () => { if (attempt !== navigationAttempt) return false; open(sessionId); return true }
          return target.__dshSshDrafts ? target.__dshSshDrafts.prepare(sessionId,signal).then(apply) : apply()
        },
        select(workspaceId, sessionId) {
          if (typeof workspaceId !== 'string' || !workspaceId || typeof sessionId !== 'string' || !sessionId
            || sessionId.length > 256 || /[\u0000-\u001f\u007f]/.test(sessionId)) return false
          // The retained Client already follows this Host's live catalog. Do
          // not add network round trips to ordinary navigation or trust the
          // controller's saved sidebar list as proof of Workspace membership.
          const member = () => {
            const catalog = ctx.workspaces.list.getSnapshot()
            return catalog.items.some(item => item.workspaceId === workspaceId && item.sessionIds.includes(sessionId)) && !catalog.archivedSessionIds?.includes(sessionId)
          }
          if (!member()) return false
          const current = bridge.state()
          if (current.workspaceId === workspaceId && current.sessionId === sessionId) { cancelNavigation(); return true }
          const {attempt,signal}=attemptNavigation()
          const apply = () => { if (attempt !== navigationAttempt || !member()) return false; open(sessionId); return true }
          return target.__dshSshDrafts ? target.__dshSshDrafts.prepare(sessionId,signal).then(apply) : apply()
        },
      }
      target.__dshSshView = bridge
      const expiry = setInterval(prune, 30000)
      document.documentElement.setAttribute('data-dsh-ssh-navigation', 'ready')
      ctx.effect(() => () => {
        cancelNavigation()
        clearInterval(expiry)
        for (const id of retained.keys()) release(id)
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
  const rev = 'native-navigation-7'
  const additions: Row[] = [
    { id: '@jay-local/dsh-ssh-operations', url: '/__dsh_remote/operation-client.js?rev=unary-observation-1', rev: 'unary-observation-1', inject: ['@deepseek-ai/dsh-client-connection'] },
    { id: '@jay-local/dsh-ssh-navigation', url: '/__dsh_remote/navigation-client.js?rev=' + rev, rev, inject: ['@deepseek-ai/dsh-client-ui-workspace', '@deepseek-ai/dsh-client-ui-slots'] },
    { id: '@jay-local/dsh-ssh-drafts', url: '/__dsh_remote/draft-client.js?rev=local-drafts-3', rev: 'local-drafts-3', inject: ['@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-slots'] },
  ].filter(row => !boot.entries.some(existing => existing.id === row.id))
  if (!additions.length) return
  target.__DSH_BOOT__ = { ...boot, entries: [...boot.entries, ...additions],
    ...(Array.isArray(boot.batches) ? { batches: [...boot.batches, ...additions.map(row => ({ phase: 'application', url: row.url, rev: row.rev, entries: [row.id] }))] } : {}),
  }
}
