import type { IncomingMessage } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { isLoopbackRequest } from '../loopback.ts'
import { readJsonBody, writeJson } from '../http.ts'
import type { RemoteWorkspaces } from './manager.ts'
import { remoteErrorActivity, remoteErrorCode } from './errors.ts'
import type { ServerPlugins } from './plugins.ts'
import type { ServerModels } from './models.ts'
import type { ModelFollowPolicyChange } from './model-types.ts'
import { CatalogReadError } from './catalog-json.ts'

export function remoteRoutes(manager: RemoteWorkspaces, rejection: (req: IncomingMessage) => 401 | 403 | undefined, plugins?: ServerPlugins, models?: ServerModels): WebRoute[] {
  return [{ kind: 'prefix', path: '/api/dsh-ssh/remote', handler: async (req, res) => {
    const denied = rejection(req)
    if (denied || !isLoopbackRequest(req)) { writeJson(res, denied ?? 403, { error: 'Remote workspace access denied' }); return }
    const url = new URL(req.url ?? '/', 'http://localhost')
    try {
      if (url.pathname.startsWith('/api/dsh-ssh/remote/models')) {
        res.setHeader('Cache-Control', 'no-store')
        if (!models) { writeJson(res, 503, { error: 'Server model management is unavailable' }); return }
        if (req.method === 'GET' && url.pathname === '/api/dsh-ssh/remote/models') {
          const alias = url.searchParams.get('alias'), updatedAt = Number(url.searchParams.get('hostUpdatedAt'))
          if (!alias || !Number.isSafeInteger(updatedAt) || updatedAt <= 0) throw Error('Choose a configured SSH host')
          writeJson(res, 200, models.view(alias, updatedAt)); return
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req, { maxBytes: 2048 }) as { alias?: unknown; hostUpdatedAt?: unknown; change?: ModelFollowPolicyChange }
          if (typeof body.alias !== 'string' || !Number.isSafeInteger(body.hostUpdatedAt) || Number(body.hostUpdatedAt) <= 0) throw Error('Choose a configured SSH host')
          const updatedAt = body.hostUpdatedAt as number
          if (url.pathname === '/api/dsh-ssh/remote/models/policy') {
            if (!body.change || typeof body.change !== 'object') throw Error('A model policy is required')
            writeJson(res, 200, await models.setPolicy(body.alias, updatedAt, body.change)); return
          }
          if (url.pathname === '/api/dsh-ssh/remote/models/check') {
            await models.sync(body.alias, updatedAt); writeJson(res, 200, models.view(body.alias, updatedAt)); return
          }
          if (url.pathname === '/api/dsh-ssh/remote/models/open') { writeJson(res, 200, models.open(body.alias, updatedAt)); return }
        }
        writeJson(res, 405, { error: 'Unsupported server model operation' }); return
      }
      if (url.pathname.startsWith('/api/dsh-ssh/remote/plugins')) {
        res.setHeader('Cache-Control', 'no-store')
        if (!plugins) { writeJson(res, 503, { error: 'Server plugin management is unavailable' }); return }
        if (req.method === 'GET' && url.pathname === '/api/dsh-ssh/remote/plugins') {
          const alias = url.searchParams.get('alias'), version = Number(url.searchParams.get('hostUpdatedAt'))
          if (!alias || !Number.isSafeInteger(version) || version <= 0) throw new Error('Choose a configured host before comparing plugins')
          writeJson(res, 200, await plugins.compare(alias, version)); return
        }
        if (req.method === 'GET' && url.pathname === '/api/dsh-ssh/remote/plugins/job') {
          const job = plugins.job(url.searchParams.get('id') ?? '')
          writeJson(res, job ? 200 : 404, job ?? { error: 'Sync outcome unavailable. Inspect remote plugins before another sync.' }); return
        }
        if (req.method === 'POST' && url.pathname === '/api/dsh-ssh/remote/plugins/sync') {
          const body = await readJsonBody(req, { maxBytes: 16384 }) as { planId?: unknown; names?: unknown; requestId?: unknown }
          if (typeof body?.planId !== 'string' || typeof body.requestId !== 'string' || !Array.isArray(body.names)
            || body.names.some(name => typeof name !== 'string')) throw new Error('Invalid plugin sync selection')
          writeJson(res, 202, await plugins.start(body.planId, body.names, body.requestId)); return
        }
        writeJson(res, 405, { error: 'Unsupported server plugin operation' }); return
      }
      if (url.pathname.startsWith('/api/dsh-ssh/remote/view-observations')) {
        res.setHeader('Cache-Control', 'no-store')
        try {
          if (req.method === 'GET' && url.pathname === '/api/dsh-ssh/remote/view-observations/hosts') {
            writeJson(res, 200, await manager.viewObservationHosts(url.searchParams.get('after') ?? '')); return
          }
          if (req.method === 'GET' && url.pathname === '/api/dsh-ssh/remote/view-observations') {
            writeJson(res, 200, await manager.viewObservations(url.searchParams.get('hostId') ?? '', url.searchParams.get('after') ?? '')); return
          }
          if (req.method === 'POST' && url.pathname === '/api/dsh-ssh/remote/view-observations/dismiss') {
            const body = await readJsonBody(req, { maxBytes: 8192 }) as { hostId?: unknown; observationId?: unknown }
            if (typeof body.hostId !== 'string' || typeof body.observationId !== 'string') throw new Error('Invalid notice selection')
            await manager.dismissViewObservation(body.hostId, body.observationId); writeJson(res, 200, { ok: true }); return
          }
        } catch { writeJson(res, 507, { error: 'Local observation metadata needs inspection; its files were preserved', errorCode: 'view-observations/storage' }); return }
        writeJson(res, 404, { error: 'Unknown local observation route' }); return
      }
      if (req.method === 'GET' && url.pathname === '/api/dsh-ssh/remote/history') {
        writeJson(res, 200, await manager.historyCopies()); return
      }
      if (req.method === 'GET' && url.pathname === '/api/dsh-ssh/remote/history/audit') {
        writeJson(res, 200, { storage: await manager.auditHistory() }); return
      }
      if (req.method==='GET' && url.pathname==='/api/dsh-ssh/remote/history/event') {
        const seq=Number(url.searchParams.get('seq'))
        if (!/^\d+$/.test(url.searchParams.get('seq')??'') || !Number.isSafeInteger(seq) || seq<0) throw new Error('Invalid saved history event')
        const record=await manager.historyEvent(url.searchParams.get('key')??'',seq)
        if (!record) {writeJson(res,404,{error:'Saved history event is unavailable'});return}
        res.writeHead(200,{'content-type':'application/json; charset=utf-8','content-disposition':`attachment; filename="history-event-${seq}.json"`,'cache-control':'no-store'})
        res.end(JSON.stringify(record));return
      }
      if (req.method === 'GET' && url.pathname === '/api/dsh-ssh/remote/history/read') {
        if (url.searchParams.has('beforeSeq')&&!url.searchParams.has('limit')) throw new Error('A saved history window limit is required')
        const window=url.searchParams.has('limit') ? {limit:Number(url.searchParams.get('limit')),
          ...(url.searchParams.has('beforeSeq') ? {beforeSeq:Number(url.searchParams.get('beforeSeq'))} : {})} : undefined
        if (window && (!Number.isInteger(window.limit) || window.limit<1 || window.limit>500
          || window.beforeSeq!==undefined && (!Number.isSafeInteger(window.beforeSeq) || window.beforeSeq<0))) throw new Error('Invalid saved history window')
        const copy = url.searchParams.has('key') ? await manager.historyCopy(url.searchParams.get('key')!,window)
          : await manager.cachedHistory(url.searchParams.get('id') ?? '', url.searchParams.get('sessionId') ?? '',window)
        writeJson(res, 200, { copy }); return
      }
      if (req.method === 'POST' && url.pathname === '/api/dsh-ssh/remote/history/sync') {
        const body = await readJsonBody(req) as { id?: unknown; sessionId?: unknown }
        if (typeof body.id !== 'string' || typeof body.sessionId !== 'string') throw new Error('Session identity is required')
        manager.syncHistory(body.id, body.sessionId); writeJson(res, 202, { accepted: true }); return
      }
      if (req.method === 'POST' && url.pathname === '/api/dsh-ssh/remote/history/clear') {
        const body = await readJsonBody(req, { maxBytes: 128 * 1024 }) as { keys?: unknown }
        if (!Array.isArray(body.keys) || body.keys.length > 1000 || body.keys.some(x => typeof x !== 'string')) throw new Error('Select cached sessions to clear')
        await manager.clearHistory(body.keys); writeJson(res, 200, { ok: true }); return
      }
      if (req.method === 'POST' && url.pathname === '/api/dsh-ssh/remote/history/finish-clear') {
        const body = await readJsonBody(req, { maxBytes: 128 * 1024 }) as { selection?: { key: string; generation: number }[] }
        if (!Array.isArray(body.selection) || body.selection.length > 1000 || body.selection.some(value => !value
          || typeof value.key !== 'string' || !/^[a-f0-9]{64}$/.test(value.key) || !Number.isSafeInteger(value.generation) || value.generation < 0)) throw new Error('Choose interrupted local clears to finish')
        await manager.finishHistoryClear(body.selection); writeJson(res, 200, { ok: true }); return
      }
      if (req.method === 'POST' && url.pathname === '/api/dsh-ssh/remote/history/snooze') {
        await manager.snoozeHistory(); writeJson(res, 200, { ok: true }); return
      }
      if (req.method === 'GET' && url.pathname === '/api/dsh-ssh/remote/workspaces') {
        const [hosts, observations] = await Promise.all([manager.status(), manager.viewObservationPresence?.()])
        writeJson(res, 200, { workspaces: manager.catalog(), hosts, operations: manager.activity(), history: manager.history(), warning: manager.activityWarning(), ...(observations ? { viewObservations: true } : {}) }); return
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
      if (req.method === 'POST' && url.pathname === '/api/dsh-ssh/remote/session/action') {
        const body = await readJsonBody(req, { maxBytes: 8192 }) as { id?: unknown; expectedHostId?: unknown; sessionId?: unknown; action?: unknown; title?: unknown; stopActivity?: unknown }
        if (typeof body.id !== 'string' || typeof body.sessionId !== 'string' || typeof body.action !== 'string'
          || typeof body.expectedHostId !== 'string' || !/^[a-f0-9]{24}$/.test(body.expectedHostId)
          || body.title !== undefined && typeof body.title !== 'string' || body.stopActivity !== undefined && typeof body.stopActivity !== 'boolean') throw new Error('Invalid remote Session action')
        const result = await manager.sessionAction(body.id, body.sessionId, body.action, body.title as string | undefined, body.stopActivity === true, body.expectedHostId)
        writeJson(res, 200, { ok: true, ...result }); return
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
        // Keep browser navigation same-site without relaxing the gateway's
        // Origin fence. Only the already authenticated request Host selects it.
        const localhost = new URL('http://' + req.headers.host).hostname === 'localhost'
        writeJson(res, 200, localhost ? await manager.open(body.id, body.sessionId, 'localhost') : await manager.open(body.id, body.sessionId)); return
      }
      if (req.method === 'POST' && url.pathname === '/api/dsh-ssh/remote/dismiss') {
        const body = await readJsonBody(req) as { id?: unknown }
        if (typeof body?.id !== 'string') throw new Error('operation id is required')
        manager.dismiss(body.id); writeJson(res, 200, { ok: true }); return
      }
      writeJson(res, 404, { error: 'Unknown remote workspace route or method' })
    } catch (error) {
      const errorCode = error instanceof CatalogReadError ? 'catalog/' + error.code : remoteErrorCode(error)
      const activity = errorCode === 'workspace/session-active' ? remoteErrorActivity(error) : undefined
      writeJson(res, 400, {
        error: error instanceof Error ? error.message : 'Remote workspace operation failed',
        errorCode,
        ...(activity === undefined ? {} : { activity }),
      })
    }
  } }]
}
