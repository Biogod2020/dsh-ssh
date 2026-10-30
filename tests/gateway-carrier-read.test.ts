import { afterEach, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { RemoteGateway, modelCatalogReadTimeoutMs } from '../src/remote/gateway.ts'
import { BootAssetCache } from '../src/remote/boot-assets.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import type { BootArtifact, BootRead } from '../src/remote/boot-reader.ts'

const gateways: RemoteGateway[] = [], servers: Server[] = []
afterEach(async () => { vi.useRealTimers(); gateways.splice(0).forEach(gateway => gateway.dispose()); await Promise.all(servers.splice(0).map(server => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())) })) })
async function upstream(handle: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer((req, res) => {
    if (req.url?.includes('?token=')) { res.writeHead(303, { 'set-cookie': 'upstream=generated; Path=/' }); res.end(); return }
    handle(req, res)
  }); servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}
async function gateway(port: number, cache?: BootAssetCache, read?: (input: BootRead) => Promise<BootArtifact>, preferred?: number) {
  const value = new RemoteGateway(port, { url: `http://127.0.0.1:${port}/?token=generated` } as any, 'generated', 'http://127.0.0.1:3080/', 'a'.repeat(24), 'b'.repeat(64), undefined, undefined, cache, read)
  gateways.push(value); await value.start(preferred); return value
}
async function auth(value: RemoteGateway) {
  const response = await fetch(value.launch(), { redirect: 'manual' }); await response.body?.cancel()
  return { Cookie: response.headers.getSetCookie().map(line => line.split(';')[0]).join('; '), Origin: value.origin }
}
it('retains only a matching, bounded activity summary from an initial archive refusal', async () => {
  const port = await upstream(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const request = JSON.parse(raw)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ rpcId: request.rpcId, result: { ok: false, error: {
      code: 'workspace/session-active', message: 'generated upstream refusal',
      details: { sessionId: request.payload.args.request.sessionId, activity: [{ kind: 'vendor-work', ignored: 'private', items: [{ id: 'job-1', label: 'Generated job', secret: 'private' }] }], private: 'must-not-cross' },
    } } }))
  }), value = await gateway(port)
  await value.rpc('workspace/archiveSession', { request: { sessionId: 'session-1' } }).then(
    () => expect.unreachable('archive refusal must reject'),
    error => {
      expect(error).toMatchObject({ errorCode: 'workspace/session-active', activity: [{ kind: 'vendor-work', items: [{ id: 'job-1', label: 'Generated job' }] }] })
      expect(error).not.toHaveProperty('details')
      expect(JSON.stringify(error)).not.toContain('private')
    },
  )
})
it('does not retain an activity summary for a mismatched or already-confirmed archive request', async () => {
  const port = await upstream(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const request = JSON.parse(raw)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ rpcId: request.rpcId, result: { ok: false, error: {
      code: 'workspace/session-active', message: 'generated upstream refusal',
      details: { sessionId: request.payload.args.request.stopActivity ? request.payload.args.request.sessionId : 'other-session', activity: [{ kind: 'job', items: [{ id: 'job-1' }] }] },
    } } }))
  }), value = await gateway(port)
  for (const request of [{ request: { sessionId: 'session-1' } }, { request: { sessionId: 'session-1', stopActivity: true } }]) {
    await value.rpc('workspace/archiveSession', request).then(
      () => expect.unreachable('archive refusal must reject'),
      error => expect(error).toMatchObject({ errorCode: 'workspace/session-active', activity: undefined }),
    )
  }
})
it('does not replace a working carrier because one health probe failed while ordinary traffic succeeded', async () => {
  let finishRoot!: () => void, sawRoot!: () => void
  const observed = new Promise<void>(resolve => { sawRoot = resolve })
  const port = await upstream(async (req, res) => {
    if (req.url === '/') { finishRoot = () => { res.writeHead(503); res.end() }; sawRoot(); return }
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ rpcId: body.rpcId, result: { ok: true, value: { items: [] } } }))
  }), value = await gateway(port), healthy = value.healthy()
  await observed; expect(await value.rpc('session/list', {})).toEqual({ items: [] })
  finishRoot(); expect(await healthy).toBe(true)
})
it('reuses a released browser origin and chooses another free port if an unrelated service owns it', async () => {
  const port = await upstream((_req, res) => res.end('generated service')), first = await gateway(port), saved = Number(new URL(first.origin).port)
  const closed = new Promise<void>(resolve => (first as any).server.once('close', resolve)); first.dispose(); await closed
  const second = await gateway(port, undefined, undefined, saved); expect(second.origin).toBe(first.origin)
  const collision = await gateway(port, undefined, undefined, saved); expect(collision.origin).not.toBe(second.origin)
  expect(await (await fetch(second.origin + '/', { headers: await auth(second) })).text()).toBe('generated service')
})
it('reuses a complete immutable bundle after the browser origin changes without skipping authentication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-gateway-code-')), cache = new BootAssetCache(join(root, 'cache'))
  try {
    let reads = 0
    const port = await upstream((_req, res) => { reads++; res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=31536000, immutable' }); res.end('/* complete generated bundle */') })
    const first = await gateway(port, cache), path = '/plugins/??@generated/plugin/client.js&rev=0123456789ab', one = { ...await auth(first), 'accept-encoding': 'identity' }
    expect(await (await fetch(first.origin + path, { headers: one })).text()).toBe('/* complete generated bundle */')
    await vi.waitFor(async () => expect(await cache.read(`${'a'.repeat(24)}:undefined:compact-images-1`, new URL(path, first.origin), 'identity')).toBeDefined())
    const second = await gateway(port, new BootAssetCache(join(root, 'cache'))), two = { ...await auth(second), 'accept-encoding': 'identity' }
    expect(await (await fetch(second.origin + path, { headers: two })).text()).toBe('/* complete generated bundle */')
    expect(reads).toBe(1)
    const refused = await fetch(second.origin + path); expect(refused.status).toBe(401); await refused.body?.cancel(); expect(reads).toBe(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
it('settles a stalled model-catalog read with a retriable error instead of waiting indefinitely or replaying it', async () => {
  let sawRead!: () => void, reads = 0
  const observed = new Promise<void>(resolve => { sawRead = resolve })
  const port = await upstream((_req, _res) => { reads++; sawRead() }), value = await gateway(port), headers = await auth(value)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const response = fetch(value.origin + '/api/session/modelCatalog', { method: 'POST', headers, body: '{}' })
  await observed; await vi.advanceTimersByTimeAsync(modelCatalogReadTimeoutMs)
  const failed = await response; expect(failed.status).toBe(504); expect(await failed.text()).toContain('Retry the model list'); expect(reads).toBe(1)
})
it('revalidates immutable code from private disk without using the remote carrier on a browser reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-gateway-revalidate-')), cache = new BootAssetCache(join(root, 'cache'))
  try {
    let reads = 0
    const port = await upstream((_req, res) => { reads++; res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=31536000, immutable', etag: '"generated-v1"' }); res.end('/* complete generated bundle */') })
    const value = await gateway(port, cache), headers = { ...await auth(value), 'accept-encoding': 'identity' }, path = '/assets/generated-0123456789ab.js'
    expect(await (await fetch(value.origin + path, { headers })).text()).toContain('complete generated')
    await vi.waitFor(async () => expect(await cache.read(`${'a'.repeat(24)}:undefined:compact-images-1`, new URL(path, value.origin), 'identity')).toBeDefined())
    for (const tag of ['"generated-v1"', 'W/"generated-v1"', '"other", W/"generated-v1"', '*']) {
      const response = await fetch(value.origin + path, { headers: { ...headers, 'cache-control': 'max-age=0', 'if-none-match': tag } })
      expect(response.status).toBe(304); expect(await response.text()).toBe(''); expect(response.headers.get('etag')).toBe('"generated-v1"')
    }
    for (const condition of [{ 'if-none-match': '"old-version"' }, { 'if-modified-since': new Date().toUTCString() }] as Record<string, string>[]) {
      const response = await fetch(value.origin + path, { headers: { ...headers, ...condition } })
      expect(response.status).toBe(200); expect(await response.text()).toContain('complete generated')
    }
    const denied = await fetch(value.origin + path, { headers: { 'if-none-match': '*' } }); expect(denied.status).toBe(401); await denied.body?.cancel()
    expect(reads).toBe(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
it('keeps compact exports on conditional cache misses and validates the transformed representation', async () => {
  const raw = Buffer.from('export const compact = true;'), etag = '"' + createHash('sha256').update(raw).digest('hex') + '"'
  let exports = 0, ordinary = 0
  const port = await upstream((_req, res) => { ordinary++; res.writeHead(412); res.end() }), value = await gateway(port, undefined, async () => {
    exports++; return { kind: 'code', body: gzipSync(raw).toString('base64'), sourceBytes: 6000000, rawBytes: raw.length, hash: etag.slice(1, -1), mime: 'text/javascript; charset=utf-8' }
  }), headers = { ...await auth(value), 'accept-encoding': 'gzip' }, path = '/plugins/??@deepseek-ai/dsh-client-ui-settings-account/client.js&rev=0123456789ab'
  const initial = await fetch(value.origin + path, { headers: { ...headers, 'if-none-match': '"old-native-illustrations"' } })
  expect(initial.status).toBe(200); expect(await initial.text()).toBe(raw.toString()); expect(initial.headers.get('etag')).toBe(etag)
  const unchanged = await fetch(value.origin + path, { headers: { ...headers, 'if-none-match': 'W/' + etag } })
  expect(unchanged.status).toBe(304); expect(await unchanged.text()).toBe(''); expect(exports).toBe(1); expect(ordinary).toBe(0)
  const precondition = await fetch(value.origin + path, { headers: { ...headers, 'if-match': '"old"' } })
  expect(precondition.status).toBe(412); await precondition.body?.cancel(); expect(exports).toBe(1); expect(ordinary).toBe(1)
})
it('serves compact code and exact deferred images through authenticated versioned reads', async () => {
  let ordinary = 0; const inputs: BootRead[] = [], raw = Buffer.from('export const compact = true;'), png = Buffer.from('generated-original-image')
  const hash = createHash('sha256').update(png).digest('hex'), path = '/plugins/??@deepseek-ai/dsh-client-ui-settings-account/client.js&rev=0123456789ab'
  const port = await upstream((_req, res) => { ordinary++; res.end('ordinary') }), value = await gateway(port, undefined, async input => {
    inputs.push(input); const body = input.image ? png : raw
    return { kind: input.image ? 'image' : 'code', body: (input.image ? body : gzipSync(body)).toString('base64'), sourceBytes: 6000000, rawBytes: body.length,
      hash: createHash('sha256').update(body).digest('hex'), mime: input.image ? 'image/png' : 'text/javascript; charset=utf-8' }
  }), headers = { ...await auth(value), 'accept-encoding': 'gzip' }
  const code = await fetch(value.origin + path, { headers }); expect(await code.text()).toBe(raw.toString()); expect(code.headers.get('content-encoding')).toBe('gzip')
  const image = await fetch(value.origin + `/__dsh_remote/boot-image/${hash}.png?source=${Buffer.from(path).toString('base64url')}`, { headers })
  expect(Buffer.from(await image.arrayBuffer())).toEqual(png); expect(image.headers.get('content-type')).toBe('image/png'); expect(inputs).toHaveLength(2); expect(ordinary).toBe(0)
  const denied = await fetch(value.origin + path); expect(denied.status).toBe(401); await denied.body?.cancel(); expect(inputs).toHaveLength(2)
})
it('does not redispatch a failed compact export and preserves ordinary native code as a compatibility fallback', async () => {
  let exports = 0, reads = 0
  const port = await upstream((_req, res) => { reads++; res.end('ordinary native code') }), value = await gateway(port, undefined, async () => { exports++; throw Error('Generated interrupted export') }), headers = await auth(value)
  const path = '/plugins/??@deepseek-ai/dsh-client-ui-settings-account/client.js&rev=0123456789ab'
  for (let n = 0; n < 2; n++) expect(await (await fetch(value.origin + path, { headers })).text()).toBe('ordinary native code')
  expect(exports).toBe(1); expect(reads).toBe(2)
})
it('bounds an incomplete model response but lets a long-running write finish normally', async () => {
  let sawModel!: () => void, sawWrite!: () => void, finishWrite!: () => void
  const modelSeen = new Promise<void>(r => { sawModel = r }), writeSeen = new Promise<void>(r => { sawWrite = r })
  const port = await upstream((req, res) => {
    if (req.url === '/api/session/modelCatalog') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"partial":'); sawModel() }
    else { finishWrite = () => res.end('write finished once'); sawWrite() }
  }), value = await gateway(port), headers = await auth(value)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const model = fetch(value.origin + '/api/session/modelCatalog', { method: 'POST', headers, body: '{}' })
  const write = fetch(value.origin + '/api/session/prompt', { method: 'POST', headers, body: '{}' })
  let writeSettled = false; void write.then(() => { writeSettled = true })
  await Promise.all([modelSeen, writeSeen]); const modelBody = expect((await model).text()).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(modelCatalogReadTimeoutMs); await modelBody
  expect(writeSettled).toBe(false); finishWrite(); expect(await (await write).text()).toBe('write finished once')
})
it('accepts native batched assets with accumulated loopback cookies while retaining authentication and a header bound', async () => {
  let reads = 0
  const port = await upstream((_req, res) => { reads++; res.setHeader('content-type', 'text/javascript'); res.end('/* generated batch */') })
  const value = await gateway(port), headers = await auth(value)
  const path = '/plugins/??' + Array.from({ length: 58 }, (_, n) => `@generated/plugin-${n}/client.js`).join(',') + '&rev=0123456789ab'
  const cookie = headers.Cookie + '; dsh-auth-generated-old-port=' + 'a'.repeat(15 * 1024)
  const asset = await fetch(value.origin + path, { headers: { ...headers, Cookie: cookie } })
  expect(asset.status).toBe(200); expect(await asset.text()).toBe('/* generated batch */'); expect(reads).toBe(1)
  const unauthenticated = await fetch(value.origin + path, { headers: { Cookie: 'unrelated=' + 'a'.repeat(15 * 1024) } })
  expect(unauthenticated.status).toBe(401); await unauthenticated.body?.cancel(); expect(reads).toBe(1)
  const excessive = await fetch(value.origin + '/', { headers: { Cookie: headers.Cookie + '; oversized=' + 'a'.repeat(66 * 1024) } })
  expect(excessive.status).toBe(431); await excessive.body?.cancel(); expect(reads).toBe(1)
})
it('continues a hashed boot asset once on the replacement carrier before sending any response bytes', async () => {
  let oldRequest!: IncomingMessage, sawAsset!: () => void, first = 0, second = 0
  const observed = new Promise<void>(resolve => { sawAsset = resolve })
  const oldPort = await upstream((req, _res) => { first++; oldRequest = req; sawAsset() })
  const nextPort = await upstream((_req, res) => { second++; res.setHeader('content-type', 'text/javascript'); res.end('export const generated = true;') })
  const value = await gateway(oldPort), headers = await auth(value)
  const asset = fetch(value.origin + '/assets/vendor-abcdefgh.js', { headers }).then(async response => ({ status: response.status, text: await response.text() }))
  await observed; await value.replaceTunnel(nextPort); oldRequest.socket.destroy()
  expect(await asset).toEqual({ status: 200, text: 'export const generated = true;' })
  expect(first).toBe(1); expect(second).toBe(1)
})
it('never replays an API write when its acknowledgement is lost during carrier replacement', async () => {
  let oldRequest!: IncomingMessage, sawWrite!: () => void, writes = 0, replacementWrites = 0
  const observed = new Promise<void>(resolve => { sawWrite = resolve })
  const oldPort = await upstream((req, _res) => { writes++; oldRequest = req; sawWrite() })
  const nextPort = await upstream((_req, res) => { replacementWrites++; res.end('{}') })
  const value = await gateway(oldPort), headers = await auth(value)
  const write = fetch(value.origin + '/api/session/prompt', { method: 'POST', headers, body: '{}' })
  await observed; await value.replaceTunnel(nextPort); oldRequest.socket.destroy()
  const response = await write; expect(response.status).toBe(502); await response.body?.cancel()
  expect(writes).toBe(1); expect(replacementWrites).toBe(0)
})
it('fails a partially delivered asset without appending an error body or replaying it', async () => {
  let oldResponse!: ServerResponse, sawAsset!: () => void, replacementReads = 0
  const observed = new Promise<void>(resolve => { sawAsset = resolve })
  const oldPort = await upstream((_req, res) => { oldResponse = res; res.setHeader('content-type', 'text/javascript'); res.write('export const partial = '); sawAsset() })
  const nextPort = await upstream((_req, res) => { replacementReads++; res.end('new body') })
  const value = await gateway(oldPort), headers = await auth(value)
  const response = fetch(value.origin + '/assets/vendor-abcdefgh.js', { headers })
  await observed; const partial = await response; const body = expect(partial.text()).rejects.toThrow()
  await value.replaceTunnel(nextPort); oldResponse.destroy(); await body
  expect(replacementReads).toBe(0)
})
