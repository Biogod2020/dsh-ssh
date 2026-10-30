import { parseSessionActivity, type SessionActivitySummary } from './session-activity.ts'

/** Stable business code only; upstream details and credentials are never copied into public state. */
export class RemoteFailureError extends Error {
  constructor(message: string, readonly errorCode?: string, readonly activity?: SessionActivitySummary[]) { super(message); this.name = 'RemoteFailureError' }
}
export function remoteErrorCode(error: unknown): string | undefined {
  return error instanceof RemoteFailureError && typeof error.errorCode === 'string' && error.errorCode.length <= 128
    ? error.errorCode : undefined
}
/** Only the validated archive-admission summary has a public error-body path. */
export function remoteErrorActivity(error: unknown): SessionActivitySummary[] | undefined {
  if (!(error instanceof RemoteFailureError) || error.errorCode !== 'workspace/session-active') return undefined
  return parseSessionActivity(error.activity)
}
