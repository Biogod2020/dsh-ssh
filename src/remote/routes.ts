import type { IncomingMessage } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { isLoopbackRequest } from '../loopback.ts'
import { readJsonBody, writeJson } from '../http.ts'
import type { RemoteWorkspaces } from './manager.ts'
import { remoteErrorCode } from './errors.ts'

export function remoteRoutes(manager: RemoteWorkspaces, rejection: (req: IncomingMessage) => 401 | 403 | undefined): WebRoute[] {
  return [{ kind: 'prefix', path: '/api/dsh-ssh/remote', handler: async (req, res) => {
    const denied = rejection(req)
    if (denied || !isLoopbackRequest(req)) { writeJson(res, denied ?? 403, { error: 'Remote workspace access denied' }); return }
    const url = new URL(req.url ?? '/', 'http://localhost')
    try {
      if (req.method === 'GET' && url.pathname === '/api/dsh-ssh/remote/workspaces') {
        const hosts = await manager.status()
        writeJson(res, 200, { workspaces: manager.catalog(), hosts, operations: manager.activity(), history: manager.history(), warning: manager.activityWarning() }); return
      }
      if (req.method === 'GET' && url.pathname === '/api/dsh-ssh/remote/operation') {
        const operation = manager.operation(url.searchParams.get('id') ?? '')
        writeJson(res, operation ? 200 : 404, operation ? { operation } : { error: 'Unknown connection operation' }); return
      }
      if (req.method === 'GET' && url.pathname === '/api/dsh-ssh/remote/sessions') {
        writeJson(res, 200, await manager.sessions(url.searchParams.get('id') ?? '')); return
      }
      if (req.method === 'POST' && url.pathname === '/api/dsh-ssh/remote/session/create') {
        const body = await readJsonBody(req) as { id?: unknown }
        if (typeof body?.id !== 'string') throw new Error('workspace id is required')
        writeJson(res, 200, await manager.createSession(body.id)); return
      }
      if (req.method === 'POST' && url.pathname === '/api/dsh-ssh/remote/connect') {
        const body = await readJsonBody(req) as { alias?: unknown; remotePath?: unknown; expectedHostId?: unknown }
        if (typeof body?.alias !== 'string' || typeof body.remotePath !== 'string') throw new Error('alias and remotePath are required')
        if (body.expectedHostId !== undefined && (typeof body.expectedHostId !== 'string' || !/^[a-f0-9]{24}$/.test(body.expectedHostId))) throw new Error('Invalid reviewed host identity')
        writeJson(res, 202, { operation: manager.connect(body.alias, body.remotePath, body.expectedHostId as string | undefined) }); return
      }
      if (req.method === 'POST' && url.pathname === '/api/dsh-ssh/remote/recover') {
        const body = await readJsonBody(req) as { hostId?: unknown; proof?: unknown }
        if (typeof body?.hostId !== 'string' || typeof body.proof !== 'string') throw new Error('Remote recovery link is incomplete')
        writeJson(res, 202, { operation: manager.recover(body.hostId, body.proof) }); return
      }
      if (req.method === 'POST' && url.pathname === '/api/dsh-ssh/remote/open') {
        const body = await readJsonBody(req) as { id?: unknown; sessionId?: unknown }
        if (typeof body?.id !== 'string' || (body.sessionId !== undefined && typeof body.sessionId !== 'string')) throw new Error('workspace id or session identity is invalid')
        writeJson(res, 200, await manager.open(body.id, body.sessionId)); return
      }
      if (req.method === 'POST' && url.pathname === '/api/dsh-ssh/remote/dismiss') {
        const body = await readJsonBody(req) as { id?: unknown }
        if (typeof body?.id !== 'string') throw new Error('operation id is required')
        manager.dismiss(body.id); writeJson(res, 200, { ok: true }); return
      }
      writeJson(res, 404, { error: 'Unknown remote workspace route or method' })
    } catch (error) { writeJson(res, 400, { error: error instanceof Error ? error.message : 'Remote workspace operation failed', errorCode: remoteErrorCode(error) }) }
  } }]
}
