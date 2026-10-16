/** Independent SSH shells with explicit creation, selection and disposal. */
import { useCallback, useEffect, useId, useReducer, useRef, useState, type KeyboardEvent } from 'react'
import { TerminalCatalogUnsupportedError, type SshApi } from '../api.ts'
import type { SshHostSummary, TerminalTarget, TerminalSessionInfo } from '../../protocol.ts'
import { errorMessage, tt, type TerminalFontSource } from './helpers.ts'
import { TerminalTab, type TerminalPhase } from './TerminalTab.tsx'
import css from './panel.module.css'
import { terminalOwner, activeTerminal, rememberActiveTerminal } from '../terminal-owner.ts'

interface Session { remoteId: string; attach: boolean; number?: number; id: number; alias: string; target: TerminalTarget; phase: TerminalPhase; focusRequest?: number }
interface SessionsState { items: Session[]; activeId: number | null; nextId: number; nextFocus: number }
type Action = { type: 'open'; target: TerminalTarget; reuse: boolean; remoteId: string }
  | { type: 'restore'; sessions: TerminalSessionInfo[]; active?: string }
  | { type: 'info'; id: number; session: TerminalSessionInfo }
  | { type: 'select' | 'close'; id: number }
  | { type: 'phase'; id: number; phase: TerminalPhase }
  | { type: 'target'; id: number; target: TerminalTarget }

function identity(host: SshHostSummary): TerminalTarget {
  return { alias: host.alias, user: host.user, host: host.host, port: host.port, updatedAt: host.updatedAt }
}

function live(phase: TerminalPhase): boolean {
  return phase === 'connecting' || phase === 'connected' || phase === 'authenticating' || phase === 'detached'
}

function reduce(state: SessionsState, action: Action): SessionsState {
  if (action.type === 'restore') {
    const items = action.sessions.map((session, index) => ({ id: index + 1, remoteId: session.id, attach: true, number: session.number,
      alias: session.target.alias, target: session.target, phase: session.phase, focusRequest: undefined }))
    return { items, activeId: items.find(item => item.remoteId === action.active)?.id ?? items[0]?.id ?? null, nextId: items.length + 1, nextFocus: 1 }
  }
  if (action.type === 'open') {
    const existing = action.reuse && state.items.find(item => item.alias === action.target.alias && item.target.updatedAt === action.target.updatedAt && (live(item.phase) || item.phase === 'idle'))
    if (existing) return { ...state, activeId: existing.id, nextFocus: state.nextFocus + 1,
      items: state.items.map(item => item.id === existing.id ? { ...item, focusRequest: state.nextFocus } : item) }
    const session: Session = { remoteId: action.remoteId, attach: false, id: state.nextId, alias: action.target.alias, target: action.target, phase: 'idle', focusRequest: state.nextFocus }
    return { items: [...state.items, session], activeId: session.id, nextId: state.nextId + 1, nextFocus: state.nextFocus + 1 }
  }
  const index = state.items.findIndex(item => item.id === action.id)
  if (index < 0) return state
  if (action.type === 'select') return state.activeId === action.id ? state : { ...state, activeId: action.id }
  if (action.type === 'info') return { ...state, items: state.items.map(item => item.id === action.id ? { ...item, number: action.session.number } : item) }
  if (action.type === 'target') {
    const target = state.items[index]!.target
    if (target.updatedAt === action.target.updatedAt && target.host === action.target.host && target.port === action.target.port && target.user === action.target.user) return state
    return { ...state, items: state.items.map(item => item.id === action.id ? { ...item, target: action.target } : item) }
  }
  if (action.type === 'phase') {
    if (state.items[index]!.phase === action.phase) return state
    return { ...state, items: state.items.map(item => item.id === action.id ? { ...item, phase: action.phase } : item) }
  }
  const activeId = state.activeId !== action.id ? state.activeId
    : state.items[index + 1]?.id ?? state.items[index - 1]?.id ?? null
  return { ...state, activeId, items: state.items.filter(item => item.id !== action.id) }
}

export interface TerminalSessionsProps {
  api: SshApi
  visible?: boolean
  presetAlias?: string
  requestId?: number
  terminalFont?: TerminalFontSource
}

function SessionPane({ session, visible, api, terminalFont, onPhase, configuredTarget, onTarget, owner, onInfo, onRestart, persistent }: {
  persistent: boolean; owner: string; onInfo: (id: number, session: TerminalSessionInfo) => void; onRestart: (target: TerminalTarget) => void
  session: Session; visible: boolean; api: SshApi; terminalFont?: TerminalFontSource
  onPhase: (id: number, phase: TerminalPhase) => void
  configuredTarget: TerminalTarget | null; onTarget: (id: number, target: TerminalTarget) => void
}) {
  const notify = useCallback((phase: TerminalPhase) => onPhase(session.id, phase), [session.id, onPhase])
  const notifyTarget = useCallback((target: TerminalTarget) => onTarget(session.id, target), [session.id, onTarget])
  return <TerminalTab api={api} lockedAlias={session.alias} autoConnect visible={visible}
    reviewedTarget={session.target} configuredTarget={configuredTarget} focusRequest={session.focusRequest}
    persistentSession={persistent ? { owner, id: session.remoteId, attach: session.attach } : undefined}
    onSessionInfo={info => onInfo(session.id, info)} onRestart={() => { if (configuredTarget) onRestart(configuredTarget) }}
    terminalFont={terminalFont} onPhaseChange={notify} onTargetChange={notifyTarget} />
}

export function TerminalSessions({ api, visible = true, presetAlias, requestId, terminalFont }: TerminalSessionsProps) {
  const [state, dispatch] = useReducer(reduce, { items: [], activeId: null, nextId: 1, nextFocus: 1 })
  const [owner] = useState(terminalOwner)
  const [restored, setRestored] = useState(false)
  const [persistent, setPersistent] = useState(true)
  const [restoreAttempt, setRestoreAttempt] = useState(0)
  const [closing, setClosing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [hosts, setHosts] = useState<SshHostSummary[]>([])
  const [alias, setAlias] = useState(presetAlias ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pendingClose, setPendingClose] = useState<Session | null>(null)
  const handledRequest = useRef<number | undefined>(undefined)
  const tabs = useRef(new Map<number, HTMLButtonElement>())
  const tabStrip = useRef<HTMLDivElement>(null)
  const picker = useRef<HTMLSelectElement>(null)
  const newButton = useRef<HTMLButtonElement>(null)
  const closeFocus = useRef<{ closedId: number; next: number | null; source: Element | null } | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const prefix = useId()
  const notify = useCallback((id: number, phase: TerminalPhase) => dispatch({ type: 'phase', id, phase }), [])
  const notifyInfo = useCallback((id: number, session: TerminalSessionInfo) => dispatch({ type: 'info', id, session }), [])
  const open = (target: TerminalTarget, reuse = false): void => dispatch({ type: 'open', target, reuse, remoteId: crypto.randomUUID() })
  const notifyTarget = useCallback((id: number, target: TerminalTarget) => dispatch({ type: 'target', id, target }), [])

  useEffect(() => { if (creating) picker.current?.focus() }, [creating])
  useEffect(() => {
    const pending = closeFocus.current
    if (!pending || state.items.some(item => item.id === pending.closedId)) return
    closeFocus.current = null
    if (document.activeElement !== pending.source && document.activeElement !== document.body) return
    if (pending.next === null) picker.current?.focus()
    else tabs.current.get(pending.next)?.focus()
  }, [state.items])

  const cancelCreate = (): void => { setCreating(false); newButton.current?.focus() }
  const createTerminal = (): void => {
    const host = restored && hosts.find(row => row.alias === alias)
    if (!host) return
    open(identity(host)); setCreating(false)
  }

  useEffect(() => {
    let disposed = false
    void api.listTerminals(owner).then(sessions => {
      if (disposed) return
      dispatch({ type: 'restore', sessions, active: activeTerminal() }); setRestored(true)
    }, cause => {
      if (disposed) return
      if (cause instanceof TerminalCatalogUnsupportedError) { setPersistent(false); setRestored(true) }
      else setError(errorMessage(cause))
    })
    return () => { disposed = true }
  }, [api, owner, restoreAttempt])

  useEffect(() => {
    if (restored) rememberActiveTerminal(state.items.find(item => item.id === state.activeId)?.remoteId)
  }, [restored, state.activeId, state.items])

  useEffect(() => {
    const strip = tabStrip.current
    if (!visible || state.activeId === null || strip === null) return
    const reveal = (): void => {
      if (strip.clientWidth > 0) {
        tabs.current.get(state.activeId!)?.parentElement?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
      }
    }
    reveal()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', reveal)
      return () => window.removeEventListener('resize', reveal)
    }
    const observer = new ResizeObserver(reveal)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [visible, state.activeId])

  useEffect(() => {
    if (!visible) return
    let disposed = false
    void api.listHosts().then(list => {
      if (!disposed) { setHosts(list) }
    }, cause => { if (!disposed) setError(errorMessage(cause)) })
    return () => { disposed = true }
  }, [api, visible])

  useEffect(() => {
    if (!restored || !visible || presetAlias === undefined || requestId === undefined || handledRequest.current === requestId) return
    let disposed = false
    void api.listHosts().then(list => {
      if (disposed) return
      handledRequest.current = requestId
      setHosts(list); setAlias(presetAlias)
      const host = list.find(row => row.alias === presetAlias)
      if (!host) { setError(tt('terminal.hostMissing', { alias: presetAlias })); return }
      setError(null); open(identity(host), true)
    }, cause => { if (!disposed) setError(errorMessage(cause)) })
    return () => { disposed = true }
  }, [presetAlias, requestId, visible, api, restored])

  const close = async (session: Session): Promise<void> => {
    if (closing) return
    setClosing(true)
    const focused = document.activeElement
    const ownsFocus = Boolean(dialog.current?.contains(focused) || tabs.current.get(session.id)?.parentElement?.contains(focused) || document.getElementById(`${prefix}-pane-${session.id}`)?.contains(focused))
    let focusMoved = false
    const moveFocus = (event: FocusEvent): void => { if (event.target !== focused && event.target !== document.body) focusMoved = true }
    const movePointer = (): void => { focusMoved = true }
    document.addEventListener('focusin', moveFocus)
    document.addEventListener('pointerdown', movePointer)
    try { if (persistent) await api.removeTerminal(owner, session.remoteId) }
    catch (cause) { setError(errorMessage(cause)); setClosing(false); return }
    finally { document.removeEventListener('focusin', moveFocus); document.removeEventListener('pointerdown', movePointer) }
    setClosing(false)
    const index = state.items.findIndex(item => item.id === session.id)
    const next = state.activeId !== session.id ? state.activeId
      : state.items[index + 1]?.id ?? state.items[index - 1]?.id ?? null
    dispatch({ type: 'close', id: session.id })
    setPendingClose(null)
    if (ownsFocus && !focusMoved && (document.activeElement === focused || document.activeElement === document.body)) {
      closeFocus.current = { closedId: session.id, next, source: focused }
    }
  }

  const cancelClose = (): void => {
    setPendingClose(null)
    if (state.activeId !== null) tabs.current.get(state.activeId)?.focus()
  }

  const selectWithKey = (event: KeyboardEvent<HTMLButtonElement>, id: number): void => {
    const index = state.items.findIndex(item => item.id === id)
    let next: number
    if (event.key === 'ArrowRight') next = (index + 1) % state.items.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + state.items.length) % state.items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = state.items.length - 1
    else return
    event.preventDefault()
    const target = state.items[next]!
    dispatch({ type: 'select', id: target.id })
    tabs.current.get(target.id)?.focus()
  }

  const dialogKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelClose() }
    if (event.key !== 'Tab') return
    const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button')
    const first = buttons?.[0], last = buttons?.[buttons.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }

  return <div className={css.terminalSessions}>
    {state.items.length > 0 && <div className={css.terminalSessionBar}>
      <div ref={tabStrip} className={css.terminalTabs} role="tablist" aria-label={tt('terminal.sessions')}>
        {state.items.map(session => <div key={session.id} className={css.terminalTabItem}
          data-selected={session.id === state.activeId ? '' : undefined}>
          <button type="button" role="tab" id={`${prefix}-tab-${session.id}`} aria-controls={`${prefix}-pane-${session.id}`}
            aria-selected={session.id === state.activeId} tabIndex={session.id === state.activeId ? 0 : -1}
            ref={element => { if (element) tabs.current.set(session.id, element); else tabs.current.delete(session.id) }}
            className={css.terminalSessionTab} onClick={() => dispatch({ type: 'select', id: session.id })}
            onKeyDown={event => selectWithKey(event, session.id)}>
            <span className={css.terminalSessionName} title={session.alias}>{session.alias} <span className={css.terminalSessionNumber}>#{session.number ?? session.id}</span></span>
            <span className={css.terminalSessionState}><span className={css.terminalStateDot} data-state={session.phase} aria-hidden="true" />{tt(`terminal.state.${session.phase}`)}</span>
          </button>
          <button type="button" className={css.terminalClose} aria-label={tt('terminal.closeLabel', { alias: session.alias, id: session.number ?? session.id })}
            disabled={closing} tabIndex={session.id === state.activeId ? 0 : -1}
            onClick={() => { if (live(session.phase)) setPendingClose(session); else void close(session) }}><span aria-hidden="true">×</span></button>
        </div>)}
      </div>
      <button ref={newButton} type="button" className={css.ghostButton} disabled={!restored || hosts.length === 0} aria-expanded={creating} aria-controls={`${prefix}-create`}
        onClick={() => {
          if (creating) { cancelCreate(); return }
          const active = state.items.find(item => item.id === state.activeId)
          setAlias(active && hosts.some(host => host.alias === active.alias) ? active.alias : ''); setCreating(true)
        }}>{tt('terminal.new')}</button>
    </div>}
    {(state.items.length === 0 || creating) && <form id={`${prefix}-create`} className={css.terminalCreator} aria-label={tt('terminal.new')}
      onSubmit={event => { event.preventDefault(); createTerminal() }}
      onKeyDown={event => { if (creating && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelCreate() } }}>
      <div className={css.terminalCreateControls}>
      <select ref={picker} className={css.input} aria-label={tt('terminal.selectHost')} value={alias}
        onChange={event => setAlias(event.target.value)}>
        <option value="">{tt('terminal.selectHost')}</option>
        {hosts.map(host => <option key={host.alias} value={host.alias}>{host.alias} ({host.host})</option>)}
      </select>
      <button type="submit" className={css.primaryButton} disabled={!restored || !hosts.some(host => host.alias === alias)}>{tt(state.items.length === 0 ? 'terminal.new' : 'terminal.create')}</button>
      </div>
      <div className={css.terminalCreateFooter}>
        <span className={css.hint}>{tt(persistent ? 'terminal.sessionsHint' : 'terminal.legacyHint')}</span>
        {creating && <button type="button" className={css.ghostButton} aria-label={tt('terminal.cancelNew')} onClick={cancelCreate}>{tt('form.cancel')}</button>}
      </div>
    </form>}
    {!persistent && <p className={css.terminalConfigHint} role="status">{tt('terminal.requiresReload')}</p>}
    {!restored && error !== null && <button type="button" className={css.ghostButton} onClick={() => { setError(null); setRestoreAttempt(attempt => attempt + 1) }}>{tt('terminal.retryRestore')}</button>}
    {error !== null && <div className={css.banner} data-kind="error">{tt('common.error', { error })}</div>}
    {state.items.length === 0 ? <div className={css.terminalEmpty}>
      <span className={css.terminalEmptyIcon} aria-hidden="true">›_</span>
      <strong>{tt(restored ? 'terminal.emptyTitle' : 'terminal.restoring')}</strong>
      <span>{hosts.length === 0 ? tt('hosts.empty') : tt('terminal.emptyHint')}</span>
    </div> : <>
      {state.items.map(session => <section key={session.id} className={css.terminalPane} role="tabpanel"
        id={`${prefix}-pane-${session.id}`} aria-labelledby={`${prefix}-tab-${session.id}`} hidden={session.id !== state.activeId}>
        <SessionPane session={session} api={api} visible={visible && session.id === state.activeId} terminalFont={terminalFont} onPhase={notify}
          persistent={persistent} owner={owner} onInfo={notifyInfo} onRestart={open} configuredTarget={hosts.find(host => host.alias === session.alias) ?? null} onTarget={notifyTarget} />
      </section>)}
    </>}
    {pendingClose !== null && <div className={css.modalBackdrop}>
      <div ref={dialog} className={css.modal} role="alertdialog" aria-modal="true" aria-labelledby={`${prefix}-close-title`}
        aria-describedby={`${prefix}-close-description`} onKeyDown={dialogKey}>
        <h3 id={`${prefix}-close-title`} className={css.modalTitle}>{tt('terminal.closeTitle', { alias: pendingClose.alias })}</h3>
        <p id={`${prefix}-close-description`} className={css.modalDescription}>{tt('terminal.closeWarning')}</p>
        <div className={css.modalFooter}>
          <button type="button" autoFocus className={css.ghostButton} disabled={closing} onClick={cancelClose}>{tt('form.cancel')}</button>
          <button type="button" className={css.primaryButton} disabled={closing} onClick={() => { void close(pendingClose) }}>{tt('terminal.close')}</button>
        </div>
      </div>
    </div>}
  </div>
}
