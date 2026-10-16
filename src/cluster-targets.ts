/** The GUI and engine use identical intersection / ALL-tag semantics. */
import type { ClusterRequest, ClusterTarget } from './protocol.ts'

export function selectClusterTargets<T extends { alias: string; environment?: string; tags: string[] }>(
  hosts: T[], filters: Pick<ClusterRequest, 'aliases' | 'environment' | 'tags'>,
): T[] {
  return hosts.filter(host => (!filters.aliases?.length || filters.aliases.includes(host.alias))
    && (!filters.environment || host.environment === filters.environment)
    && (!filters.tags?.length || filters.tags.every(tag => host.tags.includes(tag))))
}

export function sameClusterTargets(actual: ClusterTarget[], expected: ClusterRequest['expectedTargets']): boolean {
  if (!expected) return true
  return actual.length === expected.length && new Set(expected.map(host => host.alias)).size === expected.length
    && actual.every(host => expected.some(row => row.alias === host.alias && row.updatedAt === host.updatedAt))
}
