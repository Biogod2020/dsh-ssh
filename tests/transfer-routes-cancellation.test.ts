import { createServer, request } from 'node:http'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { makeRoutes } from '../src/routes.ts'
import { HostStore } from '../src/store.ts'
import type { SshEngine } from '../src/engine.ts'

it.each(['upload', 'download'] as const)('closes only the dispatched %s operation after response loss and releases staging', async kind => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-transfer-route-')), staging = join(root, 'staging')
  let signal: AbortSignal | undefined, calls = 0
  const wait = (abort: AbortSignal) => new Promise<never>((_resolve, reject) => {
    signal = abort; calls++
    abort.addEventListener('abort', () => reject(new Error('transfer cancelled')))
  })
  const engine = {
    upload: (...args: Parameters<SshEngine['upload']>) => wait(args[5]!),
    downloadStream: (...args: Parameters<SshEngine['downloadStream']>) => {
      args[3](10000); args[2].write('first bytes'); return wait(args[4]!)
    },
  } as unknown as SshEngine
  const { routes } = makeRoutes({ store: new HostStore(join(root, 'hosts.json')), engine, stagingDir: staging, requestRejection: () => undefined })
  const server = createServer((req, res) => {
    void routes.find(route => route.path === req.url?.split('?')[0])!.handler(req, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  try {
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: address.port, path: `/api/dsh-ssh/${kind}?alias=fixture&remotePath=/remote/a`, method: kind === 'upload' ? 'POST' : 'GET' }, res => {
        res.on('error', () => {})
        res.once('data', () => { res.destroy(); resolve() })
      })
      req.on('error', reject); req.end(kind === 'upload' ? 'payload' : undefined)
    })
    await vi.waitFor(() => expect(signal?.aborted).toBe(true))
    await vi.waitFor(() => expect(readdirSync(staging)).toEqual([]))
    expect(calls).toBe(1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
})
