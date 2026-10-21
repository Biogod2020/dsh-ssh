import { useEffect, useId, useRef, useState } from 'react'
import type { SshHostSummary } from '../protocol.ts'
import { hostHistoryId, readRecentHostIds } from './host-picker-history.ts'
import { tt } from './panel/helpers.ts'
import css from './panel/panel.module.css'

const INITIAL_LIMIT = 3
const SEARCH_LIMIT = 50

/** Local-only host selection. No credential reads, probes, or connections. */
export function HostPicker({ hosts, value, disabled, loading, onChange, onChoosingChange }: {
  hosts: SshHostSummary[]; value: string; disabled: boolean; loading: boolean; onChange: (alias: string) => void
  onChoosingChange: (choosing: boolean) => void
}) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const change = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(!value)
  const [active, setActive] = useState(-1)
  const [recent] = useState(readRecentHostIds)
  const selected = hosts.find(host => host.alias === value)
  useEffect(() => { setExpanded(!value); setQuery(''); setActive(-1) }, [value])
  useEffect(() => { if (expanded && !disabled) input.current?.focus() }, [expanded, disabled])

  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const matches = hosts.filter(host => {
    const text = [host.alias, host.host, host.user, String(host.port), host.environment ?? '', host.description ?? '', ...host.tags].join(' ').toLocaleLowerCase()
    return tokens.every(token => text.includes(token))
  })
  const needle = query.trim().toLocaleLowerCase()
  const rank = (host: SshHostSummary) => host.alias.toLocaleLowerCase() === needle ? 0 : host.alias.toLocaleLowerCase().startsWith(needle) ? 1 : 2
  const recentHosts = recent.flatMap(key => hosts.filter(host => hostHistoryId(host) === key)).slice(0, 3)
  const recentSet = new Set(recentHosts.map(host => host.alias))
  const ordered = tokens.length ? [...matches].sort((a, b) => rank(a) - rank(b))
    : [...recentHosts, ...hosts.filter(host => !recentSet.has(host.alias))]
  const visible = ordered.slice(0, tokens.length ? SEARCH_LIMIT : INITIAL_LIMIT)
  const current = active >= 0 && active < visible.length ? active : -1
  const showingPicker = expanded || !selected
  useEffect(() => { onChoosingChange(showingPicker) }, [showingPicker, onChoosingChange])
  const choose = (host: SshHostSummary) => {
    onChange(host.alias); setExpanded(false); setQuery(''); setActive(-1)
    // The option is removed by selection; return focus to its replacement.
    requestAnimationFrame(() => change.current?.focus())
  }
  useEffect(() => { if (current >= 0) list.current?.querySelector<HTMLElement>(`[data-host-index="${current}"]`)?.scrollIntoView?.({ block: 'nearest' }) }, [current])

  const identity = (host: SshHostSummary) => <span className={css.hostPickerIdentity}>
    <strong>{host.alias}</strong><span className={css.hostPickerAddress}>{host.user}@{host.host}:{host.port}</span>
  </span>
  return <div className={css.field}>
    <label className={css.fieldLabel} htmlFor={showingPicker ? id : undefined}>{tt('workspace.host')}</label>
    {!showingPicker && selected ? <div className={css.hostPickerSelection} data-selected-host={selected.alias}>
      {identity(selected)}<button ref={change} type="button" className={css.linkButton} disabled={disabled}
        onClick={() => { setExpanded(true); setQuery(''); setActive(-1) }}>{tt('workspace.changeHost')}</button>
    </div> : <>
      <input ref={input} id={id} type="search" className={css.input} value={query} disabled={disabled}
        role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-list`}
        aria-activedescendant={current >= 0 ? `${id}-option-${current}` : undefined}
        autoComplete="off" spellCheck={false} placeholder={tt('workspace.searchHosts')}
        onChange={event => { setQuery(event.target.value); setActive(-1) }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); event.stopPropagation()
            if (visible.length) setActive(event.key === 'ArrowDown' ? (current + 1) % visible.length : current <= 0 ? visible.length - 1 : current - 1)
          } else if (event.key === 'Enter') {
            event.preventDefault(); event.stopPropagation()
            const host = visible[current < 0 ? 0 : current]
            if (host) choose(host)
          } else if (event.key === 'Escape' && (selected || query)) {
            event.preventDefault(); event.stopPropagation()
            if (selected) { setExpanded(false); requestAnimationFrame(() => change.current?.focus()) }
            setQuery(''); setActive(-1)
          }
        }} />
      <div className={css.hostPickerResults}>
        <div ref={list} id={`${id}-list`} role="listbox" aria-label={tt('workspace.chooseHost')} aria-busy={loading}
          className={css.hostPickerList}>
          {visible.map((host, index) => <div key={host.alias}>
            {!tokens.length && (index === 0 || index === recentHosts.length) && <div className={css.hostPickerHeading} role="presentation">
              {tt(recentHosts.length && index === 0 ? 'workspace.recentHosts' : recentHosts.length ? 'workspace.otherHosts' : 'workspace.availableHosts')}
            </div>}
            <button type="button" role="option" tabIndex={-1} id={`${id}-option-${index}`} data-host-index={index} data-host-alias={host.alias}
              aria-selected={value === host.alias} disabled={disabled} className={`${css.hostPickerOption} ${current === index ? css.hostPickerActive : ''}`}
              onMouseDown={event => event.preventDefault()} onClick={() => choose(host)}>
              {identity(host)}{host.environment && <span className={css.hostPickerTag}>{host.environment}</span>}
            </button>
          </div>)}
        </div>
        {loading ? <p className={css.pickerMessage} role="status">{tt('common.loading')}</p>
          : <p className={css.hostPickerCount} role="status">{tt(!hosts.length ? 'workspace.noConfiguredHosts' : !matches.length ? 'hosts.noResults'
            : visible.length < ordered.length ? 'workspace.refineHosts' : 'workspace.hostResults', { shown: visible.length, count: ordered.length })}</p>}
      </div>
    </>}
  </div>
}
