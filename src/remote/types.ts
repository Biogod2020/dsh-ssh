/** Public remote-host state. Launch tokens and upstream cookies never belong here. */
export type RemotePhase = 'checking' | 'installing-node' | 'installing-dsh' | 'starting' | 'connecting' | 'ready' | 'failed' | 'disconnected'
export interface RemoteWorkspace {
  id: string
  hostId: string
  alias: string
  remotePath: string
  title: string
  workspaceId: string
}
/** Navigation metadata only. Session contents and execution stay on their Host. */
export interface RemoteSession {
  sessionId: string
  title: string
  running: boolean
  blank: boolean
  updatedAt: number
}
export interface RemoteSessionCatalog {
  workspaceId: string
  sessions: RemoteSession[]
  checkedAt?: number
  stale: boolean
  warning?: string
}
export interface RemoteOperation {
  id: string
  alias: string
  hostId?: string
  remotePath?: string
  createdAt?: number
  updatedAt?: number
  lastPhase?: RemotePhase
  dismissed?: boolean
  errorCode?: string
  phase: RemotePhase
  message: string
  workspace?: RemoteWorkspace
}
export interface RemoteReceipt {
  protocol: 1
  pid: number
  port: number
  url: string
  root: string
  directory: string
  userHome: string
  version: string
}
/** Reviewed pins, never npm dist-tags. Existing compatible services keep running. */
export const REMOTE_DSH_VERSION = '0.2.1-alpha.4'
export const REMOTE_DSH_INTEGRITY = 'nnJP3UyD0ldlAxH0BXhBUBYE3vI7w0DECncqzAl1EotHphE5l2ggwenoaxXiISJgDTHc5BV9JWI6YU5PSI9Ifg=='
export const REMOTE_DSH_VERSIONS = ['0.1.6-alpha.2', '0.1.7-alpha.1', '0.2.0-rc.2', REMOTE_DSH_VERSION, '0.2.1-rc.2'] as const
export function compatibleRemoteVersion(version: unknown): version is string {
  return typeof version === 'string' && (REMOTE_DSH_VERSIONS as readonly string[]).includes(version)
}
