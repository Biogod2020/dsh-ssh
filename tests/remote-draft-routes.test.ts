import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteGateway } from '../src/remote/gateway.ts'
import { LocalDraftStore } from '../src/remote/draft-store.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function fixture(html = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-draft-route-')), drafts = new LocalDraftStore(join(root, 'drafts'))
  let forwarded = 0
  const remote = createServer((req, res) => {
    if (req.url?.startsWith('/?token=')) { res.writeHead(303, { 'Set-Cookie': 'fixture=only' }); res.end(); return }
    ++forwarded
    if (html && req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head></head><body><div id="root"></div></body></html>'); return }
    res.writeHead(503); res.end()
  })
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve))
  const port = (remote.address() as { port: number }).port, gateways: RemoteGateway[] = []
  const create = async (hostId: string) => {
    const gateway = new RemoteGateway(port, { protocol: 1, pid: process.pid, port, url: `http://127.0.0.1:${port}/?token=fixture-only`,
      root, directory: root, userHome: root, version: '0.2.1-rc.2' }, 'fixture', 'http://127.0.0.1:1/', hostId, 'fixture', drafts)
    gateways.push(gateway); await gateway.start()
    const auth = await fetch(gateway.launch('same'), { redirect: 'manual' })
    const headers = { Cookie: auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), Origin: gateway.origin, 'content-type': 'application/json' }
    const url = gateway.origin + '/__dsh_remote/draft?sessionId=same'
    return { gateway, headers, url, read: () => fetch(url, { headers }),
      write: (text: string, revision: string | null, operationId = randomUUID()) => fetch(url, { method: 'PUT', headers,
        body: JSON.stringify({ text, expectedRevision: revision, operationId, hadReferences: false, hadAttachments: false, hostId: 'untrusted-body-host' }) }) }
  }
  cleanup.push(async () => {
    for (const gateway of gateways) gateway.dispose()
    remote.closeAllConnections(); await new Promise<void>(resolve => remote.close(() => resolve()))
    await drafts.close(); await rm(root, { recursive: true, force: true })
  })
  return { create, drafts, forwarded: () => forwarded }
}
it('authenticates local draft access and binds identical session ids to the gateway Host', async () => {
  const f = await fixture(), a = await f.create('a'.repeat(24)), b = await f.create('b'.repeat(24))
  expect((await fetch(a.url)).status).toBe(401)
  expect((await fetch(a.url, { headers: { ...a.headers, Origin: 'https://untrusted.invalid' } })).status).toBe(401)
  const response = await a.write('Generated private draft', null)
  expect(response.status).toBe(200)
  const { draft } = await response.json()
  expect(draft.hostId).toBe('a'.repeat(24))
  expect((await (await b.read()).json()).draft).toBeUndefined()
  // Both gateways are live, so this is guaranteed to be a different origin.
  const next = await f.create('a'.repeat(24))
  expect(next.gateway.origin).not.toBe(a.gateway.origin)
  expect((await (await next.read()).json()).draft).toEqual(draft)
  expect(f.forwarded()).toBe(0)
})
it('returns a conflict for a late pre-clear write and keeps local failures out of the remote API', async () => {
  const f = await fixture(), a = await f.create('a'.repeat(24)), operationId = randomUUID()
  const original = (await (await a.write('old', null, operationId)).json()).draft
  const cleared = (await (await a.write('', original.revision)).json()).draft
  expect((await a.write('old', null, operationId)).status).toBe(409)
  expect((await (await a.read()).json()).draft).toEqual(cleared)
  vi.spyOn(f.drafts, 'write').mockRejectedValueOnce(new Error('/private/fixture/path must not appear'))
  const failure = await a.write('new unsaved input', cleared.revision)
  expect(failure.status).toBe(507)
  const body = await failure.json()
  expect(body.code).toBe('draft/storage-unavailable')
  expect(JSON.stringify(body)).not.toContain('/private/fixture')
  expect((await (await a.read()).json()).draft).toEqual(cleared)
  expect(f.forwarded()).toBe(0)
})
it('restores the initial draft before native boot and safely handles concurrent root requests', async () => {
  const f = await fixture(true), a = await f.create('a'.repeat(24))
  await a.write('Restore before native boot', null)
  const responses = await Promise.all([fetch(a.gateway.origin, { headers: a.headers }), fetch(a.gateway.origin, { headers: a.headers })])
  expect(responses.map(response => response.status)).toEqual([200, 200])
  const bodies = await Promise.all(responses.map(response => response.text()))
  expect(bodies.some(body => body.includes('Restore before native boot'))).toBe(true)
  for (const body of bodies) {
    if (body.includes('Restore before native boot')) expect(body.indexOf('Restore before native boot')).toBeLessThan(body.indexOf('</head>'))
  }
})
