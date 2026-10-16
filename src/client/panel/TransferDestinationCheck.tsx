/** A current read-only observation; never changes or retries the transfer receipt. */
import { useEffect, useRef, useState } from 'react'
import { TransferDestinationHostChangedError, type SshApi } from '../api.ts'
import type { TransferJob } from '../transfer-queue.ts'
import type { TransferDestinationInfo } from '../../protocol.ts'
import { errorMessage, formatTimestamp, tt } from './helpers.ts'
import css from './panel.module.css'

type Observation = { kind: 'idle' | 'loading' | 'cancelled' } | { kind: 'error'; error: string; hostChanged?: boolean } | { kind: 'result'; value: TransferDestinationInfo }
export function TransferDestinationCheck({ api, job, active }: { api: SshApi; job: TransferJob; active: boolean }) {
  const [observation, setObservation] = useState<Observation>({ kind: 'idle' })
  const current = useRef<{ controller: AbortController } | undefined>(undefined)
  const checkButton = useRef<HTMLButtonElement | null>(null), cancelButton = useRef<HTMLButtonElement | null>(null), focusBack = useRef(false)
  useEffect(() => {
    setObservation({ kind: 'idle' })
    return () => { const pending = current.current; current.current = undefined; pending?.controller.abort() }
  }, [api, job.id, job.alias, job.path, job.updatedAt])
  useEffect(() => {
    if (observation.kind === 'loading' || !focusBack.current) return
    focusBack.current = false
    if (active && (document.activeElement === document.body || document.activeElement === checkButton.current || document.activeElement === cancelButton.current)) checkButton.current?.focus()
  }, [observation, active])
  const check = async (): Promise<void> => {
    if (current.current) return
    const request = { controller: new AbortController() }; current.current = request; focusBack.current = true
    setObservation({ kind: 'loading' })
    try {
      const value = await api.inspectDestination(job.alias, job.path, job.updatedAt, request.controller.signal)
      if (current.current === request) setObservation({ kind: 'result', value })
    } catch (cause) {
      if (current.current === request) setObservation({ kind: 'error', hostChanged: cause instanceof TransferDestinationHostChangedError, error: cause instanceof Error && cause.name === 'TimeoutError' ? tt('transfer.checkTimeout') : errorMessage(cause) })
    } finally { if (current.current === request) current.current = undefined }
  }
  const cancel = (): void => {
    const pending = current.current; current.current = undefined; pending?.controller.abort()
    setObservation({ kind: 'cancelled' })
  }
  const value = observation.kind === 'result' ? observation.value : undefined
  return <section className={css.destinationCheck} aria-label={tt('transfer.checkRegion', { id: job.id })}
    onKeyDown={event => { if (event.key === 'Escape' && observation.kind === 'loading') { event.preventDefault(); cancel() } }}>
    <div className={css.toolbar}>
      <button ref={checkButton} type="button" className={css.ghostButton} disabled={observation.kind === 'loading'} aria-label={tt('transfer.checkJob', { id: job.id })} onClick={() => { void check() }}>{tt(value ? 'transfer.checkAgain' : 'transfer.checkDestination')}</button>
      {observation.kind === 'loading' ? <>
        <span className={css.hint} role="status">{tt('transfer.checkingDestination')}</span>
        <button ref={cancelButton} type="button" className={css.linkButton} onClick={cancel}>{tt('transfer.cancelCheck')}</button>
      </> : <span className={css.hint}>{tt('transfer.readOnlyCheck')}</span>}
    </div>
    {observation.kind === 'cancelled' && <p className={css.queueOutcome} role="status">{tt('transfer.checkCancelled')}</p>}
    {observation.kind === 'error' && <>
      <p className={css.resultError} role="status">{observation.hostChanged ? tt('transfer.checkHostChanged') : tt('transfer.checkFailed', { error: observation.error })}</p>
      {observation.hostChanged && <details className={css.remoteErrorDetails}><summary>{tt('remote.errorDetails')}</summary><pre>{observation.error}</pre></details>}
    </>}
    {value && <>
      <div role="status">
        <strong className={css.checkResultTitle}>{tt(value.exists ? 'transfer.destinationExists' : 'transfer.destinationMissing')}</strong>
        {value.exists && <dl className={css.checkFacts}>
          <div><dt>{tt('transfer.destinationType')}</dt><dd>{tt(`transfer.destinationType.${value.type}`)}</dd></div>
          <div><dt>{tt('transfer.destinationSize')}</dt><dd>{tt('transfer.bytes', { value: value.size.toLocaleString() })}</dd></div>
          <div><dt>{tt('transfer.destinationModified')}</dt><dd>{formatTimestamp(value.mtimeMs)}</dd></div>
        </dl>}
        {value.exists && value.type === 'file' && job.sourceSize !== undefined && <p className={css.queueOutcome}>{tt(value.size === job.sourceSize ? 'transfer.sameSourceSize' : 'transfer.differentSourceSize', { bytes: job.sourceSize.toLocaleString() })}</p>}
      </div>
      <p className={css.queueOutcome}>{tt('transfer.checkedAt', { time: formatTimestamp(value.checkedAt) })}</p>
      <p className={css.queueOutcome}>{tt('transfer.checkReceiptUnchanged')}</p>
    </>}
  </section>
}
