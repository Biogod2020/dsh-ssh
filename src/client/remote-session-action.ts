import type { RemoteWorkspace } from '../remote/types.ts'
import { remoteNavigation } from './remote-navigation.ts'
import { RemoteRequestError } from './remote-errors.ts'
import { tt } from './panel/helpers.ts'
import { remotePresentation, remoteSelection } from './remote-presentation.ts'

export type RemoteSessionAction = 'pin' | 'unpin' | 'archive' | 'unarchive' | 'rename'
export async function archiveRemoteSession(workspace: RemoteWorkspace, sessionId: string): Promise<boolean> {
  const flushSelected = async () => {
    const selected = remoteSelection()
    if (selected?.workspaceId === workspace.id && selected.sessionId === sessionId) await remotePresentation()?.beforeLeave?.()
  }
  await flushSelected()
  try { await mutateRemoteSession(workspace, sessionId, 'archive') }
  catch (error) {
    if (!(error instanceof RemoteRequestError) || error.errorCode !== 'workspace/session-active') throw error
    if (!window.confirm(tt('remote.stopAndArchiveConfirm'))) return false
    await flushSelected() // Input may have changed while the refused request was in flight.
    // The first call was explicitly refused. This is a newly confirmed stop,
    // never a retry of an uncertain operation or lost acknowledgement.
    await mutateRemoteSession(workspace, sessionId, 'archive', undefined, true)
  }
  return true
}
const pending = new Set<string>()
/** One explicit write per Session, including across row/menu remounts. */
export async function mutateRemoteSession(workspace: RemoteWorkspace, sessionId: string, action: RemoteSessionAction, title?: string, stopActivity = false): Promise<void> {
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
    if (!response.ok || value?.ok !== true) throw new RemoteRequestError(tt('remote.actionUnconfirmed'), typeof value?.errorCode === 'string' ? value.errorCode : undefined)
    if (!owns()) throw new Error(tt('remote.desktopIdentityChanged'))
  } finally {
    // A lost acknowledgement still triggers a read, never a repeated write.
    try {
      remoteNavigation.invalidate(workspace)
      if (owns()) await remoteNavigation.refresh(workspace)
    } finally { pending.delete(key) }
  }
}
