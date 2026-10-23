import type { RemoteWorkspace } from '../remote/types.ts'

export interface RemotePresentation {
  resume(workspace: RemoteWorkspace, sessionId?: string, signal?:AbortSignal): boolean | Promise<boolean>
  open(workspace: RemoteWorkspace, url: string, signal?: AbortSignal, sessionId?: string): Promise<void>
  beforeLeave?(): Promise<void>
  close?(workspace: RemoteWorkspace): void | Promise<void>
  settings?(workspace:RemoteWorkspace):boolean|Promise<boolean>
  reclaim?():Promise<void>
  preview?(workspace: RemoteWorkspace, sessionId: string, signal?: AbortSignal): Promise<void>
  previewFailed?(workspace: RemoteWorkspace): void
}

let current: RemotePresentation | undefined
export interface RemoteSelection { workspaceId: string; sessionId?: string }
let selected: RemoteSelection | undefined
const listeners = new Set<() => void>()
export const remoteSelection = () => selected
export function selectRemoteView(value?: RemoteSelection): void {
  if (selected?.workspaceId === value?.workspaceId && selected?.sessionId === value?.sessionId) return
  selected = value
  for (const listener of listeners) listener()
}
export function subscribeRemoteSelection(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener) }
}
export const remotePresentation = () => current
export function registerRemotePresentation(presentation: RemotePresentation): () => void {
  current = presentation
  return () => { if (current === presentation) current = undefined }
}

/** A launch ticket is valid only on the selected loopback gateway. */
export function gatewayUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port || url.username || url.password
    || url.pathname !== '/' || !url.searchParams.get('dsh-remote-ticket')) throw new Error('Invalid remote workspace gateway')
  return url
}
