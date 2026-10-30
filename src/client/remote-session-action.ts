import type { RemoteWorkspace, RemoteForkResult } from '../remote/types.ts'
import { remoteNavigation } from './remote-navigation.ts'
import { RemoteRequestError } from './remote-errors.ts'
import { tt } from './panel/helpers.ts'
import { remotePresentation, remoteSelection } from './remote-presentation.ts'
import { parseSessionActivity } from '../remote/session-activity.ts'

export type RemoteSessionAction = 'pin' | 'unpin' | 'archive' | 'unarchive' | 'rename'
export async function forkRemoteSession(workspace: RemoteWorkspace, sessionId: string, title?: string): Promise<RemoteForkResult> {
  await remotePresentation()?.beforeLeave?.()
  const result = await dispatchRemoteSessionAction(workspace, sessionId, 'fork', title?.trim() ? title : undefined)
  if (typeof result.sessionId !== 'string' || !result.sessionId || result.sessionId.length > 256 || /[\u0000-\u001f\u007f]/.test(result.sessionId)) throw new RemoteRequestError(tt('remote.actionUnconfirmed'))
  return { sessionId: result.sessionId, ...(result.titleUnconfirmed === true ? { titleUnconfirmed: true } : {}) }
}
export async function archiveRemoteSession(workspace: RemoteWorkspace, sessionId: string, stopActivity = false): Promise<void> {
  const selected = remoteSelection()
  if (selected?.workspaceId === workspace.id && selected.sessionId === sessionId) await remotePresentation()?.beforeLeave?.()
  // Confirmation belongs to the official overlay. A refusal never retries here.
  await mutateRemoteSession(workspace, sessionId, 'archive', undefined, stopActivity)
}
const pending = new Set<string>()
/** One explicit write per Session, including across row/menu remounts. */
export async function mutateRemoteSession(workspace: RemoteWorkspace, sessionId: string, action: RemoteSessionAction, title?: string, stopActivity = false): Promise<void> {
  await dispatchRemoteSessionAction(workspace, sessionId, action, title, stopActivity)
}
async function dispatchRemoteSessionAction(workspace: RemoteWorkspace, sessionId: string, action: RemoteSessionAction | 'fork', title?: string, stopActivity = false): Promise<{ sessionId?: string; titleUnconfirmed?: true }> {
  const key = JSON.stringify([workspace.hostId, workspace.id, sessionId])
  if (pending.has(key)) throw new Error(tt('remote.actionPending'))
  const owns = () => remoteNavigation.getSnapshot().workspaces.some(row => row.id === workspace.id && row.hostId === workspace.hostId)
  if (!owns()) throw new Error(tt('remote.desktopIdentityChanged'))
  pending.add(key)
  try {
    remoteNavigation.invalidate(workspace)
    const response = await fetch('/api/dsh-ssh/remote/session/action', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: workspace.id, expectedHostId: workspace.hostId, sessionId, action, ...(title === undefined ? {} : { title }), ...(stopActivity ? { stopActivity: true } : {}) }),
    })
    const value = await response.json()
    if (!response.ok || value?.ok !== true) throw new RemoteRequestError(tt(value?.errorCode === 'session/fork-unavailable' ? 'remote.forkUnavailable' : 'remote.actionUnconfirmed'), typeof value?.errorCode === 'string' ? value.errorCode : undefined,
      action === 'archive' && !stopActivity && value?.errorCode === 'workspace/session-active' ? parseSessionActivity(value.activity) : undefined)
    if (!owns()) throw new Error(tt('remote.desktopIdentityChanged'))
    return value
  } finally {
    // A lost acknowledgement still triggers a read, never a repeated write.
    try {
      remoteNavigation.invalidate(workspace)
      if (owns()) await remoteNavigation.refresh(workspace)
    } finally { pending.delete(key) }
  }
}
