/** Browser-safe metadata only. Model configuration and credential values stay on Hosts. */
export type ModelFollowMode = 'follow' | 'independent'
export type ModelFollowStatus = 'pending' | 'syncing' | 'synced' | 'independent' | 'blocked' | 'uncertain'
export interface ModelFollowRow {
  id: string; provider: string; label: string; mode: ModelFollowMode; status: ModelFollowStatus
  reason?: string; modelCount?: number; updatedAt?: number
}
export interface ModelFollowView {
  alias: string; mode: ModelFollowMode; connected: boolean
  state: 'idle' | 'syncing' | 'ready' | 'unsupported' | 'restart-required' | 'uncertain'
  rows: ModelFollowRow[]; default?: { mode: ModelFollowMode; status: ModelFollowStatus }
  checkedAt?: number
}
export interface ModelFollowPolicyChange {
  mode?: ModelFollowMode
  provider?: string
  providerMode?: ModelFollowMode
}
export interface ModelBridgeView {
  protocol: 1; build?: string; providers: ModelFollowRow[]
  default: { mode: ModelFollowMode; status: ModelFollowStatus }
  lastRequest?: { id: string; status: string }
}
