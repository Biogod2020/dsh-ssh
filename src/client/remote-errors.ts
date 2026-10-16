import { errorMessage, tt } from './panel/helpers.ts'

export class RemoteRequestError extends Error {
  constructor(message: string, readonly errorCode?: string) { super(message); this.name = 'RemoteRequestError' }
}
export interface RemoteErrorView { summary: string; details?: string; help?: string; unconfirmed?: boolean }
/** Business codes describe categories; an invalid path does not necessarily mean ENOENT. */
export function remoteErrorView(error: unknown): RemoteErrorView {
  const original = errorMessage(error)
  const code = error instanceof RemoteRequestError ? error.errorCode : undefined
  if (code === 'workspace/invalid-path') return { summary: tt('remote.invalidPath'), help: tt('remote.invalidPathHelp'), details: original }
  if (code === 'ssh/host-changed') return { summary: tt('remote.hostChanged'), help: tt('remote.hostChangedHelp'), details: original }
  if (code === 'ssh/setup-interrupted') return { summary: tt('remote.setupUnconfirmed'), help: tt('remote.setupUnconfirmedHelp'), details: original, unconfirmed: true }
  if (code === 'ssh/activity-unavailable') return { summary: tt('remote.historyUnavailable'), help: tt('remote.historyUnavailableHelp'), details: original, unconfirmed: true }
  return original.length > 220 ? { summary: tt('remote.requestFailed'), details: original } : { summary: original }
}
