import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { makeRoutes, type SshRoutesDeps } from '../src/routes.ts'

describe('SSH routes require official authentication', () => {
  for (const rejection of [undefined, () => 401 as const, () => 403 as const]) {
    it(`fails closed for HTTP and terminal (${rejection ? rejection() : 'missing auth'})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ssh-route-auth-'))
      const { routes, upgrade } = makeRoutes({ store: {} as never, engine: {} as never,
        stagingDir: dir, requestRejection: rejection } satisfies SshRoutesDeps)
      const server = createServer((req, res) => {
        const route = routes.find(route => route.path === req.url)
        if (route) void route.handler(req, res)
        else { res.statusCode = 404; res.end() }
      })
      server.on('upgrade', (req, socket, head) => { void upgrade.handler(req, socket, head) })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address() as { port: number }
      const origin = `http://127.0.0.1:${address.port}`
      try {
        for (const route of routes) {
          const response = await fetch(origin + route.path)
          expect(response.status).toBe(rejection ? rejection() : 401)
          await response.text()
        }
        const status = await new Promise<number | undefined>((resolve, reject) => {
          const ws = new WebSocket(origin.replace('http:', 'ws:') + upgrade.path)
          ws.on('error', error => { if (!String(error).includes('closed before')) reject(error) })
          ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode) })
          ws.once('open', () => { ws.close(); reject(new Error('unexpected authorization')) })
        })
        expect(status).toBe(rejection ? rejection() : 401)
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})
