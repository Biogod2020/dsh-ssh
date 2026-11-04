import { useEffect, useState } from 'react'
import type { SshApi } from '../api.ts'
import type { PluginUpdateView } from '../../update-types.ts'
import { tt } from './helpers.ts'
import css from './panel.module.css'

export function UpdatesTab({ api, active }: { api: SshApi; active: boolean }) {
  const [view, setView] = useState<PluginUpdateView>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!active) return
    let live = true
    const read = () => { void api.pluginUpdate().then(value => { if (live) { setView(value); setError('') } }, reason => { if (live) setError(String(reason.message ?? reason)) }) }
    read()
    const timer = setInterval(read, 5000)
    return () => { live = false; clearInterval(timer) }
  }, [api, active])
  const change = async (enabled: boolean) => {
    setBusy(true); setError('')
    try { setView(await api.setPluginUpdate(enabled)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return <div>
    <h3>{tt('update.title')}</h3>
    <p className={css.hint}>{tt('update.help')}</p>
    <label><input type="checkbox" checked={view?.enabled ?? false} disabled={busy || !view?.supported}
      onChange={event => { void change(event.target.checked) }} /> {tt('update.enable')}</label>
    {view && <>
      <p>{tt('update.version')}: {view.runningVersion}</p>
      <p role="status">{tt(`update.${view.phase}`)}{view.availableVersion ? ` (${view.availableVersion})` : ''}</p>
    </>}
    {error && <p role="alert">{error}</p>}
  </div>
}
