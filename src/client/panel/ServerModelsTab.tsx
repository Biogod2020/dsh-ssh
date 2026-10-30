import { useEffect, useRef, useState } from 'react'
import type { SshApi } from '../api.ts'
import type { SshHostSummary } from '../../protocol.ts'
import type { ModelFollowMode, ModelFollowPolicyChange, ModelFollowStatus, ModelFollowView } from '../../remote/model-types.ts'
import type { SshKey } from '../locales.ts'
import { errorMessage, tt } from './helpers.ts'
import css from './panel.module.css'

const STATUS: Record<ModelFollowStatus, SshKey> = { pending: 'models.pending', syncing: 'models.syncing', synced: 'models.synced', independent: 'models.independent', blocked: 'models.blocked', uncertain: 'models.uncertain' }
const REASON: Record<string, SshKey> = { 'local-endpoint': 'models.localEndpoint', 'login-auth': 'models.localEndpoint', 'missing-key': 'models.missingKey', 'remote-edited': 'models.remoteEdited', 'unsupported': 'models.unsupported', 'inspect-required': 'models.uncertain' }

/** Reads only cached state. Choosing a host never establishes an SSH connection. */
export function ServerModelsTab({ api, active = true }: { api: SshApi; active?: boolean }) {
  const [hosts, setHosts] = useState<SshHostSummary[]>([]), [alias, setAlias] = useState('')
  const [view, setView] = useState<ModelFollowView>(), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const epoch = useRef(0), mounted = useRef(true), sending = useRef(false), errorOwner = useRef<'read' | 'action'>('read')
  const host = hosts.find(row => row.alias === alias)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++ } }, [])
  useEffect(() => {
    if (!active) return
    let disposed = false
    void api.listHosts().then(rows => { if (!disposed) setHosts(rows) }).catch(cause => { if (!disposed) setError(errorMessage(cause)) })
    return () => { disposed = true }
  }, [api, active])
  useEffect(() => {
    if (!active || !host) return
    const current = ++epoch.current
    let disposed = false, reading = false
    const read = async () => {
      if (disposed || reading || document.visibilityState === 'hidden') return
      reading = true
      try {
        const next = await api.serverModels(host.alias, host.updatedAt)
        if (!disposed && epoch.current === current) {
          setView(next)
          if (errorOwner.current === 'read' || !sending.current && !['syncing', 'uncertain'].includes(next.state)) setError('')
        }
      }
      catch (cause) { if (!disposed && epoch.current === current && !sending.current) { errorOwner.current = 'read'; setError(errorMessage(cause)) } }
      finally { reading = false }
    }
    void read(); const timer = setInterval(() => { void read() }, 3000)
    return () => { disposed = true; clearInterval(timer) }
  }, [api, active, host?.alias, host?.updatedAt])
  const change = async (policy: ModelFollowPolicyChange) => {
    if (!host || sending.current) return
    const current = epoch.current; sending.current = true; errorOwner.current = 'action'; setBusy(true); setError('')
    try { const next = await api.setServerModelPolicy(host.alias, host.updatedAt, policy); if (mounted.current && current === epoch.current) setView(next) }
    catch { if (mounted.current && current === epoch.current) setError(tt('models.observeHint')) }
    finally { sending.current = false; if (mounted.current) setBusy(false) }
  }
  const open = async () => {
    if (!host || busy) return
    // Reserve during the click so a browser does not reject an async popup.
    const page = window.open('about:blank', '_blank'); if (page) page.opener = null
    try { const result = await api.openServerModels(host.alias, host.updatedAt); if (page) page.location.href = result.url }
    catch (cause) { page?.close(); errorOwner.current = 'action'; setError(errorMessage(cause)) }
  }
  return <div className={css.serverPlugins}>
    <h3>{tt('models.title')}</h3><p className={css.hint}>{tt('models.help')}</p>
    <div className={css.toolbar}>
      <label>{tt('plugins.host')} <select aria-label={tt('plugins.host')} value={alias} disabled={busy} onChange={event => { epoch.current++; errorOwner.current = 'read'; setAlias(event.target.value); setView(undefined); setError('') }}>
        <option value="">{tt('plugins.chooseHost')}</option>
        {hosts.map(row => <option key={row.alias} value={row.alias}>{row.alias} · {row.user}@{row.host}:{row.port}</option>)}
      </select></label>
      {view && <label>{tt('models.mode')} <select aria-label={tt('models.mode')} value={view.mode} disabled={busy} onChange={event => { void change({ mode: event.target.value as ModelFollowMode }) }}>
        <option value="follow">{tt('models.follow')}</option><option value="independent">{tt('models.independent')}</option>
      </select></label>}
      <button type="button" disabled={!view?.connected || busy} onClick={() => { void open() }}>{tt('models.open')}</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {view && <>
      {!view.connected && <p className={css.hint}>{tt('models.connect')}</p>}
      {view.state === 'syncing' && <p aria-live="polite">{tt('models.syncing')}</p>}
      {view.state === 'restart-required' && <p role="status">{tt('models.restart')}</p>}
      {(view.state === 'uncertain' || view.state === 'unsupported') && <p role="alert">{tt(view.state === 'uncertain' ? 'models.uncertain' : 'models.unsupported')}</p>}
      <p className={css.hint}>{tt('models.independentHelp')}</p>
      <div className={css.tableWrap}><table className={css.table}>
        <thead><tr><th>{tt('models.provider')}</th><th>{tt('models.count')}</th><th>{tt('plugins.status')}</th><th>{tt('models.mode')}</th></tr></thead>
        <tbody>{view.rows.map(row => <tr key={row.id}>
          <td>{row.label}<small> · {row.provider}</small></td><td>{row.modelCount ?? '—'}</td>
          <td>{tt(STATUS[row.status])}{row.reason && REASON[row.reason] && <small> · {tt(REASON[row.reason]!)}</small>}</td>
          <td><button type="button" disabled={busy || view.mode === 'independent'} onClick={() => { void change({ provider: row.id, providerMode: row.mode === 'independent' ? 'follow' : 'independent' }) }}>{tt(row.mode === 'independent' ? 'models.follow' : 'models.independent')}</button></td>
        </tr>)}</tbody>
      </table></div>
      {view.default && <label>{tt('models.default')} <select aria-label={tt('models.default')} disabled={busy || view.mode === 'independent'} value={view.default.mode}
        onChange={event => { void change({ provider: '@default', providerMode: event.target.value as ModelFollowMode }) }}>
        <option value="follow">{tt('models.follow')}</option><option value="independent">{tt('models.independent')}</option>
      </select> <small>{tt(STATUS[view.default.status])}</small></label>}
      {view.checkedAt && <p className={css.hint}>{tt('models.checked')} {new Date(view.checkedAt).toLocaleTimeString()}</p>}
    </>}
  </div>
}
