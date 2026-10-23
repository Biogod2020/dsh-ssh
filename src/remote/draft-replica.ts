import type { DraftSeed } from './draft-client.ts'
import type { SavedDraft } from './draft-store.ts'

export interface DraftInput { draft: string; draftRev: number; phase: string; occurrences?: readonly unknown[]; attachmentIds?: readonly unknown[] }
export interface DraftState {
  status: 'loading' | 'saved' | 'unsaved' | 'saving' | 'conflict' | 'error'
  savedText?: string; hadReferences: boolean; hadAttachments: boolean
}
/** Self-contained so the authenticated gateway can serialize the same tested
 * implementation into the owning remote Client, without a remote installation. */
export function createDraftReplica(options: {
  hostId: string; sessionId: string; input: DraftInput; seed?: DraftSeed; browserDraftExisted?: boolean
  restore(text: string): void
}) {
  let input = { ...options.input }, baseline: SavedDraft | undefined, ready = false, mounted = true, seeded = false
  let references = false, attachments = false, timer: ReturnType<typeof setTimeout> | undefined
  let loading: Promise<boolean> | undefined, saving: Promise<boolean> | undefined
  let retiredInput: { text: string; hadReferences: boolean; hadAttachments: boolean } | undefined
  let state: DraftState = { status: 'loading', hadReferences: false, hadAttachments: false }
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of [...listeners]) listener() }
  const publish = (status: DraftState['status']) => {
    state = { status, ...(status === 'conflict' ? { savedText: baseline?.text ?? '' } : {}), hadReferences: references, hadAttachments: attachments }
    notify()
  }
  const payload = () => retiredInput ?? ({ text: input.draft, hadReferences: references || !!input.occurrences?.length, hadAttachments: attachments || !!input.attachmentIds?.length })
  const dirty = () => {
    const current = payload()
    return current.text !== (baseline?.text ?? '') || current.hadReferences !== (baseline?.hadReferences ?? false)
      || current.hadAttachments !== (baseline?.hadAttachments ?? false)
  }
  const endpoint = '/__dsh_remote/draft?sessionId=' + encodeURIComponent(options.sessionId)
  async function request(init?: RequestInit) {
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 5000)
    try {
      const response = await fetch(endpoint, { ...init, cache: 'no-store', signal: controller.signal })
      const value = await response.json() as { draft?: SavedDraft; issue?: string }
      if (value.draft && (value.draft.hostId !== options.hostId || value.draft.sessionId !== options.sessionId
        || typeof value.draft.revision !== 'string' || typeof value.draft.operationId !== 'string' || typeof value.draft.text !== 'string'
        || typeof value.draft.hadReferences !== 'boolean' || typeof value.draft.hadAttachments !== 'boolean')) throw new Error('Invalid saved draft response')
      return { response, value }
    } finally { clearTimeout(deadline) }
  }
  const schedule = () => {
    clearTimeout(timer)
    if (!ready || !dirty() || state.status === 'conflict' || state.status === 'error') return
    if (!saving) publish('unsaved')
    timer = setTimeout(() => { void flush() }, 350)
  }
  function load(force = false): Promise<boolean> {
    if (saving) return saving.then(() => load(force))
    if (loading) return loading
    if (ready && !force) return Promise.resolve(true)
    const began = { ...input }, alreadyConflicted = state.status === 'conflict'
    loading = Promise.resolve().then(async () => {
      try {
        const initial = !seeded && !force ? options.seed : undefined; seeded = true
        let value: { draft?: SavedDraft; issue?: string }
        if (initial) {
          if (initial.hostId !== options.hostId || initial.sessionId !== options.sessionId) throw new Error('Invalid draft seed owner')
          value = initial
        } else {
          const result = await request(); if (!result.response.ok) throw new Error('Draft read failed'); value = result.value
        }
        if (!mounted) return false
        if (value.issue) throw new Error('Draft storage needs inspection')
        baseline = value.draft
        references = !!baseline?.hadReferences && !input.occurrences?.length
        attachments = !!baseline?.hadAttachments && !input.attachmentIds?.length
        if (baseline && baseline.text !== input.draft) {
          if (initial?.nativeBoot) {
            // The editor was already seeded before boot. A different value
            // now is an actual local edit, including a quick explicit clear.
          } else if (!alreadyConflicted && !(initial?.browserDraftExisted ?? options.browserDraftExisted ?? false) && !input.draft && !began.draft && input.draftRev === began.draftRev && !['submitting', 'adjudicating'].includes(input.phase)) {
            options.restore(baseline.text)
            // Own the imported text until the native hook publishes it. This
            // prevents an old empty render from being saved over the import.
            input = { ...input, draft: baseline.text }
          } else { ready = false; publish('conflict'); return false }
        }
        ready = true; publish(dirty() ? 'unsaved' : 'saved'); schedule(); return true
      } catch { if (mounted) { ready = false; publish('error') }; return false }
      finally { loading = undefined; notify() }
    })
    return loading
  }
  async function commit(): Promise<boolean> {
    if (!ready || state.status === 'conflict') return false
    while (dirty()) {
      const snapshot = payload(), operationId = crypto.randomUUID(), revision = baseline?.revision ?? null
      publish('saving')
      let confirmed: SavedDraft | undefined
      try {
        const result = await request({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...snapshot, expectedRevision: revision, operationId }) })
        if (result.response.status === 409) {
          const current = await request()
          if (current.response.ok && !current.value.issue) baseline = current.value.draft
          if (current.response.ok && !current.value.issue && baseline && !dirty()) { publish('saved'); return true }
          ready = false; publish('conflict'); return false
        }
        if (!result.response.ok || result.value.issue) throw new Error('Draft write unconfirmed')
        confirmed = result.value.draft
      } catch {
        // A dispatched local write is not replayed. Read back its operation
        // identity once; otherwise retain the editor text and show unsaved.
        try {
          const current = await request()
          if (current.response.ok && !current.value.issue && current.value.draft?.operationId === operationId) confirmed = current.value.draft
        } catch { /* Current browser text remains untouched. */ }
      }
      if (!confirmed || confirmed.operationId !== operationId || confirmed.text !== snapshot.text
        || confirmed.hadReferences !== snapshot.hadReferences || confirmed.hadAttachments !== snapshot.hadAttachments) {
        publish('error'); return false
      }
      baseline = confirmed
    }
    publish('saved'); return true
  }
  function flush(): Promise<boolean> {
    clearTimeout(timer)
    if (state.status === 'conflict') return Promise.resolve(false)
    if (saving) return saving
    if (!ready) return load().then(ok => ok ? flush() : false)
    saving = commit().catch(() => { publish('error'); return false }).finally(() => {
      saving = undefined
      if (state.status === 'saved' && dirty()) publish('unsaved')
      else notify()
    })
    return saving
  }
  function preservedBy(saved: SavedDraft | undefined): boolean {
    const current = payload()
    return !!saved && saved.hostId === options.hostId && saved.sessionId === options.sessionId
      && saved.text === current.text && saved.hadReferences === current.hadReferences && saved.hadAttachments === current.hadAttachments
  }
  return {
    getSnapshot: () => state,
    getSaved: () => baseline,
    // Only the owning recovery UI requests text. Never include it in view
    // inspection, diagnostics, or a request to the remote Host.
    retainedInput: () => ({ ...payload() }),
    // Only lifecycle metadata crosses the view-inspection boundary. Text,
    // references and attachment identities remain with the draft owner.
    preservedBy,
    async confirmPersisted() {
      if (mounted) return false
      try {
        const current = await request()
        return current.response.ok && !current.value.issue && preservedBy(current.value.draft)
      } catch { return false }
    },
    inspection: () => ({
      status: state.status, persisted: ready && !loading && !saving && !dirty() && state.status === 'saved',
      revision: input.draftRev, inputPhase: input.phase,
      hasReferences: retiredInput?.hadReferences ?? (references || !!input.occurrences?.length),
      hasAttachments: retiredInput?.hadAttachments ?? (attachments || !!input.attachmentIds?.length),
    }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    load, flush,
    beforeLeave() {
      if (!ready && state.status === 'error' && !input.draft && !input.attachmentIds?.length && !input.occurrences?.length && !references && !attachments
        && input.draftRev === options.input.draftRev && !baseline?.text) return Promise.resolve(true)
      return flush()
    },
    update(next: DraftInput) {
      if (!mounted) return
      input = { ...next }
      if (ready && state.status !== 'conflict' && state.status !== 'error') { if (dirty()) schedule(); else if (!saving) publish('saved') }
    },
    keepCurrent() { if (!mounted) return Promise.resolve(false); ready = true; publish('unsaved'); return flush() },
    acknowledgeReferences() { references = attachments = false; if (ready) { publish('unsaved'); schedule() } },
    dispose() {
      retiredInput ??= { ...payload() }
      clearTimeout(timer); mounted = false; listeners.clear()
      // A known snapshot can finish saving after a view unmounts. A pending
      // read cannot restore text into a disposed Session or another Host.
      return ready && state.status !== 'error' && state.status !== 'conflict' ? flush() : Promise.resolve(false)
    },
  }
}
