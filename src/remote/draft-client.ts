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
    __dshSshDrafts?: { flush(): Promise<boolean>; prepare(sessionId: string, signal?: AbortSignal): Promise<void> }
  }
  target.__ModuleLoader__?.load({ id: '@jay-local/dsh-ssh-drafts', factory: (require: (id: string) => unknown) => {
    const React = require('react') as typeof import('react')
    const e = React.createElement
    function install(ctx: Context) {
      const controllers = new Map<string, Replica>()
      const empty = { status: 'loading', hadReferences: false, hadAttachments: false } as const
      const emptySnapshot = () => empty, emptySubscribe = () => () => {}
      const english = () => document.documentElement.lang.toLowerCase().startsWith('en')
      const labels = () => english() ? {
        loading: 'Checking saved draft…', saved: 'Draft saved on this computer', unsaved: 'Draft changes not saved yet', saving: 'Saving draft…',
        error: 'Could not confirm the latest changes were saved on this computer. Keep this conversation open and retry.', retry: 'Retry saving',
        conflict: 'The saved draft differs from your current input. Copy anything you need from the saved draft below before replacing it.', kept: 'Replace saved draft with this input', previous: 'Saved draft — copy before replacing it',
        references: 'Text was restored. Re-select any file references and attachments before sending.', reviewed: 'References and attachments reviewed',
        unavailable: 'Local draft saving is unavailable in this remote client.',
      } : {
        loading: '正在检查本机草稿…', saved: '草稿已保存到本机', unsaved: '草稿更改尚未保存', saving: '正在保存草稿…',
        error: '无法确认最新修改已保存到本机。请保留此会话并重试。', retry: '重试保存',
        conflict: '本机草稿与当前输入不同。替换前请先复制下方旧草稿中需要保留的内容。', kept: '用当前输入替换已保存草稿', previous: '已保存的草稿，替换前请先复制',
        references: '已恢复文字。发送前请重新选择文件引用和附件。', reviewed: '已处理引用和附件',
        unavailable: '此远端客户端暂不支持本机草稿保存。',
      }
      function DraftView(props: Props & { face: InputFace }) {
        const source = React.useMemo(() => ({ getSnapshot: () => props.face.state.getSnapshot(), subscribe: (listener: () => void) => props.face.state.subscribe(listener) }), [props.face])
        const input = React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
        const replica = React.useMemo(() => input ? makeReplica({ hostId, sessionId: props.sessionId, input,
          seed: target.__dshSshDraftSeeds?.get(props.sessionId), restore: text => props.face.setDraft(text) }) : undefined,
        [props.sessionId, !!input, props.face])
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
          return () => { if (controllers.get(props.sessionId) === replica) controllers.delete(props.sessionId); void replica.dispose() }
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
        return e('div', { 'data-dsh-local-draft': props.sessionId, 'data-state': state.status, style: { fontSize: '12px', padding: '4px 0', opacity: .85 } }, ...children)
      }
      function Entry(props: Props) {
        try {
          if (typeof props.sessionId !== 'string' || !props.sessionId) throw new Error('Missing draft Session')
          const scope = ctx.sessions?.scope(props.sessionId)
          const face = scope ? ctx.get?.('conversation')?.input?.for(scope) : undefined
          const value = face?.state?.getSnapshot?.()
          if (!face || typeof face.state.subscribe !== 'function' || typeof face.setDraft !== 'function'
            || !value || typeof value.draft !== 'string' || !Number.isSafeInteger(value.draftRev)) throw new Error('Missing draft input contract')
          return e(DraftView, { ...props, face })
        } catch { return e('p', { role: 'status' }, labels().unavailable) }
      }
      const api = {
        async flush() { return (await Promise.all([...controllers.values()].map(controller => controller.beforeLeave()))).every(Boolean) },
        async prepare(sessionId: string, signal?: AbortSignal) {
          signal?.throwIfAborted()
          if (!await api.flush()) throw new Error('DSH_DRAFT_UNSAVED')
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
      ctx.effect(() => () => { release(); for (const controller of controllers.values()) void controller.dispose(); controllers.clear(); if (target.__dshSshDrafts === api) delete target.__dshSshDrafts }, 'SSH view: local drafts')
    }
    return { inject: ['slots', 'sessions', 'conversation'], apply(ctx: Context) {
      if (target.__dshSshDraftOwner) return
      const owner = ctx.root.inject(['slots', 'sessions', 'conversation'], install); target.__dshSshDraftOwner = owner
      const hide = (event: PageTransitionEvent) => { if (!event.persisted) { void owner.dispose(); window.removeEventListener('pagehide', hide) } }
      window.addEventListener('pagehide', hide)
    } }
  } })
}
