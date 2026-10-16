/** File transfers with a sequential queue and independent remote browsing. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react'
import { prepareDownload, TransferCancelledError, type SshApi } from '../api.ts'
import type { RemoteDirEntry, SshHostSummary } from '../../protocol.ts'
import { errorMessage, formatTimestamp, tt } from './helpers.ts'
import { TransferQueue, transferFinished, type TransferJob } from '../transfer-queue.ts'
import { browserTransferHistory } from '../transfer-history.ts'
import css from './panel.module.css'
import { TransferDestinationCheck } from './TransferDestinationCheck.tsx'

/** Transfer tab props. */
export interface TransferTabProps {
  api: SshApi
  active?: boolean
}

/** Join a directory path with a child entry name. */
function joinRemotePath(dir: string, name: string): string {
  const base = dir.endsWith('/') ? dir : dir + '/'
  return base + name
}

/** Parent path of a remote directory ('/' stays '/'). */
function parentOf(dir: string): string {
  const trimmed = dir.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  if (index <= 0) return '/'
  return trimmed.slice(0, index)
}

/** Human byte sizes through the transfer.* locale templates. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return tt('transfer.bytes', { value: bytes })
  if (bytes < 1024 * 1024) return tt('transfer.kib', { value: (bytes / 1024).toFixed(1) })
  if (bytes < 1024 * 1024 * 1024) return tt('transfer.mib', { value: (bytes / (1024 * 1024)).toFixed(1) })
  return tt('transfer.gib', { value: (bytes / (1024 * 1024 * 1024)).toFixed(1) })
}

/** The upload/download tab. */
export function TransferTab({ api, active = true }: TransferTabProps) {
  const [hosts, setHosts] = useState<SshHostSummary[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [alias, setAlias] = useState('')
  const [remotePath, setRemotePath] = useState('')
  const [browseOpen, setBrowseOpen] = useState(false)
  const [browseDir, setBrowseDir] = useState('/')
  const [entries, setEntries] = useState<RemoteDirEntry[]>([])
  const [browsing, setBrowsing] = useState(false)
  const queue = useMemo(() => new TransferQueue(api, browserTransferHistory()), [api])
  const { jobs, paused, activeId, restored, historyIssue } = useSyncExternalStore(queue.subscribe, queue.snapshot)
  const [choosing, setChoosing] = useState(false), [notice, setNoticeValue] = useState<string | null>(null)
  const [noticeKind, setNoticeKind] = useState<'error' | 'info'>('error')
  const setNotice = (message: string | null, kind: 'error' | 'info' = 'error'): void => { setNoticeValue(message); setNoticeKind(kind) }
  const [composerOpen, setComposerOpen] = useState(() => jobs.length === 0)
  const [saveMode, setSaveMode] = useState<'picker' | 'browser'>('picker')
  const fileRef = useRef<HTMLInputElement | null>(null)
  const seqRef = useRef(0)
  const prepareSeq = useRef(0)
  const uploadTarget = useRef<{ host: SshHostSummary; path: string } | null>(null)
  const restoringFiles = useRef(false)
  const [resetConfirm, setResetConfirm] = useState(false)
  const resetTrigger = useRef<HTMLButtonElement | null>(null), resetFocus = useRef(false)
  const composerSummary = useRef<HTMLElement>(null), queueAction = useRef<HTMLButtonElement>(null)
  const cancelledFocus = useRef<{ button: HTMLButtonElement; id?: number } | null>(null)
  const restoredFocus = useRef(false), restoreControl = useRef<HTMLButtonElement | null>(null)
  const cancelledPreparation = useRef(false)
  useEffect(() => {
    if (choosing || !cancelledPreparation.current) return
    cancelledPreparation.current = false
    if (active && (document.activeElement === document.body || document.activeElement === restoreControl.current || !document.activeElement?.isConnected)) {
      (restoreControl.current?.isConnected && !restoreControl.current.disabled ? restoreControl.current : composerSummary.current)?.focus()
    }
  }, [choosing, active, notice])
  const cancelPreparation = (): void => {
    ++prepareSeq.current; cancelledPreparation.current = true; setChoosing(false); setNotice(tt('transfer.preparationCancelled'), 'info')
  }
  useEffect(() => {
    if (resetConfirm || !resetFocus.current) return
    resetFocus.current = false
    if (active) (resetTrigger.current?.isConnected ? resetTrigger.current : composerSummary.current)?.focus()
  }, [resetConfirm, active])
  const closeReset = (): void => { resetFocus.current = true; setResetConfirm(false) }
  useEffect(() => {
    if (!restoredFocus.current || choosing) return
    restoredFocus.current = false
    if (active && (document.activeElement === document.body || document.activeElement === fileRef.current || document.activeElement === restoreControl.current)) {
      (queueAction.current && !queueAction.current.disabled ? queueAction.current : composerSummary.current)?.focus()
    }
  }, [jobs, choosing, active])

  useEffect(() => { queue.attach(); return () => { ++seqRef.current; ++prepareSeq.current; queue.detach() } }, [queue])
  useEffect(() => {
    const request = cancelledFocus.current
    if (!request || (request.id === undefined ? jobs.some(job => job.phase === 'stopping')
      : jobs.some(job => job.id === request.id && !transferFinished(job)))) return
    cancelledFocus.current = null
    if (!active || composerSummary.current?.closest('[hidden]')) return
    if (document.activeElement === document.body || document.activeElement === request.button) {
      (queueAction.current ?? composerSummary.current)?.focus()
    }
  }, [jobs, active])
  const rememberCancelFocus = (button: HTMLButtonElement, id?: number): void => {
    if (document.activeElement === button) cancelledFocus.current = { button, id }
  }

  useEffect(() => {
    if (!active) return
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
  }, [api, active])

  const loadDir = async (path: string, choose = false): Promise<void> => {
    if (alias === '') return
    const seq = ++seqRef.current
    setBrowsing(true)
    try {
      const list = await api.ls(alias, path)
      if (seq !== seqRef.current) return
      const sorted = [...list].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      setEntries(sorted)
      setBrowseDir(path)
      if (choose) setRemotePath(path.endsWith('/') ? path : path + '/')
      setListError(null)
    } catch (cause) {
      if (seq === seqRef.current) setListError(errorMessage(cause))
    } finally {
      if (seq === seqRef.current) setBrowsing(false)
    }
  }

  const openBrowse = (): void => {
    if (alias === '') return
    setBrowseOpen(true)
    const target = remotePath.trim()
    const path = target === '' ? '/' : target.endsWith('/') ? target : parentOf(target)
    void loadDir(path)
  }

  const selectedHost = hosts.find(host => host.alias === alias)
  const ready = selectedHost !== undefined && remotePath.trim().startsWith('/') && !choosing && !browsing && !historyIssue
  const handleFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.target.files ?? []); event.target.value = ''
    if (restoringFiles.current) {
      restoringFiles.current = false
      if (!files.length) return
      try { queue.restoreUploads(files); restoredFocus.current = true; setNotice(null) } catch (cause) { setNotice(errorMessage(cause)) }
      return
    }
    const target = uploadTarget.current ?? (selectedHost ? { host: { ...selectedHost }, path: remotePath.trim() } : null)
    uploadTarget.current = null
    if (!target || !files.length) return
    try { queue.addUploads(target.host, target.path, files); setNotice(null); setComposerOpen(false) }
    catch (cause) { setNotice(errorMessage(cause)) }
  }
  const handleDownload = async (): Promise<void> => {
    if (!ready || !selectedHost) return
    const host = { ...selectedHost }, path = remotePath.trim(), mode = saveMode, seq = ++prepareSeq.current
    setChoosing(true); setNotice(null)
    try {
      const destination = await prepareDownload(path, mode)
      if (seq !== prepareSeq.current) return
      queue.addDownload(host, path, mode, destination); setComposerOpen(false)
    } catch (cause) {
      if (seq === prepareSeq.current) {
        const cancelled = cause instanceof TransferCancelledError
        if (cancelled) cancelledPreparation.current = true
        setNotice(cancelled ? tt('transfer.cancelled') : errorMessage(cause), cancelled ? 'info' : 'error')
      }
    } finally { if (seq === prepareSeq.current) setChoosing(false) }
  }
  const pending = jobs.filter(job => !transferFinished(job)), completed = jobs.filter(transferFinished)
  const missingFiles = pending.filter(job => job.phase === 'awaitingFile')
  const restoreDownload = async (job: TransferJob): Promise<void> => {
    const seq = ++prepareSeq.current; setChoosing(true); setNotice(null)
    try {
      const destination = await prepareDownload(job.path, job.saveMode ?? 'picker')
      if (seq === prepareSeq.current) { queue.restoreDownload(job.id, destination); restoredFocus.current = true }
    } catch (cause) {
      if (seq === prepareSeq.current) {
        const cancelled = cause instanceof TransferCancelledError
        if (cancelled) cancelledPreparation.current = true
        setNotice(cancelled ? tt('transfer.cancelled') : errorMessage(cause), cancelled ? 'info' : 'error')
      }
    }
    finally { if (seq === prepareSeq.current) setChoosing(false) }
  }
  const phaseText = (job: TransferJob): string => job.phase === 'queued' ? tt('transfer.queued')
    : job.phase === 'awaitingFile' ? tt('transfer.awaitingFile') : job.phase === 'awaitingSave' ? tt('transfer.awaitingSave')
    : job.phase === 'stopping' ? tt('transfer.stopping') : job.phase === 'staging' ? tt('transfer.staging')
    : job.phase === 'connecting' ? tt('transfer.connecting') : job.phase === 'saving' ? tt('transfer.savingLocal') : job.kind === 'upload' ? tt('transfer.writingRemote') : tt('transfer.downloading')
  const outcome = (job: TransferJob): string => job.phase === 'interrupted' ? tt('transfer.interruptedHint', { bytes: formatBytes(job.transferred) })
    : job.phase === 'cancelled' ? tt(!job.dispatched ? 'transfer.notStarted' : job.kind === 'upload' ? 'transfer.stoppedUpload' : 'transfer.stoppedDownload')
    : job.phase === 'error' ? tt('transfer.failed', { error: job.error ?? '' }) : tt(job.phase === 'browserSave' ? 'transfer.browserSave' : 'transfer.done', { bytes: job.transferred })

  return (
    <div className={css.fillBody}>
      <details className={css.transferComposer} open={composerOpen} onToggle={event => setComposerOpen(event.currentTarget.open)}>
      <summary ref={composerSummary}>{tt('transfer.configure')}</summary>
      <div className={css.controls}>
        <select className={css.input} aria-label={tt('transfer.selectHost')} disabled={choosing} value={alias} onChange={event => {
          ++seqRef.current
          setAlias(event.target.value); setEntries([]); setBrowseOpen(false); setBrowsing(false); setNotice(null)
        }}>
          <option value="">{tt('transfer.selectHost')}</option>
          {hosts.map(host => <option key={host.alias} value={host.alias}>{host.alias} ({host.host})</option>)}
        </select>
        <input className={css.input} aria-label={tt('transfer.remotePath')} disabled={choosing} placeholder={tt('transfer.remotePathHint')} value={remotePath} onChange={event => { setRemotePath(event.target.value) }} />
        <button type="button" className={css.ghostButton} disabled={alias === '' || choosing || !hosts.some(host => host.alias === alias)} onClick={openBrowse}>{tt('transfer.browseRemote')}</button>
        <div className={css.toolbarSpacer} />
        <button type="button" className={css.primaryButton} disabled={!ready} onClick={() => { restoringFiles.current = false; if (selectedHost) uploadTarget.current = { host: { ...selectedHost }, path: remotePath.trim() }; fileRef.current?.click() }}>{tt('transfer.upload')}</button>
        <button type="button" className={css.ghostButton} disabled={!ready} onClick={event => { restoreControl.current = event.currentTarget; void handleDownload() }}>{tt('transfer.download')}</button>
        <input ref={fileRef} type="file" multiple className={css.hiddenFile} onChange={event => { void handleFile(event) }} />
      </div>
      <div className={css.transferOptions}>
        <label>{tt('transfer.saveMode')} <select className={css.input} disabled={choosing} value={saveMode}
          onChange={event => setSaveMode(event.target.value as 'picker' | 'browser')}>
          <option value="picker">{tt('transfer.savePicker')}</option>
          <option value="browser">{tt('transfer.saveBrowser')}</option>
        </select></label>
        <span className={css.hint}>{tt(saveMode === 'picker' ? 'transfer.savePickerHint' : 'transfer.saveBrowserHint')}</span>
      </div>
      {listError !== null && <div className={css.banner} data-kind="error">{tt('common.error', { error: listError })}</div>}
      {browseOpen && (
        <div className={css.browsePanel}>
          <div className={css.browseHeader}>
            <span className={css.browsePath}>{browseDir}</span>
            <button type="button" className={css.linkButton} disabled={browsing || choosing} onClick={() => { void loadDir(browseDir) }}>{tt('transfer.refresh')}</button>
          </div>
          <div className={css.browseList}>
            {browseDir !== '/' && (
              <button type="button" className={css.dirRow} disabled={choosing} data-up onClick={() => { void loadDir(parentOf(browseDir), true) }}>
                <span className={css.dirName}>{tt('transfer.upLevel')}</span>
                <span className={css.dirType} />
                <span className={css.dirSize} />
              </button>
            )}
            {entries.map(entry => (
              <button key={entry.name} type="button" className={css.dirRow} disabled={choosing} data-type={entry.type} onClick={() => {
                if (entry.type === 'dir') {
                  void loadDir(joinRemotePath(browseDir, entry.name), true)
                } else {
                  setRemotePath(joinRemotePath(browseDir, entry.name))
                }
              }}>
                <span className={css.dirName}>{entry.name}</span>
                <span className={css.dirType}>{entry.type === 'dir' ? '[' + tt('transfer.dir') + ']' : entry.type === 'file' ? '[' + tt('transfer.file') + ']' : ''}</span>
                <span className={css.dirSize}>{formatBytes(entry.size)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      </details>
      {historyIssue && <div className={css.banner} data-kind="error" role="status">
        <span>{tt(historyIssue === 'read' ? 'transfer.historyReadFailed' : 'transfer.historyWriteFailed')}</span>
        <div className={css.toolbar}>
          <button type="button" className={css.ghostButton} onClick={queue.retryHistory}>{tt('transfer.retryRecovery')}</button>
          {historyIssue === 'read' && <button ref={resetTrigger} type="button" className={css.linkButton} onClick={() => setResetConfirm(true)}>{tt('transfer.resetRecovery')}</button>}
        </div>
      </div>}
      {resetConfirm && <div className={css.banner} data-kind="warn" role="alertdialog" aria-label={tt('transfer.resetRecovery')} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); closeReset() } }}>
        <p>{tt('transfer.resetWarning')}</p>
        <div className={css.toolbar}>
          <button type="button" autoFocus className={css.ghostButton} onClick={closeReset}>{tt('form.cancel')}</button>
          <button type="button" className={css.primaryButton} onClick={() => { queue.clearRecovery(); closeReset() }}>{tt('transfer.resetRecovery')}</button>
        </div>
      </div>}
      {choosing && <div className={css.toolbar}>
        <span className={css.hint} role="status">{tt('transfer.choosingSave')}</span>
        <button type="button" className={css.ghostButton} onClick={cancelPreparation}>{tt('transfer.cancelPreparation')}</button>
      </div>}
      {notice !== null && <div className={css.banner} data-kind={noticeKind} role="status">{notice}</div>}
      {jobs.length > 0 && <>
        <div className={css.toolbar}>
          <strong className={css.queueSummary} role="status">{tt(!pending.length ? 'transfer.queueDone' : paused ? 'transfer.queuePaused' : 'transfer.queueRunning', { pending: pending.length, done: completed.length })}</strong>
          <div className={css.toolbarSpacer} />
          {pending.length > 0 && <button ref={queueAction} type="button" className={css.ghostButton} disabled={Boolean(historyIssue || choosing || paused && pending[0]?.phase !== 'queued')} onClick={paused ? queue.resume : queue.pause}>{tt(paused ? 'transfer.resumeQueue' : 'transfer.pauseQueue')}</button>}
          {pending.length > 0 && <button type="button" className={css.ghostButton} onClick={event => { rememberCancelFocus(event.currentTarget); queue.stopAll() }}>{tt('transfer.stopAll')}</button>}
          {completed.length > 0 && <button type="button" className={css.linkButton} onClick={queue.clearFinished}>{tt('transfer.clearFinished')}</button>}
        </div>
        <p className={css.queueHint}>{tt(!pending.length ? 'transfer.historyHint' : restored && pending.some(job => job.phase === 'awaitingFile' || job.phase === 'awaitingSave') ? 'transfer.restoredHint' : paused ? activeId ? 'transfer.pauseAfterCurrent' : 'transfer.pausedHint' : 'transfer.queueHint')}</p>
        {missingFiles.length > 0 && <button type="button" className={css.ghostButton} disabled={choosing || Boolean(historyIssue)} onClick={event => { restoreControl.current = event.currentTarget; restoringFiles.current = true; fileRef.current?.click() }}>{tt('transfer.reselectFiles', { count: missingFiles.length })}</button>}
        <div className={css.hostScroll} aria-label={tt('transfer.queue')}><div className={css.hostList}>
          {[...completed.filter(job => job.phase === 'interrupted').reverse(), ...pending, ...completed.filter(job => job.phase !== 'interrupted').reverse()].map(job => {
            const finished = transferFinished(job), determinate = job.phase === 'staging' || job.phase === 'transferring'
            return <article className={css.transferBlock} key={job.id} aria-label={tt('transfer.job', { id: job.id, file: job.file })} data-active={activeId === job.id ? '' : undefined} data-uncertain={job.phase === 'interrupted' ? '' : undefined}>
              <div className={css.transferHeader}>
                <div className={css.transferIdentity}><strong>#{job.id} · {job.file}</strong><span>{tt(job.kind === 'upload' ? 'transfer.upload' : 'transfer.download')} · {job.alias}</span></div>
                {finished && <span className={css.badge} data-status={job.phase === 'interrupted' ? 'unknown' : job.phase === 'error' ? 'fail' : job.phase === 'cancelled' ? job.dispatched ? 'stopped' : 'notRun' : 'ok'}>{tt(job.phase === 'interrupted' ? 'transfer.interruptedLabel' : job.phase === 'cancelled' ? 'transfer.cancelledLabel' : job.phase === 'error' ? 'transfer.failedLabel' : job.phase === 'browserSave' ? 'transfer.browserLabel' : 'transfer.doneLabel')}</span>}
                {!finished && <button type="button" className={css.ghostButton} disabled={job.phase === 'stopping'} aria-label={tt(['queued', 'awaitingFile', 'awaitingSave'].includes(job.phase) ? 'transfer.cancelJob' : 'transfer.stopJob', { id: job.id, file: job.file })} onClick={event => { rememberCancelFocus(event.currentTarget, job.id); queue.cancel(job.id) }}>{tt(['queued', 'awaitingFile', 'awaitingSave'].includes(job.phase) ? 'form.cancel' : 'transfer.stop')}</button>}
              </div>
              <code className={css.transferResultPath}>{job.user}@{job.host}:{job.port} · {job.path}</code>
              {job.localName && <p className={`${css.queueOutcome} ${css.transferResultPath}`}>{tt(job.phase === 'awaitingSave' ? 'transfer.previousLocalFilename' : 'transfer.localFilename', { file: job.localName })}</p>}
              {finished ? <>
                <p className={job.phase === 'error' ? css.resultError : css.queueOutcome} role="status">{outcome(job)}</p>
                {job.kind === 'download' && job.saveMode === 'picker' && ['cancelled', 'error', 'interrupted'].includes(job.phase) && <p className={css.queueOutcome}>{tt('transfer.checkLocalSave')}</p>}
                {job.kind === 'upload' && (job.phase !== 'cancelled' || job.dispatched) && <TransferDestinationCheck api={api} job={job} active={active} />}
              </> : <>
                <div className={css.progressMeta}><span role="status">{phaseText(job)}</span>
                  <span>{formatBytes(job.transferred)}{job.total > 0 ? ' / ' + formatBytes(job.total) : ''}{determinate && job.total > 0 ? ' · ' + tt('transfer.percent', { value: Math.round(job.percent) }) : ''}</span>
                  {job.speedBps !== undefined && job.phase === 'transferring' && <span>{tt('transfer.speed', { value: formatBytes(job.speedBps) })}</span>}
                </div>
                {job.phase === 'awaitingFile' && <p className={css.queueOutcome}>{tt('transfer.sourceDetails', { bytes: formatBytes(job.sourceSize ?? 0), modified: formatTimestamp(job.sourceModified ?? 0) })}</p>}
                {job.phase === 'awaitingSave' && <>
                  {job.saveMode !== 'browser' && <p className={css.queueOutcome}>{tt('transfer.savePickerHint')}</p>}
                  <button type="button" className={css.ghostButton} disabled={choosing || Boolean(historyIssue)} onClick={event => { restoreControl.current = event.currentTarget; void restoreDownload(job) }}>{tt(job.saveMode === 'browser' ? 'transfer.prepareDownload' : 'transfer.chooseSaveAgain')}</button>
                </>}
                {!['queued', 'awaitingFile', 'awaitingSave'].includes(job.phase) && <div className={css.progressTrack} role="progressbar" aria-label={phaseText(job)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={determinate && job.total > 0 ? Math.round(job.percent) : undefined}>
                  <div className={css.progressBar} data-indeterminate={!determinate || job.total <= 0 ? '' : undefined} style={{ width: determinate && job.total > 0 ? Math.min(100, Math.max(0, job.percent)) + '%' : '30%' }} />
                </div>}
              </>}
            </article>
          })}
        </div></div>
      </>}
      {jobs.length === 0 && <div className={css.transferEmpty}><strong>{tt('transfer.emptyTitle')}</strong><span>{tt('transfer.emptyHint')}</span></div>}
    </div>
  )
}
