/** Filtering and navigation only; the complete run remains owned by ClusterTab. */
import { useLayoutEffect, useRef, useState } from 'react'
import type { ClusterRow } from '../cluster-history.ts'
import { tt } from './helpers.ts'
import css from './panel.module.css'

type ResultFilter = 'all' | 'attention' | 'active' | 'ok' | 'notRun'
const filters: ResultFilter[] = ['all', 'attention', 'active', 'ok', 'notRun']
function matches(row: ClusterRow, filter: ResultFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'attention') return ['fail', 'timeout', 'stopped', 'unknown'].includes(row.phase)
  if (filter === 'active') return ['queued', 'connecting', 'running'].includes(row.phase)
  return row.phase === filter
}

export function ClusterResults({ rows, active, onCopy }: { rows: ClusterRow[]; active: boolean; onCopy(row: ClusterRow): void }) {
  const [search, setSearch] = useState(''), [filter, setFilter] = useState<ResultFilter>('all'), [jump, setJump] = useState('')
  const searchInput = useRef<HTMLInputElement>(null), scroll = useRef<HTMLDivElement>(null)
  const cards = useRef(new Map<string, HTMLElement>())
  const removedFocus = useRef<string | null>(null)
  useLayoutEffect(() => {
    const alias = removedFocus.current
    removedFocus.current = null
    // A live filter can remove the focused card. Restore a usable local control
    // only if focus was lost; never move focus from another panel or control.
    if (alias && !cards.current.has(alias) && active && (document.activeElement === document.body || !document.activeElement?.isConnected)) {
      searchInput.current?.focus({ preventScroll: true })
    }
  })
  const query = search.trim().toLowerCase()
  const visible = rows.filter(row => matches(row, filter) && `${row.alias}\n${row.user}@${row.host}:${row.port}`.toLowerCase().includes(query))
  const selected = visible.some(row => row.alias === jump) ? jump : ''
  const reset = (): void => { setSearch(''); setFilter('all'); setJump(''); if (active) searchInput.current?.focus() }
  const locate = (): void => {
    const target = cards.current.get(selected), viewport = scroll.current
    if (!active || !target || !viewport) return
    target.focus({ preventScroll: true })
    const top = target.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop
    // Move only the results viewport, leaving the page and other panels alone.
    viewport.scrollTop = Math.max(0, top)
  }
  return <>
    <div className={css.clusterResultControls}>
      <div className={css.clusterResultSearch}>
        <input ref={searchInput} className={css.input} type="search" aria-label={tt('cluster.searchResults')} placeholder={tt('cluster.searchResultsHint')} value={search}
          onChange={event => { setSearch(event.target.value); setJump('') }} onKeyDown={event => {
            if (event.key === 'Escape' && search) { event.preventDefault(); event.stopPropagation(); setSearch(''); setJump('') }
          }} />
        <select className={css.input} aria-label={tt('cluster.filterResults')} value={filter} onChange={event => { setFilter(event.target.value as ResultFilter); setJump('') }}>
          {filters.map(value => <option key={value} value={value}>{tt(`cluster.filter.${value}`)} ({rows.filter(row => matches(row, value)).length})</option>)}
        </select>
      </div>
      <div className={css.clusterResultNavigation}>
        <span className={css.hint} role="status">{tt('cluster.shownResults', { shown: visible.length, total: rows.length })}</span>
        <select className={css.input} aria-label={tt('cluster.jumpResult')} value={selected} disabled={!visible.length} onChange={event => setJump(event.target.value)}>
          <option value="">{tt('cluster.chooseResult')}</option>
          {visible.map(row => <option key={row.alias} value={row.alias}>{row.alias} · {tt(`cluster.${row.phase}`)}</option>)}
        </select>
        <button type="button" className={css.ghostButton} disabled={!selected} onClick={locate}>{tt('cluster.viewResult')}</button>
        {(search || filter !== 'all') && <button type="button" className={css.linkButton} onClick={reset}>{tt('cluster.clearResultFilters')}</button>}
      </div>
    </div>
    <div ref={scroll} className={css.hostScroll} aria-label={tt('cluster.results')}>
      {!visible.length && <div className={css.empty} role="status">{tt('cluster.noResultMatches')}</div>}
      <div className={css.hostList}>
        {visible.map(row => <article key={row.alias} ref={node => {
          if (node) cards.current.set(row.alias, node)
          else {
            if (cards.current.get(row.alias)?.contains(document.activeElement)) removedFocus.current = row.alias
            cards.current.delete(row.alias)
          }
        }} tabIndex={-1}
          className={css.resultCard} data-uncertain={row.phase === 'unknown' || row.phase === 'stopped'} aria-label={row.alias}>
          <div className={css.resultHeading}><strong className={css.hostAlias}>{row.alias}</strong>
            <span className={css.badge} data-status={row.phase}>{tt(`cluster.${row.phase}`)}</span>
            <button type="button" className={css.ghostButton} aria-label={tt('cluster.copyHost', { alias: row.alias })} onClick={() => onCopy(row)}>{tt('cluster.copy')}</button>
          </div>
          <p className={css.clusterIdentity}>{row.user}@{row.host}:{row.port}{row.result && ` · ${tt('cluster.col.exit')}: ${row.result.exitCode ?? '—'}`}{row.result?.durationMs !== undefined && ` · ${row.result.durationMs} ms`}</p>
          {row.result?.cancelled && row.result.dispatched === false
            ? <p className={css.hint} role="status">{tt('cluster.cancelledBeforeDispatch')}</p>
            : row.result?.error && <p className={css.resultError} role="status">{row.result.error}</p>}
          {(['stdout', 'stderr'] as const).map(stream => row[stream] && <details key={stream} className={css.cellDetails} open><summary>{tt(`cluster.col.${stream}`)}</summary><pre className={css.resultOutput}>{row[stream]}</pre></details>)}
          {(row.outputTruncated?.stdout || row.outputTruncated?.stderr) && <p className={css.hint} role="status">{tt('cluster.savedTruncated')}</p>}
        </article>)}
      </div>
    </div>
  </>
}
