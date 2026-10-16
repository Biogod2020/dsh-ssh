/** Concurrent cluster execution with frozen scope, bounded output and no replay. */
import type { ClusterEvent, ClusterRequest, ClusterResult, ClusterTarget } from '../protocol.ts'
import { sameClusterTargets, selectClusterTargets } from '../cluster-targets.ts'
import { execCommand, type ExecFlow, type PoolEngine } from './connection-pool.ts'

export interface ClusterOptions extends ClusterRequest {
  signal?: AbortSignal
  onEvent?: (event: ClusterEvent, flow?: ExecFlow) => void
}

export async function cluster(engine: PoolEngine, options: ClusterOptions): Promise<ClusterResult[]> {
  options.signal?.throwIfAborted()
  const aliases = options.aliases?.map(alias => alias.trim()).filter(Boolean)
  const environment = options.environment?.trim()
  const tags = options.tags?.map(tag => tag.trim()).filter(Boolean)
  if (!aliases?.length && !environment && !tags?.length) throw new Error('ssh_cluster requires aliases, environment, or tags to limit the target set')
  if (options.maxWorkers !== undefined && (!Number.isInteger(options.maxWorkers) || options.maxWorkers < 1)) throw new Error('maxWorkers must be a positive integer')
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error('timeoutMs must be positive')
  const hosts = engine.store.list()
  const missing = aliases?.filter(alias => !hosts.some(host => host.alias === alias)) ?? []
  if (missing.length) throw new Error('Unconfigured host aliases: ' + missing.join(', ') + '; no command was dispatched')
  // HostStore caches mutable entries; queued hosts must retain the reviewed
  // version even if another panel edits that entry while the run is active.
  const targets = selectClusterTargets(hosts, { aliases, environment, tags }).map(entry => ({ ...entry }))
  const plan: ClusterTarget[] = targets.map(({ alias, host, port, user, updatedAt }) => ({ alias, host, port, user, updatedAt }))
  if (!sameClusterTargets(plan, options.expectedTargets)) throw new Error('Target list or host configuration changed. Review the targets again; no command was dispatched')
  const emit = (event: ClusterEvent, flow?: ExecFlow): void => { try { options.onEvent?.(event, flow) } catch { /* observation never replays the run */ } }
  emit({ type: 'plan', targets: plan })
  const results = new Map<string, ClusterResult>(), queue = [...targets]
  const result = (value: ClusterResult): void => { results.set(value.alias, value); emit({ type: 'result', result: value }) }
  const run = async (): Promise<void> => {
    while (queue.length && !options.signal?.aborted) {
      const entry = queue.shift()!
      let dispatched = false
      emit({ type: 'state', alias: entry.alias, state: 'connecting' })
      try {
        const value = await execCommand(engine, entry.alias, options.command, options.timeoutMs, options.signal, (event, flow) => {
          if (event.type === 'dispatch') {
            dispatched = true; emit({ type: 'state', alias: entry.alias, state: 'running' })
          } else emit({ ...event, alias: entry.alias }, flow)
        }, entry.updatedAt)
        result({ alias: entry.alias, ok: value.success, exitCode: value.exitCode, timedOut: value.timedOut,
          stdout: value.stdout, stderr: value.stderr, durationMs: value.durationMs, dispatched,
          ...(value.cancelled ? { cancelled: true } : {}), ...(value.error ? { error: value.error } : {}) })
      } catch (error) {
        result({ alias: entry.alias, ok: false, dispatched, ...(options.signal?.aborted ? { cancelled: true } : {}),
          error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  const workers = Math.min(engine.opts.defaultMaxWorkers, options.maxWorkers ?? engine.opts.defaultMaxWorkers, targets.length)
  await Promise.all(Array.from({ length: workers }, () => run()))
  for (const entry of queue) result({ alias: entry.alias, ok: false, dispatched: false, cancelled: true,
    error: 'Cancelled before dispatch; command was not run on this host' })
  return targets.map(entry => results.get(entry.alias)!)
}
