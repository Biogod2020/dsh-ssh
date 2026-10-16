import type { RemoteWorkspace } from '../remote/types.ts'

export interface RemotePresentation {
  resume(workspace: RemoteWorkspace, sessionId?: string): boolean
  open(workspace: RemoteWorkspace, url: string, signal?: AbortSignal, sessionId?: string): Promise<void>
}

let current: RemotePresentation | undefined
export const remotePresentation = () => current
export function registerRemotePresentation(presentation: RemotePresentation): () => void {
  current = presentation
  return () => { if (current === presentation) current = undefined }
}

/** A launch ticket is valid only on the selected loopback gateway. */
export function gatewayUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
    || url.pathname !== '/' || !url.searchParams.get('dsh-remote-ticket')) throw new Error('Invalid remote workspace gateway')
  return url
}
