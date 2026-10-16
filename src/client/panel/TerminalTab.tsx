/**
 * Terminal tab: an xterm.js PTY view over the host's WebSocket terminal route.
 * A host <select> plus connect/disconnect controls; the terminal container is
 * sized by FitAddon (default 80x24 before first fit). On remote exit the last
 * output stays visible and input is disabled. xterm's stylesheet is injected
 * once per page load (module-level guard).
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { Terminal, type IDisposable } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { SshApi, TerminalConnection } from '../api.ts'
import type { SshHostSummary, TerminalTarget, TerminalSessionInfo } from '../../protocol.ts'
import { TerminalOperationQueue } from '../../terminal-operation-queue.ts'
import { applyTerminalContinuity } from '../../terminal-continuity.ts'
import { XTERM_CSS } from './xterm.css.ts'
import { errorMessage, resolveTerminalFontFamily, tt, type TerminalFontSource } from './helpers.ts'
import css from './panel.module.css'

/** Terminal tab props. */
export interface TerminalTabProps {
  api: SshApi
  persistentSession?: { owner: string; id: string; attach: boolean }
  onSessionInfo?: (session: TerminalSessionInfo) => void
  onRestart?: () => void
  /** Refresh host choices when shown without interrupting the PTY. */
  visible?: boolean
  onPhaseChange?: (phase: TerminalPhase) => void
  reviewedTarget?: TerminalTarget
  configuredTarget?: TerminalTarget | null
  onTargetChange?: (target: TerminalTarget) => void
  focusRequest?: number
  /** Alias preselected by a "connect" action from the hosts tab. */
  presetAlias?: string
  /** Bind an embedded workspace terminal to its configured host. */
  lockedAlias?: string
  /** Start the shell in this remote directory; the server quotes it before use. */
  remoteCwd?: string
  /** Connect once when the embedded terminal mounts. Never reconnect after exit. */
  autoConnect?: boolean
  /** Monotonic id of the connect request (re-applies presetAlias). */
  requestId?: number
  /**
   * Live terminal-font setting source (issue #577). Absent in tests and
   * legacy mounts: the font then comes from the CSS custom-property chain.
   */
  terminalFont?: TerminalFontSource
}

/** The terminal session lifecycle state shown in the status banner. */
type TerminalStatus =
  | { kind: 'idle' }
  | { kind: 'detached'; detail: string }
  | { kind: 'connecting' }
  | { kind: 'connected'; alias: string }
  | { kind: 'exited'; alias: string; detail?: string }
  | { kind: 'error'; detail: string }

export type TerminalPhase = TerminalStatus['kind'] | 'authenticating'

/** In-flight 2FA challenge prompts. */
interface AuthPromptState {
  name: string
  instructions: string
  prompts: Array<{ prompt: string; echo: boolean }>
  target?: TerminalTarget
}

/** Injected-once guard for the xterm stylesheet (one tag per page load). */
let xtermCssInjected = false

function ensureXtermCss(): void {
  if (xtermCssInjected || typeof document === 'undefined') return
  xtermCssInjected = true
  if (document.querySelector('style[data-dsh-ssh-xterm]') !== null) return
  const style = document.createElement('style')
  style.dataset.dshSshXterm = ''
  style.textContent = XTERM_CSS
  document.head.appendChild(style)
}

// Keep an unreadable viewport from shrinking a live PTY to a few cells.
const MIN_TERMINAL_COLS = 24
const MIN_TERMINAL_ROWS = 8

/** No-op source stand-in so the hook order stays stable without the prop. */
const NO_FONT_SOURCE: TerminalFontSource = {
  get: () => undefined,
  subscribe: () => () => undefined,
}

/** The xterm terminal view. */
export function TerminalTab({ api, presetAlias, lockedAlias, remoteCwd, autoConnect = false, requestId, terminalFont, visible = true, onPhaseChange,
  reviewedTarget, configuredTarget, onTargetChange, focusRequest, persistentSession, onSessionInfo, onRestart }: TerminalTabProps) {
  const [hosts, setHosts] = useState<SshHostSummary[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [alias, setAlias] = useState(lockedAlias ?? presetAlias ?? '')
  const [status, setStatus] = useState<TerminalStatus>({ kind: 'idle' })
  const [boundTarget, setBoundTarget] = useState<TerminalTarget | undefined>(reviewedTarget)
  const [authPrompt, setAuthPrompt] = useState<AuthPromptState | undefined>(undefined)
  const [recovered, setRecovered] = useState<'live' | 'output' | 'receipt' | undefined>(undefined)
  const [hasOutput, setHasOutput] = useState(false)
  const [tooSmall, setTooSmall] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [authInputs, setAuthInputs] = useState<string[]>([])
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const renderRef = useRef<TerminalOperationQueue | null>(null)
  const stateProtocol = useRef(false)
  const restoring = useRef(false)
  const usableSize = useRef(false)
  const inputReady = useRef(false)
  const requestedSize = useRef<string | undefined>(undefined)
  const connRef = useRef<TerminalConnection | null>(null)
  const dataSubRef = useRef<IDisposable | null>(null)
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const authForm = useRef<HTMLFormElement>(null)
  const connectButton = useRef<HTMLButtonElement>(null)
  const focusAfterDisconnect = useRef(false)
  const authenticating = useRef(false)
  const authTitle = useId()
  const lastFocusRequest = useRef<number | undefined>(undefined)
  const latestTargetNotify = useRef(onTargetChange)
  latestTargetNotify.current = onTargetChange
  const fontSource = terminalFont ?? NO_FONT_SOURCE
  const fontOverride = useSyncExternalStore(fontSource.subscribe, fontSource.get)

  const refit = (): void => {
    const term = termRef.current, fit = fitRef.current, connection = connRef.current
    if (!visibleRef.current || !term || !fit) return
    const size = fit.proposeDimensions()
    const usable = Boolean(size && size.cols >= MIN_TERMINAL_COLS && size.rows >= MIN_TERMINAL_ROWS)
    usableSize.current = usable
    setTooSmall(!usable)
    term.options.disableStdin = !inputReady.current || restoring.current || !usable
    if (!usable || !size || restoring.current) return
    if (stateProtocol.current && connection) {
      if (term.cols === size.cols && term.rows === size.rows) return
      const key = `${size.cols}:${size.rows}`
      if (requestedSize.current !== key) { requestedSize.current = key; connection.resize(size.cols, size.rows) }
    } else {
      term.resize(size.cols, size.rows)
      connection?.resize(size.cols, size.rows)
    }
  }

  useEffect(() => { ensureXtermCss() }, [])
  const phase: TerminalPhase = authPrompt !== undefined ? 'authenticating' : status.kind
  useEffect(() => { onPhaseChange?.(phase) }, [phase, onPhaseChange])
  useEffect(() => {
    if ((status.kind !== 'exited' && status.kind !== 'error') || !focusAfterDisconnect.current) return
    focusAfterDisconnect.current = false
    if (visible && !connectButton.current?.disabled) connectButton.current?.focus()
  }, [status.kind, visible])
  useEffect(() => {
    if (visible && authPrompt !== undefined) authForm.current?.querySelector<HTMLInputElement>('input')?.focus()
  }, [visible, authPrompt])
  useEffect(() => {
    if (!visible || focusRequest === undefined || lastFocusRequest.current === focusRequest) return
    lastFocusRequest.current = focusRequest
    if (authPrompt !== undefined) authForm.current?.querySelector<HTMLInputElement>('input')?.focus()
    else if (status.kind === 'connected' && usableSize.current) termRef.current?.focus()
  }, [visible, focusRequest, status.kind, authPrompt])

  // Live re-apply a terminal-font change (issue #577): xterm re-measures
  // and repaints on the options write; a refit keeps cols/rows aligned with
  // the new metrics and the remote PTY learns the new size.
  useEffect(() => {
    const term = termRef.current
    if (term === null) return
    const next = resolveTerminalFontFamily(fontOverride)
    if (term.options.fontFamily === next) return
    term.options.fontFamily = next
    if (!visibleRef.current) return
    refit()
  }, [fontOverride])

  useEffect(() => {
    const term = termRef.current
    if (!visible || term === null) return
    refit()
  }, [visible])

  // Fetch the host list on tab activation.
  useEffect(() => {
    if (!visible || configuredTarget !== undefined) return
    let disposed = false
    void (async () => {
      try {
        const list = await api.listHosts()
        if (!disposed) { setHosts(list); setListError(null) }
      } catch (cause) {
        if (!disposed) setListError(errorMessage(cause))
      }
    })()
    return () => { disposed = true }
  }, [api, configuredTarget, visible])

  // A hosts-tab connect action preselects its alias here.
  useEffect(() => {
    if (lockedAlias !== undefined) setAlias(lockedAlias)
    else if (presetAlias !== undefined && connRef.current === null) setAlias(presetAlias)
  }, [lockedAlias, presetAlias, requestId])

  const detach = (): void => {
    const connection = connRef.current
    connRef.current = null
    inputReady.current = false
    if (connection !== null) {
      connection.onReady = undefined
      connection.onTarget = undefined
      connection.onOutput = undefined
      connection.onExit = undefined
      connection.onAuthPrompt = undefined
      connection.onSnapshot = undefined
      connection.onResized = undefined
      connection.onDetached = undefined
      connection.close()
    }
    dataSubRef.current?.dispose()
    dataSubRef.current = null
    if (termRef.current !== null) termRef.current.options.disableStdin = true
  }

  const teardown = (clearPrompts = true): void => {
    authenticating.current = false
    if (clearPrompts) { setAuthPrompt(undefined); setAuthInputs([]) }
    detach()
    // detach() released input. Dispose the renderer when replacing/closing
    // the session; an explicit disconnect keeps its final output visible.
    renderRef.current?.dispose(); renderRef.current = null
    termRef.current?.dispose()
    termRef.current = null
    fitRef.current = null
  }

  // Unmount cleanup (never touches state on an unmounting component).
  useEffect(() => () => { teardown(false) }, [])

  // Keep the terminal fitted to its container. A window resize is only one
  // trigger: the status banner appearing after connect, panel resizes, and
  // sidebar toggles all change the container without a window resize, so the
  // container itself is observed (otherwise the viewport keeps the pre-banner
  // height and the last line is clipped below the fold). ResizeObserver may
  // be absent (jsdom tests); the window listener then remains the only path.
  useEffect(() => {
    const sync = (): void => { refit() }
    window.addEventListener('resize', sync)
    const container = containerRef.current
    if (container === null || typeof ResizeObserver === 'undefined') {
      return () => { window.removeEventListener('resize', sync) }
    }
    const observer = new ResizeObserver(() => { sync() })
    observer.observe(container)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [])

  const currentTarget = configuredTarget === undefined ? hosts.find(host => host.alias === (lockedAlias ?? alias)) : configuredTarget
  const rememberTarget = (target: TerminalTarget): void => {
    const identity = { alias: target.alias, host: target.host, port: target.port, user: target.user, updatedAt: target.updatedAt }
    setBoundTarget(identity); latestTargetNotify.current?.(identity)
  }
  const connect = (initial = false): void => {
    if (!initial && persistentSession && status.kind !== 'detached') { onRestart?.(); return }
    const target = lockedAlias ?? alias
    const container = containerRef.current
    if (target === '' || container === null) return
    if (status.kind === 'connecting' || status.kind === 'connected') return
    teardown()
    setStatus({ kind: 'connecting' }); setRecovered(undefined); setTruncated(false); setHasOutput(false)
    const reviewed = initial ? reviewedTarget ?? currentTarget : currentTarget
    if (reviewed) rememberTarget(reviewed)
    try {
      const term = new Terminal({
        convertEol: false,
        cursorBlink: true,
        disableStdin: true,
        fontSize: 13,
        scrollback: 10000,
        fontFamily: resolveTerminalFontFamily(fontOverride),
        theme: { background: '#0b0e14', foreground: '#d8dee9', cursor: '#a3b8d0' },
      })
      const fit = new FitAddon()
      termRef.current = term
      fitRef.current = fit
      term.loadAddon(fit)
      term.open(container)
      const render = new TerminalOperationQueue(term); renderRef.current = render
      stateProtocol.current = false; restoring.current = false; requestedSize.current = undefined
      refit()
      const persistent = persistentSession ? { ...persistentSession, attach: initial ? persistentSession.attach : true } : undefined
      const connection = persistent
        ? api.openTerminal(target, term.cols, term.rows, remoteCwd, reviewed?.updatedAt, persistent)
        : reviewed?.updatedAt === undefined
          ? api.openTerminal(target, term.cols, term.rows, remoteCwd)
          : api.openTerminal(target, term.cols, term.rows, remoteCwd, reviewed.updatedAt)
      connRef.current = connection
      let settled = false
      dataSubRef.current = term.onData(data => {
        if (connRef.current === connection && inputReady.current && usableSize.current && !restoring.current) connection.send(data)
      })
      const restoreFailed = (): void => {
        if (settled || connRef.current !== connection) return
        settled = true; detach(); restoring.current = false
        authenticating.current = false; setAuthPrompt(undefined); setAuthInputs([])
        setRecovered(undefined)
        setStatus({ kind: 'detached', detail: tt('terminal.restoreFailed') })
      }
      connection.onSnapshot = (session, output, format, continuity) => {
        if (connRef.current !== connection) return
        rememberTarget(session.target); onSessionInfo?.(session)
        setRecovered(persistent?.attach ? session.phase === 'connected' ? 'live' : output ? 'output' : 'receipt' : undefined); setTruncated(session.truncated); setHasOutput(Boolean(output))
        stateProtocol.current = format === 'state-v1'; restoring.current = true
        term.options.disableStdin = true
        void render.resize(session.cols, session.rows)
        void render.write(output)
        void render.run(() => {
          if (termRef.current !== term || connRef.current !== connection) return
          if (continuity !== undefined) {
            try { applyTerminalContinuity(term, continuity) } catch { restoreFailed(); return }
          }
          restoring.current = false; requestedSize.current = undefined; refit()
        })
      }
      connection.onResized = (cols, rows) => {
        if (connRef.current !== connection) return
        void render.resize(cols, rows)
        void render.run(() => { refit() })
      }
      connection.onDetached = reason => {
        if (settled || connRef.current !== connection) return
        settled = true; detach()
        authenticating.current = false; setAuthPrompt(undefined); setAuthInputs([])
        setRecovered(undefined)
        setStatus({ kind: 'detached', detail: tt(reason === 'replaced' ? 'terminal.viewReplaced' : reason === 'restore failed' ? 'terminal.restoreFailed' : 'terminal.viewLost') })
      }
      connection.onTarget = identity => { if (connRef.current === connection) rememberTarget(identity) }
      connection.onAuthPrompt = (name, instructions, prompts, target) => {
        if (connRef.current !== connection) return
        authenticating.current = true
        setAuthPrompt({ name, instructions, prompts, target })
        setAuthInputs(prompts.map(() => ''))
      }
      connection.onReady = () => { void render.run(() => {
        if (connRef.current !== connection) return
        authenticating.current = false
        setAuthPrompt(undefined)
        setAuthInputs([])
        setStatus({ kind: 'connected', alias: target })
        inputReady.current = true
        refit()
        // Readiness must not steal focus from the new-terminal form or another control.
        if (visibleRef.current && usableSize.current && (document.activeElement === document.body || container.contains(document.activeElement) || authForm.current?.contains(document.activeElement))) term.focus()
      }) }
      connection.onOutput = data => { if (connRef.current === connection) { setHasOutput(true); void render.write(data) } }
      connection.onExit = (_code, error, detail) => { void render.run(() => {
        if (settled || connRef.current !== connection) return
        settled = true
        focusAfterDisconnect.current = visibleRef.current && (authenticating.current || Boolean(containerRef.current?.contains(document.activeElement)))
        authenticating.current = false
        setAuthPrompt(undefined)
        setAuthInputs([])
        dataSubRef.current?.dispose()
        dataSubRef.current = null
        inputReady.current = false
        term.options.disableStdin = true
        connRef.current = null
        // Keep the last output visible; input is now disabled.
        setStatus(error === undefined ? { kind: 'exited', alias: target, detail } : { kind: 'error', detail: error })
        refit()
      }) }
    } catch (cause) {
      teardown()
      setStatus({ kind: 'error', detail: errorMessage(cause) })
    }
  }

  useEffect(() => {
    if (!autoConnect || lockedAlias === undefined) return
    // Defer until the tab body has a measurable container. StrictMode can
    // cancel the first effect pass without creating a remote session.
    const timer = window.setTimeout(() => { connect(true) }, 0)
    return () => { window.clearTimeout(timer) }
  }, [autoConnect, lockedAlias])

  const disconnect = (): void => {
    focusAfterDisconnect.current = visibleRef.current
    authenticating.current = false
    if (persistentSession) connRef.current?.stop?.()
    detach()
    setAuthPrompt(undefined)
    setAuthInputs([])
    setStatus({ kind: 'exited', alias: lockedAlias ?? alias, detail: tt('terminal.disconnected') })
  }

  const submitAuth = (e?: React.FormEvent): void => {
    e?.preventDefault()
    if (connRef.current === null || authPrompt === undefined) return
    connRef.current.sendAuthResponse(authInputs)
    setAuthPrompt(undefined)
    setAuthInputs([])
  }

  const authKey = (event: KeyboardEvent<HTMLFormElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); disconnect(); return }
    if (event.key !== 'Tab') return
    const fields = authForm.current?.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')
    const first = fields?.[0], last = fields?.[fields.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }

  const active = status.kind === 'connecting' || status.kind === 'connected'

  return (
    <div className={css.termBody}>
      <div className={`${css.terminalHeader} ${boundTarget ? css.terminalBoundHeader : ''}`}>
        {boundTarget && <div className={css.terminalIdentity} aria-label={tt('terminal.identity')}>
          <code title={`${boundTarget.user}@${boundTarget.host}:${boundTarget.port}`}>{boundTarget.user}@{boundTarget.host}:{boundTarget.port}</code>
          {!persistentSession && <span className={css.badge} data-status={phase === 'connected' ? 'ok' : phase === 'error' ? 'fail' : 'notRun'}>{tt(`terminal.state.${phase}`)}</span>}
        </div>}
        {lockedAlias === undefined
          ? <select className={css.input} aria-label={tt('terminal.selectHost')} disabled={active} value={alias} onChange={event => { setAlias(event.target.value) }}>
            <option value="">{tt('terminal.selectHost')}</option>
            {hosts.map(host => <option key={host.alias} value={host.alias}>{host.alias} ({host.host})</option>)}
          </select>
          : persistentSession ? null : <span className={css.hint}>{lockedAlias}</span>}
        {(!persistentSession || !active) && <button ref={connectButton} type="button" className={css.primaryButton} disabled={alias === '' || active || (configuredTarget === null && status.kind !== 'detached') || (lockedAlias === undefined && !hosts.some(host => host.alias === alias))} onClick={() => connect()}>{tt(status.kind === 'detached' ? 'terminal.resume' : persistentSession && (status.kind === 'exited' || status.kind === 'error') ? 'terminal.new' : 'terminal.connect')}</button>}
        {(!persistentSession || active) && <button type="button" className={css.ghostButton} disabled={!active} onClick={disconnect}>{tt(status.kind === 'connecting' ? 'terminal.cancelConnection' : 'terminal.disconnect')}</button>}
      </div>
      {boundTarget && remoteCwd && <code className={css.terminalDirectory} title={remoteCwd}>{remoteCwd}</code>}
      {boundTarget && status.kind !== 'idle' && currentTarget !== undefined && (currentTarget === null || currentTarget.updatedAt !== boundTarget.updatedAt) &&
        <p className={css.terminalConfigHint} role="status">{tt(currentTarget === null ? 'terminal.hostRemoved' : 'terminal.configChanged')}</p>}
      {listError !== null && <div className={css.banner} data-kind="error">{tt('common.error', { error: listError })}</div>}
      {status.kind === 'connecting' && !boundTarget && <div className={css.banner} data-kind="info">{tt('terminal.connecting')}</div>}
      {status.kind === 'connected' && !boundTarget && <div className={css.banner} data-kind="ok">{tt('terminal.ready', { alias: status.alias })}</div>}
      {status.kind === 'exited' && (
        <div className={css.banner} data-kind="info">{tt('terminal.exited', { alias: status.alias })}{status.detail !== undefined ? ' (' + status.detail + ')' : ''}</div>
      )}
      {status.kind === 'detached' && <div className={css.banner} data-kind="info" role="status">{status.detail}</div>}
      {(recovered || truncated) && <p className={css.terminalConfigHint} role="status">{tt(truncated ? 'terminal.outputTruncated' : recovered === 'live' ? 'terminal.restored' : recovered === 'output' ? 'terminal.outputRestored' : 'terminal.receiptRestored')}</p>}
      {status.kind === 'error' && <div className={css.banner} data-kind="error">{tt('terminal.error', { error: status.detail })}</div>}
      <div className={css.termWrap}>
        <div ref={containerRef} className={css.termContainer} data-dsh-part="terminal" />
        {tooSmall && status.kind !== 'idle' && <div className={css.terminalSpaceNotice} role="status" aria-label={tt('terminal.tooSmall')} title={tt('terminal.tooSmall')}>
          <div><strong>{tt('terminal.expandPanel')}</strong><span className={css.terminalSpaceDetail}>{tt('terminal.tooSmall')}</span></div>
        </div>}
        {(status.kind === 'error' || status.kind === 'exited') && !hasOutput && <div className={css.termPlaceholder}>{tt('terminal.noOutput')}</div>}
        {status.kind === 'idle' && (
          <div className={css.termPlaceholder}>{lockedAlias === undefined && hosts.length === 0 ? tt('hosts.empty') : tt('terminal.placeholder')}</div>
        )}
        {authPrompt !== undefined && (
          <div className={css.modalBackdrop} style={{ position: 'absolute', zIndex: 10 }}>
            <form ref={authForm} role="dialog" aria-modal="true" aria-labelledby={authTitle} className={`${css.modal} ${css.terminalAuth}`} onSubmit={submitAuth} onKeyDown={authKey}>
              <div>
                <h3 id={authTitle} className={css.modalTitle}>{authPrompt.name || tt('terminal.auth.title')}</h3>
              </div>
              <p className={css.modalDescription}>{authPrompt.instructions || tt('terminal.auth.hint')}</p>
              {(authPrompt.target ?? boundTarget) && <code className={css.authTarget}>{(authPrompt.target ?? boundTarget)!.user}@{(authPrompt.target ?? boundTarget)!.host}:{(authPrompt.target ?? boundTarget)!.port}</code>}
              <p className={css.hint}>{tt('terminal.auth.sessionOnly')}</p>
              {authPrompt.prompts.map((p, idx) => (
                <label key={idx} className={css.field}>
                  <span className={css.fieldLabel}>{p.prompt.trim() || tt('terminal.auth.title')}</span>
                  <input
                    autoFocus={visible && idx === 0}
                    className={css.input}
                    type={p.echo ? 'text' : 'password'}
                    autoComplete="off"
                    placeholder={tt('terminal.auth.placeholder')}
                    value={authInputs[idx] ?? ''}
                    onChange={event => {
                      const next = [...authInputs]
                      next[idx] = event.target.value
                      setAuthInputs(next)
                    }}
                  />
                </label>
              ))}
              <div className={css.modalFooter}>
                <button type="button" className={css.ghostButton} onClick={disconnect}>{tt('terminal.auth.cancel')}</button>
                <button type="submit" className={css.primaryButton}>{tt('terminal.auth.submit')}</button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
