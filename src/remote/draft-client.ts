import type { SavedDraft } from './draft-store.ts'
import type { createDraftReplica, DraftInput } from './draft-replica.ts'

export interface DraftSeed { hostId: string; sessionId: string; draft?: SavedDraft; issue?: string; nativeBoot?: boolean; browserDraftExisted?: boolean }

/** Runs before the native editor boots. Only this Session's known persistence
 * key is seeded; an existing browser draft is never replaced implicitly. The
 * native text-draft representation accepts a string in every supported SDK. */
export function seedDraft(input: DraftSeed, initialBoot = false): void {
  const target = window as unknown as { __dshSshDraftSeeds?: Map<string, DraftSeed> }
  const seed = { ...input }
  if (seed.draft && (seed.draft.hostId !== seed.hostId || seed.draft.sessionId !== seed.sessionId)) throw new Error('Invalid saved draft ownership')
  target.__dshSshDraftSeeds ??= new Map()
  target.__dshSshDraftSeeds.delete(seed.sessionId)
  target.__dshSshDraftSeeds.set(seed.sessionId, seed)
  while(target.__dshSshDraftSeeds.size>4)target.__dshSshDraftSeeds.delete(target.__dshSshDraftSeeds.keys().next().value!)
  if (!seed.draft || seed.issue) return
  try {
    const key = 'dsh.conversation.' + seed.sessionId
    seed.browserDraftExisted = localStorage.getItem(key) !== null
    if (!seed.browserDraftExisted) {
      localStorage.setItem(key, JSON.stringify({ draft: seed.draft.text }))
      seed.nativeBoot = initialBoot
    }
  } catch {
    seed.issue = 'Could not restore the saved draft into this view. Saved text remains on this computer.'
  }
}

/** The gateway passes the tested state machine and seed function as arguments;
 * there are no runtime imports or unbound closures in the serialized Client. */
export function draftClient(hostId: string, makeReplica: typeof createDraftReplica, seed: typeof seedDraft): void {
  type Replica = ReturnType<typeof makeReplica>
  type Retained = ReturnType<Replica['retainedInput']>
  type InputFace = { state: { getSnapshot(): DraftInput; subscribe(listener: () => void): () => void }; setDraft(text: string): void }
  type Context = {
    slots: { inject(name: string, apply: () => () => void): () => void; register(options: object, component: unknown): () => void }
    sessions?: { scope(id: string): unknown }
    get?(name: string): { input?: { for(scope: unknown): InputFace } } | undefined
    root: { inject(deps: string[], apply: (ctx: Context) => void): { dispose(): unknown } }
    effect(fn: () => () => void, label: string): void
  }
  type Props = { sessionId: string }
  const target = window as unknown as {
    __ModuleLoader__?: { load(module: unknown): void }; __dshSshDraftOwner?: { dispose(): unknown }
    __dshSshDraftSeeds?: Map<string, DraftSeed>
    __dshSshDrafts?: { flush(): Promise<boolean>; prepare(sessionId: string, signal?: AbortSignal): Promise<void>; openRecovery(): boolean }
  }
  target.__ModuleLoader__?.load({ id: '@jay-local/dsh-ssh-drafts', factory: (require: (id: string) => unknown) => {
    const React = require('react') as typeof import('react')
    const e = React.createElement
    function install(ctx: Context) {
      const controllers = new Map<string, Replica>()
      const retiring = new Set<Promise<void>>()
      // Keep detached text/flags rather than an old editor's input face,
      // attachment handles, subscriptions or Context graph.
      const failedRetirements = new Map<Retained, string>()
      let recoveryRevision = 0, recoveryDialog: HTMLDialogElement | undefined
      const recoveryListeners = new Set<() => void>()
      const changed = () => { ++recoveryRevision; for (const listener of [...recoveryListeners]) listener() }
      const recoverySubscribe = (listener: () => void) => { recoveryListeners.add(listener); return () => { recoveryListeners.delete(listener) } }
      const recoverySnapshot = () => recoveryRevision
      const reconcileFailures = () => {
        let removed = false
        for (const [retained, sessionId] of failedRetirements) {
          const current = controllers.get(sessionId)
          const saved = current?.getSaved()
          if (current?.inspection().persisted && saved?.hostId === hostId && saved.sessionId === sessionId
            && saved.text === retained.text && saved.hadReferences === retained.hadReferences && saved.hadAttachments === retained.hadAttachments) { failedRetirements.delete(retained); removed = true }
        }
        if (removed) changed()
      }
      const retire = (sessionId: string, replica: Replica) => {
        const retained = Object.freeze(replica.retainedInput())
        const finish = async (ok: boolean) => {
          // A newer instance may have saved and unmounted before this older
          // request settles. A bounded read checks disk without requiring a
          // currently mounted controller, replaying a write or restoring text.
          if (!ok && !await replica.confirmPersisted()) { failedRetirements.set(retained, sessionId); changed() }
        }
        // StrictMode can release and immediately reacquire the same effect
        // without constructing a new memoized Replica. Retire only after
        // that synchronous ownership change has completed.
        const closing = Promise.resolve().then(async () => {
          if (controllers.get(sessionId) === replica) return
          let ok = false
          try { ok = await replica.dispose() } catch { /* Preserve the detached input below. */ }
          await finish(ok)
        })
        retiring.add(closing); void closing.finally(() => retiring.delete(closing))
      }
      const empty = { status: 'loading', hadReferences: false, hadAttachments: false } as const
      const emptySnapshot = () => empty, emptySubscribe = () => () => {}
      const dockStyle = {
        boxSizing: 'border-box', width: 'calc(100% - 2 * var(--dsh-composer-side-clearance, 16px))',
        maxWidth: 'var(--dsh-composer-card-max-width, 100%)', margin: '0 auto', minWidth: 0,
        fontSize: '12px', padding: '4px 14px', overflowWrap: 'anywhere', opacity: .85,
      } as const
      const english = () => document.documentElement.lang.toLowerCase().startsWith('en')
      const labels = () => english() ? {
        loading: 'Checking saved draft…', saved: 'Draft saved on this computer', unsaved: 'Draft changes not saved yet', saving: 'Saving draft…',
        error: 'Could not confirm the latest changes were saved on this computer. Keep this conversation open and retry.', retry: 'Retry saving',
        conflict: 'The saved draft differs from your current input. Copy anything you need from the saved draft below before replacing it.', kept: 'Replace saved draft with this input', previous: 'Saved draft — copy before replacing it',
        references: 'Text was restored. Re-select any file references and attachments before sending.', reviewed: 'References and attachments reviewed',
        unavailable: 'Local draft saving is unavailable in this remote client.',
        recovery: 'Review unsaved drafts', recoveryTitle: 'Unsaved text kept in this view',
        recoveryHelp: 'Saving could not be confirmed before these inputs closed. Copy anything you need. This text is kept in this view, so keep it open until you have saved a copy or deliberately discarded it.',
        recoverySession: 'Conversation', recoveryText: 'Retained unsaved text', recoveryEmpty: 'An empty draft: clearing the saved text was not confirmed. The saved draft may still contain the previous text.',
        recoveryResources: 'File references and attachments are not included. Re-select them if you use this text.',
        copy: 'Copy text', copied: 'Text copied. This does not confirm it is saved on disk.', copyFailed: 'Copy did not finish. Select the text below and copy it manually.',
        discard: 'Discard this retained input', discardConfirm: 'Discard this text kept in the view? Copy anything you need first. The current input and the draft on disk will stay unchanged.',
        discardEmptyConfirm: 'Forget this unconfirmed clear? The current input and the draft on disk will stay unchanged.',
        close: 'Close', cancel: 'Cancel', confirmDiscard: 'Confirm discard', previousRecovery: 'Previous draft', nextRecovery: 'Next draft', recoveryDone: 'No retained unsaved inputs remain.',
      } : {
        loading: '正在检查本机草稿…', saved: '草稿已保存到本机', unsaved: '草稿更改尚未保存', saving: '正在保存草稿…',
        error: '无法确认最新修改已保存到本机。请保留此会话并重试。', retry: '重试保存',
        conflict: '本机草稿与当前输入不同。替换前请先复制下方旧草稿中需要保留的内容。', kept: '用当前输入替换已保存草稿', previous: '已保存的草稿，替换前请先复制',
        references: '已恢复文字。发送前请重新选择文件引用和附件。', reviewed: '已处理引用和附件',
        unavailable: '此远端客户端暂不支持本机草稿保存。',
        recovery: '查看未保存的草稿', recoveryTitle: '此视图中保留的未保存文字',
        recoveryHelp: '这些输入关闭前未能确认保存。请先复制需要保留的内容。这些文字目前保留在此视图中；保存副本或明确丢弃前，请保留此视图。',
        recoverySession: '会话', recoveryText: '保留的未保存文字', recoveryEmpty: '这是一份空草稿：尚未确认清空已保存的文字，磁盘上的草稿可能仍有原文。',
        recoveryResources: '不包含文件引用和附件；使用这段文字时请重新选择。',
        copy: '复制文字', copied: '文字已复制，这不代表已经保存到磁盘。', copyFailed: '未能完成复制，请选中下方文字手动复制。',
        discard: '丢弃这份保留的输入', discardConfirm: '丢弃此视图中保留的这份文字？请先复制需要的内容。当前输入和磁盘草稿都保持不变。',
        discardEmptyConfirm: '放弃这次未确认的清空？当前输入和磁盘草稿都保持不变。',
        close: '关闭', cancel: '取消', confirmDiscard: '确认丢弃', previousRecovery: '上一份草稿', nextRecovery: '下一份草稿', recoveryDone: '没有待处理的未保存输入。',
      }
      function openRecovery(): boolean {
        reconcileFailures()
        if (recoveryDialog?.isConnected && recoveryDialog.open) { recoveryDialog.focus(); return true }
        if (!failedRetirements.size) return false
        const owner = document.createElement('dialog'); recoveryDialog = owner
        Object.assign(owner.style, { width: 'min(800px, 90vw)', boxSizing: 'border-box', maxHeight: '85vh', overflow: 'auto', padding: '24px', borderRadius: '12px', font: 'inherit', lineHeight: '1.5',
          border: '1px solid var(--dsw-alias-border-l2, #444)', background: 'var(--dsw-alias-bg-base, #171717)', color: 'var(--dsw-alias-label-primary, #eee)' })
        const prior = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
        const heading = document.createElement('h2'), help = document.createElement('p'), content = document.createElement('div')
        const styleButton = (node: HTMLButtonElement) => Object.assign(node.style, { padding: '6px 10px', minHeight: '32px', font: 'inherit', cursor: 'pointer', borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-l2, #444)', background: 'transparent', color: 'inherit' })
        const close = document.createElement('button'); close.type = 'button'; close.textContent = labels().close; close.onclick = () => owner.close(); styleButton(close)
        heading.textContent = labels().recoveryTitle; help.textContent = labels().recoveryHelp
        const headingId = 'dsh-draft-recovery-' + crypto.randomUUID(); heading.id = headingId; owner.setAttribute('aria-labelledby', headingId)
        owner.append(heading, help, close, content); document.body.append(owner)
        let selected: Retained | undefined, confirmingDiscard: Retained | undefined
        const alive = (retained: Retained) => recoveryDialog === owner && owner.isConnected && selected === retained && failedRetirements.has(retained)
        const render = (focusAction?: 'cancel' | 'discard') => {
          if (recoveryDialog !== owner || !owner.isConnected) return
          if (!selected || !failedRetirements.has(selected)) selected = failedRetirements.keys().next().value
          content.replaceChildren()
          const t = labels(), retained = selected
          if (!retained) { const empty = document.createElement('p'); empty.textContent = t.recoveryDone; content.append(empty); return }
          const snapshot = retained, sessionId = failedRetirements.get(retained)!
          const title = document.createElement('h3'); title.textContent = `${t.recoverySession} · ${sessionId}`
          const text = document.createElement('textarea'); text.readOnly = true; text.value = snapshot.text; text.rows = 6; text.setAttribute('aria-label', t.recoveryText)
          Object.assign(text.style, { width: '100%', boxSizing: 'border-box', maxHeight: '30vh', resize: 'vertical', color: 'inherit', background: 'inherit', padding: '10px', font: 'inherit',
            border: '1px solid var(--dsw-alias-border-l2, #444)', borderRadius: '6px' })
          const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite')
          content.append(title, text, status)
          if (!snapshot.text) { const empty = document.createElement('p'); empty.textContent = t.recoveryEmpty; content.append(empty) }
          if (snapshot.hadReferences || snapshot.hadAttachments) { const warning = document.createElement('p'); warning.textContent = t.recoveryResources; content.append(warning) }
          const actions = document.createElement('div'); Object.assign(actions.style, { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '12px',
            position: 'sticky', bottom: '0', padding: '8px 0', background: 'var(--dsw-alias-bg-base, #171717)' })
          const button = (label: string, click: () => void) => { const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.onclick = click; styleButton(node); actions.append(node); return node }
          let copyBusy = false
          const copy = button(t.copy, () => {
            if (copyBusy || copy.disabled) return
            copyBusy = true
            let copying: Promise<void>
            try { copying = navigator.clipboard.writeText(snapshot.text) }
            catch { copying = Promise.reject(new Error('Text copy unavailable')) }
            // A disabled button loses focus. Keep the keyboard anchor while
            // the in-flight guard prevents duplicate copy requests.
            copy.setAttribute('aria-disabled', 'true')
            void copying.then(() => {
              if (alive(retained)) status.textContent = t.copied
            }).catch(() => { if (alive(retained)) { status.textContent = t.copyFailed; text.focus(); text.select() } })
              .finally(() => { copyBusy = false; if (alive(retained)) { copy.disabled = !snapshot.text; copy.removeAttribute('aria-disabled') } })
          }); copy.disabled = !snapshot.text
          // Desktop browser guests deliberately disable window.confirm().
          // Ask inside the existing dialog without widening guest privileges.
          let actionFocus: HTMLButtonElement | undefined
          if (confirmingDiscard === retained) {
            const warning = document.createElement('p'); warning.textContent = snapshot.text ? t.discardConfirm : t.discardEmptyConfirm
            warning.setAttribute('role', 'alert'); warning.style.flexBasis = '100%'; actions.append(warning)
            const cancel = button(t.cancel, () => { confirmingDiscard = undefined; render('discard') })
            if (focusAction === 'cancel') actionFocus = cancel
            button(t.confirmDiscard, () => {
              if (!alive(retained) || confirmingDiscard !== retained) return
              confirmingDiscard = undefined; failedRetirements.delete(retained); changed(); close.focus()
            })
          } else {
            const discard = button(t.discard, () => {
              if (!alive(retained)) return
              confirmingDiscard = retained; render('cancel')
            })
            if (focusAction === 'discard') actionFocus = discard
          }
          // Render one retained input at a time; never merge it into the
          // current editor or replace a newer draft in local storage.
          let previous: Retained | undefined, next: Retained | undefined, found = false
          for (const candidate of failedRetirements.keys()) {
            if (found) { next = candidate; break }
            if (candidate === retained) found = true
            else previous = candidate
          }
          if (previous) button(t.previousRecovery, () => { selected = previous; confirmingDiscard = undefined; render() })
          if (next) button(t.nextRecovery, () => { selected = next; confirmingDiscard = undefined; render() })
          content.append(actions); actionFocus?.focus()
        }
        recoveryListeners.add(render)
        owner.addEventListener('close', () => {
          recoveryListeners.delete(render); owner.remove()
          if (recoveryDialog === owner) { recoveryDialog = undefined; if (prior?.isConnected) prior.focus() }
        })
        render(); owner.showModal(); return true
      }
      function RecoveryLauncher() {
        React.useSyncExternalStore(recoverySubscribe, recoverySnapshot, recoverySnapshot)
        if (!failedRetirements.size) return null
        return e('div', { role: 'alert', 'data-dsh-draft-recovery': '', style: dockStyle }, e('button', { type: 'button', onClick: openRecovery,
          style: { font: 'inherit', padding: '4px 8px', cursor: 'pointer', borderRadius: '6px', color: 'inherit', background: 'transparent', border: '1px solid var(--dsw-alias-border-l2, #444)' },
        }, `${labels().recovery} (${failedRetirements.size})`))
      }
      function DraftView(props: Props & { face: InputFace }) {
        const source = React.useMemo(() => ({ getSnapshot: () => props.face.state.getSnapshot(), subscribe: (listener: () => void) => props.face.state.subscribe(listener) }), [props.face])
        const input = React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
        const replica = React.useMemo(() => {
          if (!input) return undefined
          let browserDraftExisted = true
          try { browserDraftExisted = localStorage.getItem('dsh.conversation.' + props.sessionId) !== null } catch { /* Protect unknown browser input. */ }
          return makeReplica({ hostId, sessionId: props.sessionId, input, browserDraftExisted,
            // Consume only when load actually uses the seed, not during an
            // abandoned React render. Later mounts must read current disk data.
            get seed() {
              const value = target.__dshSshDraftSeeds?.get(props.sessionId)
              target.__dshSshDraftSeeds?.delete(props.sessionId); return value
            },
            restore: text => props.face.setDraft(text) })
        }, [props.sessionId, !!input, props.face])
        const state = React.useSyncExternalStore(replica?.subscribe ?? emptySubscribe, replica?.getSnapshot ?? emptySnapshot, replica?.getSnapshot ?? emptySnapshot)
        React.useLayoutEffect(() => {
          if (!replica) return
          const sync = () => replica.update(source.getSnapshot())
          sync(); const unsubscribe = source.subscribe(sync)
          return () => { sync(); unsubscribe() }
        }, [replica, source])
        React.useEffect(() => {
          if (!replica) return
          controllers.set(props.sessionId, replica); void replica.load()
          const unsubscribe = replica.subscribe(reconcileFailures)
          return () => { unsubscribe(); if (controllers.get(props.sessionId) === replica) controllers.delete(props.sessionId); retire(props.sessionId, replica) }
        }, [replica])
        if (!replica || !input || state.status === 'saved' && !input.draft && !state.hadReferences && !state.hadAttachments) return null
        const t = labels(), children: import('react').ReactNode[] = []
        if (state.status === 'conflict') {
          children.push(e('p', { key: 'conflict', role: 'alert' }, t.conflict),
            e('textarea', { key: 'saved', readOnly: true, value: state.savedText ?? '', 'aria-label': t.previous, rows: 3, style: { width: '100%', maxHeight: '12em' } }),
            e('button', { key: 'keep', type: 'button', onClick: () => { void replica.keepCurrent() } }, t.kept))
        } else {
          children.push(e('span', { key: 'state', role: state.status === 'error' ? 'alert' : 'status' }, t[state.status]))
          if (state.status === 'error') children.push(e('button', { key: 'retry', type: 'button', onClick: () => { void replica.flush() } }, t.retry))
        }
        if (state.hadReferences || state.hadAttachments) children.push(e('p', { key: 'references', role: 'status' }, t.references),
          e('button', { key: 'reviewed', type: 'button', onClick: () => replica.acknowledgeReferences() }, t.reviewed))
        // Share the native composer's responsive width and side clearance. This
        // Slot is outside its card, so it does not inherit the card's layout.
        return e('div', { 'data-dsh-local-draft': props.sessionId, 'data-state': state.status, style: dockStyle }, ...children)
      }
      function Entry(props: Props) {
        let content: import('react').ReactNode
        try {
          if (typeof props.sessionId !== 'string' || !props.sessionId) throw new Error('Missing draft Session')
          const scope = ctx.sessions?.scope(props.sessionId)
          const face = scope ? ctx.get?.('conversation')?.input?.for(scope) : undefined
          const value = face?.state?.getSnapshot?.()
          if (!face || typeof face.state.subscribe !== 'function' || typeof face.setDraft !== 'function'
            || !value || typeof value.draft !== 'string' || !Number.isSafeInteger(value.draftRev)) throw new Error('Missing draft input contract')
          content = e(DraftView, { ...props, face })
        } catch { content = e('p', { role: 'status' }, labels().unavailable) }
        return e(React.Fragment, null, content, e(RecoveryLauncher))
      }
      const api = {
        inspection() {
          const sessions = [...controllers].map(([sessionId, controller]) => ({ sessionId, ...controller.inspection() }))
          // A new empty or different draft does not prove an old failed save
          // was recovered. Clear only after the same text and reference flags
          // are confirmed durable under the same Host/Session identity.
          reconcileFailures()
          return { sessions, pendingUnmountSaves: retiring.size, failedUnmountSaves: failedRetirements.size }
        },
        async flush() {
          const owners = [...controllers]
          const results = await Promise.all(owners.map(([, controller]) => controller.beforeLeave()))
          await Promise.all([...retiring])
          reconcileFailures()
          return results.every(Boolean) && retiring.size === 0 && failedRetirements.size === 0
            && controllers.size === owners.length && owners.every(([id, controller]) => controllers.get(id) === controller)
        },
        openRecovery,
        async prepare(sessionId: string, signal?: AbortSignal) {
          signal?.throwIfAborted()
          // Ordinary navigation keeps this document and its recovery ledger.
          // Retired inputs block disposal, not access to another conversation.
          const owners = [...controllers]
          if (!(await Promise.all(owners.map(([, controller]) => controller.beforeLeave()))).every(Boolean)
            || controllers.size !== owners.length || !owners.every(([id, controller]) => controllers.get(id) === controller)) throw new Error('DSH_DRAFT_UNSAVED')
          signal?.throwIfAborted()
          if (controllers.has(sessionId)) return
          let value: DraftSeed = { hostId, sessionId }
          const request = new AbortController(), abort = () => request.abort(signal?.reason), deadline = setTimeout(() => request.abort(),5000)
          signal?.addEventListener('abort',abort,{once:true})
          try {
            const response = await fetch('/__dsh_remote/draft?sessionId=' + encodeURIComponent(sessionId), { cache: 'no-store', signal: request.signal })
            if (!response.ok) throw new Error('Draft read failed')
            value = { ...value, ...await response.json() }
            if (value.hostId !== hostId || value.sessionId !== sessionId) throw new Error('Invalid draft owner')
          } catch { signal?.throwIfAborted(); value = { hostId, sessionId, issue: 'Saved draft could not be loaded; current browser text was kept.' } }
          finally {clearTimeout(deadline);signal?.removeEventListener('abort',abort)}
          signal?.throwIfAborted()
          seed(value)
        },
      }
      target.__dshSshDrafts = api
      const release = ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'ssh-local-draft', priority: 200 }, Entry))
      ctx.effect(() => () => { release(); for (const controller of controllers.values()) void controller.dispose(); controllers.clear(); recoveryDialog?.remove(); recoveryListeners.clear(); if (target.__dshSshDrafts === api) delete target.__dshSshDrafts }, 'SSH view: local drafts')
    }
    return { inject: ['slots', 'sessions', 'conversation'], apply(ctx: Context) {
      if (target.__dshSshDraftOwner) return
      const owner = ctx.root.inject(['slots', 'sessions', 'conversation'], install); target.__dshSshDraftOwner = owner
      const hide = (event: PageTransitionEvent) => { if (!event.persisted) { void owner.dispose(); window.removeEventListener('pagehide', hide) } }
      window.addEventListener('pagehide', hide)
    } }
  } })
}
