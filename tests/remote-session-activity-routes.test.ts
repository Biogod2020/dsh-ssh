import { createServer, type Server } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteFailureError } from '../src/remote/errors.ts'
import { remoteRoutes } from '../src/remote/routes.ts'

let server: Server | undefined
afterEach(async () => { await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); server = undefined })

async function fixture(error: Error) {
  const manager = { sessionAction: vi.fn(async () => { throw error }) }
  const route = remoteRoutes(manager as never, () => undefined)[0]!
  server = createServer((req, res) => { void route.handler(req, res) })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return {
    manager,
    response: () => fetch(`http://127.0.0.1:${(server!.address() as { port: number }).port}/api/dsh-ssh/remote/session/action`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'workspace', expectedHostId: 'a'.repeat(24), sessionId: 'session', action: 'archive' }),
    }),
  }
}

it('serializes only the validated activity summary for an active-session refusal', async () => {
  const f = await fixture(new RemoteFailureError('archive refused', 'workspace/session-active', [{ kind: 'vendor-work', items: [{ id: 'job', label: 'Visible job' }] }]))
  const response = await f.response(), body = await response.json()
  expect(response.status).toBe(400)
  expect(body).toEqual({ error: 'archive refused', errorCode: 'workspace/session-active', activity: [{ kind: 'vendor-work', items: [{ id: 'job', label: 'Visible job' }] }] })
  expect(f.manager.sessionAction).toHaveBeenCalledExactlyOnceWith('workspace', 'session', 'archive', undefined, false, 'a'.repeat(24))
})

it('does not serialize malformed activity', async () => {
  const f = await fixture(new RemoteFailureError('archive refused', 'workspace/session-active', [{ kind: 'job', items: [{ id: 'job', label: 'x'.repeat(1025) }] }] as any))
  const response = await f.response(), body = await response.json()
  expect(response.status).toBe(400)
  expect(body.activity).toBeUndefined()
  expect(JSON.stringify(body)).not.toContain('label')
})
