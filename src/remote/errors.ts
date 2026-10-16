/** Stable business code only; upstream details and credentials are never copied into public state. */
export class RemoteFailureError extends Error {
  constructor(message: string, readonly errorCode?: string) { super(message); this.name = 'RemoteFailureError' }
}
export function remoteErrorCode(error: unknown): string | undefined {
  return error instanceof RemoteFailureError && typeof error.errorCode === 'string' && error.errorCode.length <= 128
    ? error.errorCode : undefined
}
