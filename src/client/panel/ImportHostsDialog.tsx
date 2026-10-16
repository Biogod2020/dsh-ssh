import { useEffect, useRef, useState } from 'react'
import type { SshApi } from '../api.ts'
import type { ImportPreview, ImportResult, ImportSkipReason } from '../../protocol.ts'
import type { SshKey } from '../locales.ts'
import { errorMessage, tt } from './helpers.ts'
import css from './panel.module.css'

const reasons: Record<ImportSkipReason, SshKey> = {
  wildcard: 'import.reason.wildcard', existing: 'import.reason.existing',
  match: 'import.reason.match', invalid: 'import.reason.invalid',
}

/** Preview is local and read-only; nothing is selected or saved on opening. */
export function ImportHostsDialog({ api, onClose, onImported }: {
  api: SshApi; onClose: () => void; onImported: (result: ImportResult) => void
}) {
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    let active = true
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLInputElement>('input')?.focus()
    void api.previewSshConfig().then(value => { if (active) setPreview(value) })
      .catch(cause => { if (active) setError(errorMessage(cause)) })
    return () => { active = false; mounted.current = false; if (previous?.isConnected) previous.focus() }
  }, [api])

  const save = async () => {
    if (saving || selected.length === 0) return
    setSaving(true); setError(null)
    try {
      const result = await api.importSshConfig(selected)
      if (mounted.current) onImported(result)
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)) }
    finally { if (mounted.current) setSaving(false) }
  }
  const query = search.trim().toLocaleLowerCase()
  const candidates = preview?.candidates.filter(host => `${host.alias} ${host.user}@${host.host}:${host.port}`.toLocaleLowerCase().includes(query)) ?? []
  return <div className={css.modalBackdrop} onClick={() => { if (!saving) onClose() }}>
    <div ref={dialog} className={css.modal} role="dialog" aria-modal="true" aria-label={tt('import.title')}
      onClick={event => event.stopPropagation()} onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); if (!saving) onClose() }
        if (event.key === 'Tab') {
          const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary') ?? [])
          const first = items[0], last = items.at(-1)
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }
      }}>
      <h3 className={css.modalTitle}>{tt('import.title')}</h3>
      <p className={css.modalDescription}>{tt('import.help')}</p>
      <input type="search" className={css.input} aria-label={tt('import.search')} placeholder={tt('import.search')}
        value={search} disabled={saving} onChange={event => setSearch(event.target.value)} />
      {preview === null && error === null && <p role="status" className={css.hint}>{tt('common.loading')}</p>}
      {preview && <div className={css.importCandidates} role="group" aria-label={tt('import.title')}>
        {candidates.map(host => <label key={host.alias} className={css.importCandidate}>
          <input type="checkbox" checked={selected.includes(host.alias)} disabled={saving} aria-label={host.alias}
            onChange={event => setSelected(previous => event.target.checked ? [...previous, host.alias] : previous.filter(alias => alias !== host.alias))} />
          <span className={css.importIdentity}><strong>{host.alias}</strong>
            <span>{host.user}@{host.host}:{host.port}</span>
            {(host.hasProxyCommand || host.proxyJump.length > 0) && <span className={css.hint}>{tt('hosts.proxyBadge')}{host.proxyJump.length > 0 ? ` · ${host.proxyJump.join(' → ')}` : ''}</span>}
          </span>
        </label>)}
        {candidates.length === 0 && <p className={css.pickerMessage}>{tt(preview.candidates.length ? 'hosts.noResults' : 'import.empty')}</p>}
      </div>}
      {preview && preview.skippedBlocks.length > 0 && <details>
        <summary className={css.hint}>{tt('import.unavailable', { count: preview.skippedBlocks.length })}</summary>
        <ul className={css.importSkips}>{preview.skippedBlocks.map(block => <li key={block.name} className={css.importSkipRow}>
          <span className={css.mono}>{block.name}</span><span className={css.cellMuted}>{tt(reasons[block.reason])}</span>
        </li>)}</ul>
      </details>}
      {error && <p className={css.formError} role="alert">{error}</p>}
      <p className={css.hint} role="status">{tt('import.selected', { count: selected.length })}</p>
      <div className={css.modalFooter}>
        <button type="button" className={css.ghostButton} disabled={saving} onClick={onClose}>{tt('form.cancel')}</button>
        <button type="button" className={css.primaryButton} disabled={saving || selected.length === 0} onClick={() => { void save() }}>{saving ? tt('common.loading') : tt('import.confirm')}</button>
      </div>
    </div>
  </div>
}
