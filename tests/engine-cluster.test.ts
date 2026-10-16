/**
 * Cluster module unit test: filters, concurrency and per-host error
 * capture, with the execCommand dependency mocked so no SSH server is
 * needed.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import type { PoolEngine } from '../src/engine/connection-pool.ts'
import { DEFAULTS } from '../src/engine/connection-pool.ts'
import { cluster } from '../src/engine/cluster.ts'
import { execCommand } from '../src/engine/connection-pool.ts'
import type { HostStore } from '../src/store.ts'

vi.mock('../src/engine/connection-pool.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine/connection-pool.ts')>()
  return {
    ...actual,
    execCommand: vi.fn(),
  }
})

const execCommandMock = execCommand as unknown as Mock

function fakeEngine(entries: unknown[]): PoolEngine {
  return {
    store: { list: () => entries } as unknown as HostStore,
    opts: { ...DEFAULTS },
    pool: new Map() as never,
    acquireQueue: new Map() as never,
  }
}

describe('cluster', () => {
  beforeEach(() => {
    execCommandMock.mockReset()
    execCommandMock.mockResolvedValue({ success: true, exitCode: 0, timedOut: false, stdout: 'ok', stderr: '', durationMs: 1 })
  })

  it('filters by aliases, environment and ALL tags', async () => {
    const entries = [
      { alias: 'a', environment: 'prod', tags: ['web'] },
      { alias: 'b', environment: 'staging', tags: ['web', 'staging'] },
      { alias: 'c', environment: 'prod', tags: ['db'] },
    ]
    const engine = fakeEngine(entries)
    const byAlias = await cluster(engine, { command: 'true', aliases: ['a', 'b'] })
    expect(byAlias.map(r => r.alias).sort()).toEqual(['a', 'b'])
    const byEnv = await cluster(engine, { command: 'true', aliases: ['a', 'b', 'c'], environment: 'prod' })
    expect(byEnv.map(r => r.alias).sort()).toEqual(['a', 'c'])
    const byTags = await cluster(engine, { command: 'true', aliases: ['a', 'b', 'c'], tags: ['web', 'staging'] })
    expect(byTags.map(r => r.alias)).toEqual(['b'])
  })

  it('rejects cluster execution when no selectors are provided', async () => {
    const engine = fakeEngine([{ alias: 'x', tags: [] }])
    await expect(cluster(engine, { command: 'true' })).rejects.toThrow(/ssh_cluster requires aliases, environment, or tags/)
    await expect(cluster(engine, { command: 'true', aliases: [] })).rejects.toThrow(/ssh_cluster requires aliases, environment, or tags/)
    await expect(cluster(engine, { command: 'true', aliases: ['  '], environment: '   ', tags: [] })).rejects.toThrow(/ssh_cluster requires aliases, environment, or tags/)
  })

  it('runs once per matched host and rejects invalid maxWorkers', async () => {
    const engine = fakeEngine([{ alias: 'x', tags: [] }])
    const results = await cluster(engine, { command: 'true', aliases: ['x'] })
    expect(results).toHaveLength(1)
    expect(execCommandMock).toHaveBeenCalledTimes(1)
    await expect(cluster(engine, { command: 'true', aliases: ['x'], maxWorkers: 0 })).rejects.toThrow(/maxWorkers/)
    await expect(cluster(engine, { command: 'true', aliases: ['x'], maxWorkers: -1 })).rejects.toThrow(/maxWorkers/)
  })

  it('captures per-host failures as failed results', async () => {
    execCommandMock.mockRejectedValue(new Error('boom'))
    const engine = fakeEngine([{ alias: 'x', tags: [] }, { alias: 'y', tags: [] }])
    const results = await cluster(engine, { command: 'true', aliases: ['x', 'y'] })
    expect(results).toHaveLength(2)
    for (const result of results) {
      expect(result.ok).toBe(false)
      expect(result.error).toBe('boom')
    }
  })

  it('rejects mixed unconfigured aliases and stale reviewed targets before any dispatch', async () => {
    const engine = fakeEngine([{ alias: 'a', host: '127.0.0.1', user: 'me', port: 22, updatedAt: 2, tags: [] }])
    await expect(cluster(engine, { command: 'write', aliases: ['a', 'missing'] })).rejects.toThrow('Unconfigured')
    await expect(cluster(engine, { command: 'write', aliases: ['a'], expectedTargets: [{ alias: 'a', updatedAt: 1 }] })).rejects.toThrow('changed')
    expect(execCommandMock).not.toHaveBeenCalled()
  })

  it('streams public plan, dispatch and output before the final per-host result', async () => {
    const onEvent = vi.fn()
    execCommandMock.mockImplementationOnce(async (_engine, _alias, _command, _timeout, _signal, observe) => {
      observe({ type: 'dispatch' }); observe({ type: 'output', stream: 'stdout', data: 'live' })
      expect(onEvent.mock.calls.some(([event]) => event.type === 'result')).toBe(false)
      return { success: true, exitCode: 0, timedOut: false, stdout: 'live', stderr: '', durationMs: 1 }
    })
    const engine = fakeEngine([{ alias: 'a', host: '127.0.0.1', user: 'me', port: 22, updatedAt: 2, tags: [], auth: { password: 'private-test-value' } }])
    const results = await cluster(engine, { command: 'read', aliases: ['a'], onEvent })
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual(['plan', 'state', 'state', 'output', 'result'])
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain('private-test-value')
    expect(results[0]).toMatchObject({ dispatched: true, stdout: 'live' })
  })

  it('stops queued hosts when cancelled and keeps completed host results', async () => {
    const controller = new AbortController()
    execCommandMock.mockImplementationOnce(async () => {
      controller.abort()
      return { success: false, exitCode: null, timedOut: false, stdout: 'partial', stderr: '', durationMs: 1, error: 'cancelled' }
    })
    const result = await cluster(fakeEngine([{ alias: 'a', tags: [] }, { alias: 'b', tags: [] }]), {
      command: 'true', aliases: ['a', 'b'], maxWorkers: 1, signal: controller.signal,
    })
    expect(execCommandMock).toHaveBeenCalledTimes(1)
    expect(result[0]).toMatchObject({ alias: 'a', stdout: 'partial' })
    expect(result[1]).toMatchObject({ alias: 'b', ok: false, error: expect.stringContaining('before dispatch') })
  })
})
