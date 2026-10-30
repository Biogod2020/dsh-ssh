import { useEffect, useRef, useState } from 'react'
import { SshApiError, type SshApi } from '../api.ts'
import type { SshHostSummary } from '../../protocol.ts'
import type { PluginSyncBlock, PluginSyncItem, PluginSyncJob, ServerPluginComparison, ServerPluginRow } from '../../remote/plugin-types.ts'
import type { SshKey } from '../locales.ts'
import { errorMessage, tt } from './helpers.ts'
import css from './panel.module.css'

const BLOCK: Record<PluginSyncBlock, SshKey> = {
  'local-disabled': 'plugins.localDisabled', builtin: 'plugins.builtin', development: 'plugins.development', unpublished: 'plugins.unpublished', incompatible: 'plugins.incompatible',
  'registry-unavailable': 'plugins.registryUnavailable', 'remote-only': 'plugins.remoteOnly', 'missing-version': 'plugins.missingVersion',
}
const ITEM: Record<PluginSyncItem['state'], SshKey> = {
  waiting: 'plugins.waiting', installing: 'plugins.installing', installed: 'plugins.installed', 'restart-required': 'plugins.restart',
  failed: 'plugins.failed', uncertain: 'plugins.uncertain', skipped: 'plugins.skipped',
}
const STATUS: Record<ServerPluginRow['status'], SshKey> = {
  same: 'plugins.same', different: 'plugins.different', missing: 'plugins.missing', 'remote-only': 'plugins.remoteOnly',
}

/** Comparing is explicit. Reading a tab or choosing a host never opens SSH. */
export function ServerPluginsTab({ api, active = true }: { api: SshApi; active?: boolean }) {
  const [hosts, setHosts] = useState<SshHostSummary[]>([]), [alias, setAlias] = useState('')
  const [comparison, setComparison] = useState<ServerPluginComparison>(), [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState(''), [reading, setReading] = useState(false), [sending, setSending] = useState(false)
  const [job, setJob] = useState<PluginSyncJob>()
  const [showBuiltins, setShowBuiltins] = useState(false)
  const generation = useRef(0), mounted = useRef(true), sendingNow = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++ } }, [])
  useEffect(() => {
    if (!active) return
    let disposed = false
    void api.listHosts().then(rows => { if (!disposed) setHosts(rows) }).catch(cause => { if (!disposed) setError(errorMessage(cause)) })
    return () => { disposed = true }
  }, [api, active])
  useEffect(() => {
    if (!active || job?.state !== 'running') return
    let disposed = false, running = false
    const poll = async () => {
      if (disposed || running || document.visibilityState === 'hidden') return
      running = true
      try { const next = await api.serverPluginJob(job.id); if (!disposed) { setJob(next); setError('') } }
      catch { if (!disposed) setError(tt('plugins.observeFailed')) }
      finally { running = false }
    }
    void poll()
    const timer = setInterval(() => { void poll() }, 2000)
    document.addEventListener('visibilitychange', poll)
    return () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', poll) }
  }, [api, active, job?.id, job?.state])
  const host = hosts.find(row => row.alias === alias), busy = sending || job?.state === 'running'
  const compare = async () => {
    if (!host || reading || busy) return
    const seq = ++generation.current
    setReading(true); setError(''); setComparison(undefined); setSelected([]); setJob(undefined)
    try {
      const next = await api.compareServerPlugins(host.alias, host.updatedAt)
      if (mounted.current && generation.current === seq) setComparison(next)
    } catch (cause) { if (mounted.current && generation.current === seq) setError(errorMessage(cause)) }
    finally { if (mounted.current && generation.current === seq) setReading(false) }
  }
  const sync = async () => {
    if (!comparison || !selected.length || busy || sendingNow.current || comparison.hostUpdatedAt !== host?.updatedAt) return
    sendingNow.current = true; setSending(true); setError('')
    const id = crypto.randomUUID()
    try {
      const next = await api.syncServerPlugins(comparison.planId, selected, id)
      if (mounted.current) { setJob(next); setSelected([]); setComparison(undefined) }
    } catch (cause) {
      if (cause instanceof SshApiError && cause.status && cause.status >= 400 && cause.status < 500) {
        if (mounted.current) { setError(errorMessage(cause)); setComparison(undefined); setSelected([]) }
        return
      }
      // Recover only the receipt, never the POST. A lost response can follow a
      // completed remote installation and is not permission to repeat it.
      try { const next = await api.serverPluginJob(id); if (mounted.current) { setJob(next); setComparison(undefined); setSelected([]) } }
      catch { if (mounted.current) { setError(tt('plugins.syncUnknown')); setComparison(undefined); setSelected([]) } }
    } finally { sendingNow.current = false; if (mounted.current) setSending(false) }
  }
  const choose = (value: string) => {
    generation.current++; setAlias(value); setComparison(undefined); setSelected([]); setError(''); setReading(false); setJob(undefined)
  }
  return <div className={css.serverPlugins}>
    <h3>{tt('plugins.title')}</h3>
    <p className={css.hint}>{tt('plugins.help')}</p>
    <div className={css.toolbar}>
      <label>{tt('plugins.host')} <select aria-label={tt('plugins.host')} value={alias} disabled={busy} onChange={event => choose(event.target.value)}>
        <option value="">{tt('plugins.chooseHost')}</option>
        {hosts.map(row => <option key={row.alias} value={row.alias}>{row.alias} · {row.user}@{row.host}:{row.port}</option>)}
      </select></label>
      <button type="button" disabled={!host || busy || reading} onClick={() => { void compare() }}>{tt(reading ? 'plugins.reading' : 'plugins.compare')}</button>
    </div>
    <p className={css.hint}>{tt('plugins.connectHelp')}</p>
    {error && <p role="alert">{error}</p>}
    {comparison && <>
      <p>{comparison.alias} · DSH {comparison.dshVersion} · {new Date(comparison.checkedAt).toLocaleTimeString()}</p>
      <label><input type="checkbox" checked={showBuiltins} onChange={event => setShowBuiltins(event.target.checked)} /> {tt('plugins.showBuiltins')}</label>
      <div className={css.tableWrap}><table className={css.table}>
        <thead><tr><th>{tt('plugins.select')}</th><th>{tt('plugins.package')}</th><th>{tt('plugins.local')}</th><th>{tt('plugins.remote')}</th><th>{tt('plugins.status')}</th></tr></thead>
        <tbody>{comparison.rows.filter(row => showBuiltins || row.block !== 'builtin').sort((a, b) => Number(!!b.spec) - Number(!!a.spec) || Number(!!b.local) - Number(!!a.local) || a.name.localeCompare(b.name)).map(row => <tr key={row.name}>
          <td><input type="checkbox" aria-label={tt('plugins.selectPackage', { name: row.name })} checked={selected.includes(row.name)}
            disabled={!row.spec || !!row.block || busy} onChange={event => setSelected(old => event.target.checked ? [...old, row.name] : old.filter(name => name !== row.name))} /></td>
          <td><code>{row.name}</code></td><td>{row.local?.version ?? '—'}{row.local && !row.local.enabled ? ` · ${tt('plugins.disabled')}` : ''}</td>
          <td>{row.remote?.version ?? '—'}{row.remote && !row.remote.enabled ? ` · ${tt('plugins.disabled')}` : ''}</td>
          <td>{tt(row.block ? BLOCK[row.block] : STATUS[row.status])}{row.requirement && <small> {row.requirement}</small>}</td>
        </tr>)}</tbody>
      </table></div>
      <p className={css.hint}>{tt('plugins.syncHelp')}</p>
      <button type="button" className={css.primaryButton} disabled={!selected.length || busy || host?.updatedAt !== comparison.hostUpdatedAt}
        onClick={() => { void sync() }}>{tt(sending ? 'plugins.sending' : 'plugins.sync', { count: selected.length })}</button>
    </>}
    {job && <section aria-label={tt('plugins.result')} aria-live="polite">
      <h4>{tt('plugins.result')} · {job.alias}</h4>
      {job.items.map(item => <p key={item.name}><code>{item.name}@{item.version}</code> — {tt(ITEM[item.state])}{item.errorCode ? ` (${item.errorCode})` : ''}</p>)}
      {job.state === 'uncertain' && <p role="alert">{tt('plugins.syncUnknown')}</p>}
      {job.state === 'failed' && <p role="alert">{tt('plugins.batchFailed')}</p>}
      {job.items.some(item => item.state === 'restart-required') && <p>{tt('plugins.restartHelp')}</p>}
    </section>}
  </div>
}
