import type { SshHostSummary } from '../protocol.ts'

const KEY = 'dsh-ssh:workspace-hosts:v1'
const LIMIT = 8
type HistoryStorage = Pick<Storage, 'getItem' | 'setItem'>

/** Target identity, without authentication data; alias reuse must not inherit recency. */
export function hostHistoryId(host: SshHostSummary): string {
  return JSON.stringify([host.alias, host.host, host.port, host.user, host.createdAt])
}

/** Optional presentation history must never prevent a connection. */
export function readRecentHostIds(storage?: Pick<Storage, 'getItem'>): string[] {
  try {
    const raw = (storage ?? localStorage).getItem(KEY)
    if (!raw || raw.length > 16384) return []
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) && value.length <= LIMIT && value.every(item => typeof item === 'string' && item.length <= 2048)
      ? [...new Set<string>(value)] : []
  } catch { return [] }
}

/** Call only after an explicitly requested workspace connection succeeds. */
export function rememberWorkspaceHost(host: SshHostSummary, storage?: HistoryStorage): void {
  try {
    const target = storage ?? localStorage
    const id = hostHistoryId(host)
    target.setItem(KEY, JSON.stringify([id, ...readRecentHostIds(target).filter(item => item !== id)].slice(0, LIMIT)))
  } catch { /* Browser storage is optional for this local preference. */ }
}
