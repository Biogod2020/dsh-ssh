/** Public package facts only. Configuration, paths and credentials never cross this seam. */
export interface ServerPluginPackage {
  name: string
  version?: string
  enabled: boolean
  official: boolean
}
export type PluginSyncBlock = 'builtin' | 'development' | 'unpublished' | 'incompatible' | 'registry-unavailable' | 'remote-only' | 'missing-version' | 'local-disabled'
export interface ServerPluginRow {
  name: string
  local?: ServerPluginPackage
  remote?: ServerPluginPackage
  status: 'missing' | 'same' | 'different' | 'remote-only'
  block?: PluginSyncBlock
  requirement?: string
  spec?: string
}
export interface ServerPluginComparison {
  planId: string
  alias: string
  hostId: string
  hostUpdatedAt: number
  dshVersion: string
  checkedAt: number
  expiresAt: number
  rows: ServerPluginRow[]
}
export interface PluginSyncItem {
  name: string
  version: string
  state: 'waiting' | 'installing' | 'installed' | 'restart-required' | 'failed' | 'uncertain' | 'skipped'
  errorCode?: string
}
export interface PluginSyncJob {
  id: string
  alias: string
  hostId: string
  state: 'running' | 'complete' | 'failed' | 'uncertain'
  items: PluginSyncItem[]
  createdAt: number
  message?: string
}
