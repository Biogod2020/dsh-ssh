import { tt } from './panel/helpers.ts'
import { remoteErrorView } from './remote-errors.ts'
import css from './panel/panel.module.css'

export function RemoteErrorNotice({ error }: { error: unknown }) {
  const view = remoteErrorView(error)
  return <div className={css.remoteErrorNotice}>
    <p className={css.formError} role="alert">{view.summary}</p>
    {view.help && <p className={css.hint}>{view.help}</p>}
    {view.details && <details className={css.remoteErrorDetails}><summary>{tt('remote.errorDetails')}</summary><pre>{view.details}</pre></details>}
  </div>
}
