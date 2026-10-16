/** Reviewed runs with live output, independent Stop and read-only tab receipts. */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { ClusterNotStartedError, type SshApi } from '../api.ts'
import type { ClusterRequest, ClusterStreamFrame, ClusterTarget, SshHostSummary } from '../../protocol.ts'
import { selectClusterTargets } from '../../cluster-targets.ts'
import { errorMessage, formatTimestamp, tt } from './helpers.ts'
import { browserClusterHistory, clusterFinalPhase as finalPhase, clusterRowFinal as final, decodeClusterHistory, encodeClusterHistory, recoverClusterRecord,
  type ClusterHistory, type ClusterRecord, type ClusterRow as Row, type ClusterRun as Run } from '../cluster-history.ts'
import css from './panel.module.css'
import { ClusterResults } from './ClusterResults.tsx'

export interface ClusterTabProps { api: SshApi; active?: boolean; history?: ClusterHistory }
interface Review { request: ClusterRequest; targets: ClusterTarget[] }
function splitList(text: string): string[] { return [...new Set(text.split(',').map(part => part.trim()).filter(Boolean))] }
function countText(key: 'cluster.targetCount' | 'cluster.runCount', count: number): string { return tt(count === 1 ? `${key}.one` : key, { count }) }
export function ClusterTab({ api, active = true, history }: ClusterTabProps) {
  const journal = useRef(history ?? browserClusterHistory()).current
  const [initial] = useState(() => {
    try { const raw = journal.read(); return { record: raw === null ? { runs: [], selected: null, sequence: 0 } as ClusterRecord : recoverClusterRecord(decodeClusterHistory(raw)), error: null as string | null } }
    catch (cause) { return { record: { runs: [], selected: null, sequence: 0 } as ClusterRecord, error: errorMessage(cause) } }
  })
  const [hosts, setHosts] = useState<SshHostSummary[]>([]), [hostError, setHostError] = useState<string | null>(null)
  const [command, setCommand] = useState(''), [aliases, setAliases] = useState(''), [environment, setEnvironment] = useState(''), [tags, setTags] = useState('')
  const [workers, setWorkers] = useState(4), [timeout, setTimeoutSeconds] = useState(60)
  const [runs, setRuns] = useState<Run[]>(initial.record.runs), [selected, setSelected] = useState<number | null>(initial.record.selected), [busy, setBusy] = useState(false)
  const [review, setReview] = useState<Review | null>(null), [formOpen, setFormOpen] = useState(!initial.record.runs.length)
  const [historyError, setHistoryError] = useState(initial.error), [clearOpen, setClearOpen] = useState(false)
  const readable = useRef(initial.error === null), savedError = useRef(initial.error), receipts = useRef(initial.record)
  const checkpointTimer = useRef<number | undefined>(undefined), clearButton = useRef<HTMLButtonElement>(null)
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const sequence = useRef(initial.record.sequence), alive = useRef(true), reviewButton = useRef<HTMLButtonElement>(null), dialog = useRef<HTMLDivElement>(null)
  const stopButton = useRef<HTMLButtonElement>(null), commandInput = useRef<HTMLTextAreaElement>(null), restoreFocus = useRef(false), focusOnStart = useRef(false)
  const operation = useRef<{ controller: AbortController; id: number; runId?: string; stopRequested: boolean; cancelSent: boolean } | null>(null)
  const prefix = useId()
  const persist = (record = receipts.current, retry = false): boolean => {
    if (!readable.current || savedError.current && !retry) return false
    window.clearTimeout(checkpointTimer.current); checkpointTimer.current = undefined
    try { journal.write(encodeClusterHistory(record)); savedError.current = null; if (alive.current) setHistoryError(null); return true }
    catch (cause) { savedError.current = errorMessage(cause); if (alive.current) setHistoryError(savedError.current); return false }
  }
  const checkpoint = (force: boolean): void => {
    if (force) { persist(); return }
    if (checkpointTimer.current === undefined && !savedError.current) checkpointTimer.current = window.setTimeout(() => {
      checkpointTimer.current = undefined; persist()
    }, 1000)
  }
  useEffect(() => {
    alive.current = true
    const flush = (): void => { if (receipts.current.runs.length) persist() }
    window.addEventListener('pagehide', flush)
    return () => {
    alive.current = false
    window.removeEventListener('pagehide', flush)
    if (receipts.current.runs.length) persist()
    window.clearTimeout(checkpointTimer.current); checkpointTimer.current = undefined
    operation.current?.controller.abort(); operation.current = null
    }
  }, [])
  useEffect(() => {
    if (busy && focusOnStart.current) {
      focusOnStart.current = false
      if (active && !stopButton.current?.closest('[hidden]')) stopButton.current?.focus()
      return
    }
    if (busy || !restoreFocus.current) return
    restoreFocus.current = false
    const target = reviewButton.current?.disabled ? commandInput.current : reviewButton.current
    if (active && !target?.closest('[hidden]')) target?.focus()
  }, [busy, active, clearOpen, historyError])
  useEffect(() => {
    if (!active) return
    let disposed = false
    void api.listHosts().then(value => { if (!disposed) { setHosts(value); setHostError(null) } }, cause => {
      if (!disposed) setHostError(errorMessage(cause))
    })
    return () => { disposed = true }
  }, [api, active])
  const filters = { aliases: splitList(aliases), environment: environment.trim(), tags: splitList(tags) }
  const hasFilter = filters.aliases.length > 0 || filters.environment !== '' || filters.tags.length > 0
  const targets = hasFilter ? selectClusterTargets(hosts, filters) : []
  const missing = filters.aliases.filter(alias => !hosts.some(host => host.alias === alias))
  const validOptions = Number.isInteger(workers) && workers >= 1 && workers <= 8 && Number.isInteger(timeout) && timeout >= 1 && timeout <= 3600
  const ready = !busy && historyError === null && hostError === null && command.trim() !== '' && targets.length > 0 && !missing.length && validOptions
  const displayed = runs.find(run => run.id === selected)
  const update = (id: number, fn: (run: Run) => Run, force = true): void => {
    if (!alive.current) return
    const next = receipts.current.runs.map(run => run.id === id ? fn(run) : run)
    receipts.current = { ...receipts.current, runs: next }; setRuns(next); checkpoint(force)
  }
  const selectRun = (id: number): void => { receipts.current = { ...receipts.current, selected: id }; setSelected(id); setCopyStatus(null); checkpoint(true) }
  const closeClear = (): void => { setClearOpen(false); clearButton.current?.focus() }
  const clearHistory = (): void => {
    if (operation.current) return
    try {
      journal.clear(); readable.current = true; savedError.current = null
      receipts.current = { runs: [], selected: null, sequence: sequence.current }; setRuns([]); setSelected(null); setFormOpen(true)
      persist(receipts.current, true); setClearOpen(false); setCopyStatus(null); restoreFocus.current = true
    } catch (cause) { savedError.current = errorMessage(cause); setHistoryError(savedError.current); setClearOpen(false); clearButton.current?.focus() }
  }
  const closeReview = (): void => { setReview(null); reviewButton.current?.focus() }
  const dialogKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (clearOpen) closeClear(); else closeReview() }
    if (event.key !== 'Tab') return
    const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button'), first = buttons?.[0], last = buttons?.[buttons.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  const prepare = (): void => {
    if (!ready) return
    const identities = targets.map(({ alias, host, port, user, updatedAt }) => ({ alias, host, port, user, updatedAt }))
    setReview({ targets: identities, request: { command: command.trim(), aliases: filters.aliases.length ? filters.aliases : undefined,
      environment: filters.environment || undefined, tags: filters.tags.length ? filters.tags : undefined,
      maxWorkers: workers, timeoutMs: timeout * 1000, expectedTargets: identities.map(({ alias, updatedAt }) => ({ alias, updatedAt })) } })
  }
  const requestStop = (current: NonNullable<typeof operation.current>): void => {
    if (!current.runId || current.cancelSent || operation.current !== current) return
    current.cancelSent = true
    void api.cancelCluster(current.runId).catch(cause => {
      if (operation.current !== current) return
      current.cancelSent = false; current.stopRequested = false
      update(current.id, run => run.phase === 'stopping' ? ({ ...run, phase: 'running', error: tt('cluster.stopFailed', { error: errorMessage(cause) }) }) : run)
    })
  }
  const stop = (): void => {
    const current = operation.current
    if (!current || current.stopRequested) return
    current.stopRequested = true
    restoreFocus.current = document.activeElement === stopButton.current
    update(current.id, run => ({ ...run, phase: 'stopping' }))
    requestStop(current)
  }
  const start = async (): Promise<void> => {
    if (!review || operation.current || savedError.current) return
    const snapshot = review, id = sequence.current + 1
    const record: ClusterRecord = { sequence: id, selected: id, runs: [...receipts.current.runs.slice(-2), { id, request: snapshot.request, startedAt: Date.now(), phase: 'running',
      rows: snapshot.targets.map(target => ({ ...target, phase: 'queued', stdout: '', stderr: '' })) }] }
    if (!persist(record)) { setReview(null); reviewButton.current?.focus(); return }
    receipts.current = record; sequence.current = id; setRuns(record.runs)
    const current = { controller: new AbortController(), id, stopRequested: false, cancelSent: false, runId: undefined as string | undefined }
    operation.current = current
    focusOnStart.current = true
    setReview(null); setBusy(true); setFormOpen(false); setCopyStatus(null); setSelected(id)
    const event = (frame: ClusterStreamFrame): void => {
      if (operation.current !== current) return
      if (frame.type === 'plan') { current.runId = frame.runId; if (current.stopRequested) requestStop(current); return }
      if (frame.type === 'complete') { update(id, run => ({ ...run, phase: frame.cancelled ? 'cancelled' : 'complete', finishedAt: Date.now() })); return }
      if (frame.type === 'error') return
      const alias = frame.type === 'result' ? frame.result.alias : frame.alias
      update(id, run => ({ ...run, rows: run.rows.map(row => {
        if (row.alias !== alias || final(row)) return row
        if (frame.type === 'state') return { ...row, phase: frame.state }
        if (frame.type === 'output') return { ...row, [frame.stream]: row[frame.stream] + frame.data }
        return { ...row, phase: finalPhase(frame.result), result: frame.result }
      }) }), frame.type !== 'output')
    }
    try { await api.clusterStream(snapshot.request, event, current.controller.signal) }
    catch (cause) {
      if (operation.current === current) update(id, run => ({ ...run, phase: 'interrupted', finishedAt: Date.now(), error: errorMessage(cause),
        rows: run.rows.map(row => final(row) ? row : { ...row, phase: cause instanceof ClusterNotStartedError ? 'notRun' : 'unknown' }) }))
    } finally {
      if (operation.current === current) {
        restoreFocus.current = document.activeElement === stopButton.current
          || (restoreFocus.current && document.activeElement === document.body)
        operation.current = null; if (alive.current) setBusy(false)
      }
    }
  }
  const copy = async (row: Row): Promise<void> => {
    try {
      await navigator.clipboard.writeText(`${row.alias} (${row.user}@${row.host}:${row.port})\n${row.stdout}${row.stderr ? '\n[stderr]\n' + row.stderr : ''}${row.result?.error ? '\n' + row.result.error : ''}`)
      if (alive.current) setCopyStatus(tt('cluster.copied', { alias: row.alias }))
    } catch (cause) { if (alive.current) setCopyStatus(tt('common.error', { error: errorMessage(cause) })) }
  }
  const exportRun = (): void => {
    if (!displayed) return
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, command: displayed.request.command,
      startedAt: displayed.startedAt, finishedAt: displayed.finishedAt, phase: displayed.phase, error: displayed.error, recovered: displayed.recovered,
      results: displayed.rows.map(({ result, stdout, stderr, ...target }) => ({ ...target, ...result, stdout, stderr })) }, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `ssh-cluster-${displayed.startedAt}.json`
    document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 10000)
  }
  const finished = displayed?.rows.filter(row => row.result !== undefined).length ?? 0
  const issues = displayed?.rows.filter(row => final(row) && row.phase !== 'ok' && row.phase !== 'notRun').length ?? 0
  const cancelledBeforeDispatch = displayed?.phase === 'cancelled' && displayed.rows.every(row => row.phase === 'notRun')
  return <div className={css.fillBody}>
    {historyError && <div className={css.banner} data-kind="error" role="status">
      <p>{tt('cluster.historyUnavailable')}</p><p className={css.hint}>{historyError}</p>
      {readable.current && <button type="button" className={css.ghostButton} onClick={() => persist(receipts.current, true)}>{tt('cluster.retrySave')}</button>}
    </div>}
    <details className={css.clusterComposer} open={formOpen} onToggle={event => setFormOpen(event.currentTarget.open)}>
      <summary>{tt('cluster.configure')}</summary>
      <div className={css.clusterForm}>
        <label className={css.field}><span className={css.fieldLabel}>{tt('cluster.command')}</span>
          <textarea ref={commandInput} className={css.input + ' ' + css.commandInput} disabled={busy} value={command} onChange={event => setCommand(event.target.value)} /></label>
        <div className={css.clusterFilters}>
          <label className={css.field}><span className={css.fieldLabel}>{tt('cluster.targetHosts')}</span><input className={css.input} disabled={busy} placeholder={tt('cluster.aliasesHint')} value={aliases} onChange={event => setAliases(event.target.value)} /></label>
          <label className={css.field}><span className={css.fieldLabel}>{tt('cluster.environment')}</span><input className={css.input} disabled={busy} value={environment} onChange={event => setEnvironment(event.target.value)} /></label>
          <label className={css.field}><span className={css.fieldLabel}>{tt('cluster.tags')}</span><input className={css.input} disabled={busy} value={tags} onChange={event => setTags(event.target.value)} /></label>
        </div>
        <div className={css.clusterFilters}>
          <label className={css.field}><span className={css.fieldLabel}>{tt('cluster.workers')}</span><input className={css.input} disabled={busy} type="number" min={1} max={8} value={workers} onChange={event => setWorkers(Number(event.target.value))} /></label>
          <label className={css.field}><span className={css.fieldLabel}>{tt('cluster.budget')}</span><input className={css.input} disabled={busy} type="number" min={1} max={3600} value={timeout} onChange={event => setTimeoutSeconds(Number(event.target.value))} /></label>
        </div>
        <p className={css.hint}>{tt('cluster.scopeHint')}</p>
        {hostError !== null && <p className={css.resultError} role="status">{hostError}</p>}
        {missing.length > 0 && <p className={css.resultError} role="status">{tt('cluster.missing', { aliases: missing.join(', ') })}</p>}
        <div className={css.clusterTargets} aria-label={tt('cluster.reviewedTargets')}>
          <strong>{countText('cluster.targetCount', targets.length)}</strong>
          {targets.map(host => <span key={host.alias}><b>{host.alias}</b><code>{host.user}@{host.host}:{host.port}</code></span>)}
        </div>
      </div>
    </details>
    <div className={css.toolbar}>
      {busy ? <button ref={stopButton} type="button" className={css.ghostButton} autoFocus disabled={displayed?.phase !== 'running'} onClick={stop}>{displayed?.phase === 'stopping' ? tt('cluster.stopping') : tt('cluster.stop')}</button>
        : <button ref={reviewButton} type="button" className={css.primaryButton} disabled={!ready} onClick={prepare}>{tt('cluster.review')}</button>}
      {runs.length > 0 && <select className={css.input} aria-label={tt('cluster.history')} disabled={busy} value={selected ?? ''} onChange={event => selectRun(Number(event.target.value))}>
        {runs.map(run => <option key={run.id} value={run.id}>#{run.id} · {formatTimestamp(run.startedAt, true)} · {countText('cluster.targetCount', run.rows.length)} · {tt(`cluster.run.${run.phase}`)}</option>)}</select>}
      {displayed && <button type="button" className={css.ghostButton} onClick={exportRun}>{tt('cluster.export')}</button>}
      {(runs.length > 0 || historyError) && <button ref={clearButton} type="button" className={css.linkButton} disabled={busy} onClick={() => setClearOpen(true)}>{tt('cluster.clearHistory')}</button>}
    </div>
    {copyStatus && <p className={css.hint} role="status">{copyStatus}</p>}
    {!displayed && <div className={css.empty}>{tt('cluster.empty')}</div>}
    {displayed && <>
      <div className={css.clusterRunSummary}>
        <div><strong role="status">{tt(cancelledBeforeDispatch ? 'cluster.run.cancelledBeforeDispatch' : `cluster.run.${displayed.phase}`)}</strong><span>{tt('cluster.progress', { finished, total: displayed.rows.length, issues })}</span></div>
        <pre>{displayed.request.command}</pre>
        <details className={css.cellDetails}><summary>{tt('cluster.retention')}</summary><p className={css.hint}>{tt('cluster.historyHint')}</p></details>
      </div>
      {displayed.error && (displayed.recovered
        ? <details className={css.remoteErrorDetails}><summary>{tt('remote.errorDetails')}</summary><pre>{displayed.error}</pre></details>
        : <div className={css.banner} data-kind="error" role="status">{displayed.error}</div>)}
      {displayed.recovered && <p className={css.hint} role="status">{tt('cluster.recoveredHint')}</p>}
      {!displayed.recovered && displayed.rows.some(row => row.phase === 'stopped' || row.phase === 'unknown') && <p className={css.hint}>{tt('cluster.unknownHint')}</p>}
      <ClusterResults key={displayed.id} rows={displayed.rows} active={active} onCopy={row => { void copy(row) }} />
    </>}
    {clearOpen && <div className={css.modalBackdrop}><div ref={dialog} className={css.modal} role="alertdialog" aria-modal="true" aria-labelledby={`${prefix}-clear-title`} onKeyDown={dialogKey}>
      <h3 id={`${prefix}-clear-title`} className={css.modalTitle}>{tt('cluster.clearHistory')}</h3>
      <p className={css.modalDescription}>{tt('cluster.clearConfirm')}</p>
      <div className={css.modalFooter}><button type="button" className={css.ghostButton} autoFocus onClick={closeClear}>{tt('form.cancel')}</button><button type="button" className={css.primaryButton} onClick={clearHistory}>{tt('common.confirm')}</button></div>
    </div></div>}
    {review && <div className={css.modalBackdrop}><div ref={dialog} className={css.modal} role="alertdialog" aria-modal="true" aria-labelledby={`${prefix}-title`} aria-describedby={`${prefix}-description`} onKeyDown={dialogKey}>
      <h3 id={`${prefix}-title`} className={css.modalTitle}>{tt('cluster.reviewTitle')}</h3>
      <p id={`${prefix}-description`} className={css.modalDescription}>{tt('cluster.confirm')}</p>
      <pre className={css.resultOutput}>{review.request.command}</pre>
      <div className={css.clusterTargets}>{review.targets.map(target => <span key={target.alias}><b>{target.alias}</b><code>{target.user}@{target.host}:{target.port}</code></span>)}</div>
      <p className={css.hint}>{tt(review.request.maxWorkers === 1 ? 'cluster.reviewOptions.one' : 'cluster.reviewOptions', { workers: review.request.maxWorkers!, seconds: review.request.timeoutMs! / 1000 })}</p>
      <div className={css.modalFooter}><button type="button" className={css.ghostButton} autoFocus onClick={closeReview}>{tt('form.cancel')}</button><button type="button" className={css.primaryButton} onClick={() => { void start() }}>{countText('cluster.runCount', review.targets.length)}</button></div>
    </div></div>}
  </div>
}
