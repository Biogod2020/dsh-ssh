import { afterEach, expect, it, vi } from 'vitest'
import { ClusterNotStartedError, SshApi } from '../src/client/api.ts'
import type { ClusterStreamFrame } from '../src/protocol.ts'

afterEach(() => vi.unstubAllGlobals())
const target = { alias: 'a', host: '127.0.0.1', port: 22, user: 'me', updatedAt: 1 }
const plan = { type: 'plan', targets: [target], runId: 'fixture-run' }
const result = { type: 'result', result: { alias: 'a', ok: true, exitCode: 0 } }
const complete = { type: 'complete', cancelled: false }
function response(frames: unknown[], split = false) {
  const bytes = new TextEncoder().encode(frames.map(frame => JSON.stringify(frame)).join('\n'))
  return new Response(new ReadableStream({ start(stream) {
    if (split) for (let index = 0; index < bytes.length; index += 3) stream.enqueue(bytes.slice(index, index + 3))
    else stream.enqueue(bytes)
    stream.close()
  } }))
}

it('reads fragmented UTF-8 NDJSON, preserves output and requires explicit completion', async () => {
  const fetch = vi.fn(async () => response([plan, { type: 'output', alias: 'a', stream: 'stdout', data: '你好😊' }, result, complete], true))
  vi.stubGlobal('fetch', fetch)
  const events: ClusterStreamFrame[] = []
  const results = await new SshApi().clusterStream({ command: 'read', aliases: ['a'], expectedTargets: [target] }, value => events.push(value))
  expect(results[0]?.stdout).toBe('你好😊'); expect(events.at(-1)?.type).toBe('complete')
  expect(fetch).toHaveBeenCalledOnce()
})

it.each([{ frames: [plan, result] }, { frames: [plan, complete] }, { frames: [plan, { type: 'output', alias: 'other', stream: 'stdout', data: 'x' }] }])('rejects unfinished or unexpected host streams without replay', async ({ frames }) => {
  const fetch = vi.fn(async () => response(frames)); vi.stubGlobal('fetch', fetch)
  await expect(new SshApi().clusterStream({ command: 'write', aliases: ['a'] }, () => {})).rejects.toThrow(/unknown|without every host/)
  expect(fetch).toHaveBeenCalledOnce()
})

it('bounds browser output, keeps one truncation marker and ignores result-body duplication', async () => {
  const outputs = Array.from({ length: 12 }, () => ({ type: 'output', alias: 'a', stream: 'stdout', data: 'x'.repeat(16384) }))
  vi.stubGlobal('fetch', vi.fn(async () => response([plan, ...outputs, { ...result, result: { ...result.result, stdout: 'replacement' } }, complete])))
  const events: string[] = []
  const results = await new SshApi().clusterStream({ command: 'read', aliases: ['a'] }, frame => { if (frame.type === 'output') events.push(frame.data) })
  expect(results[0]?.stdout).toBe('x'.repeat(128 * 1024) + '\n…[browser output truncated]')
  expect(events.join('')).toBe(results[0]?.stdout)
})

it('refuses unexpected reviewed identities and distinguishes pre-dispatch HTTP rejection', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response([plan, result, complete])))
  await expect(new SshApi().clusterStream({ command: 'write', aliases: ['a'], expectedTargets: [{ alias: 'a', updatedAt: 2 }] }, () => {})).rejects.toThrow('target scope')
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"Target configuration changed; no command was dispatched"}', { status: 400 })))
  await expect(new SshApi().clusterStream({ command: 'write', aliases: ['a'] }, () => {})).rejects.toBeInstanceOf(ClusterNotStartedError)
})

it('does not fetch after pre-abort and sends Stop only to the explicit run id', async () => {
  const fetch = vi.fn(async (_path: string, _options: RequestInit) => new Response('{"accepted":true}')); vi.stubGlobal('fetch', fetch)
  const controller = new AbortController(); controller.abort()
  await expect(new SshApi().clusterStream({ command: 'write' }, () => {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(fetch).not.toHaveBeenCalled()
  await new SshApi().cancelCluster('explicit-id')
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ runId: 'explicit-id' })
})
