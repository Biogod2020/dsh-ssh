/** Native owner receipt + read-only activity checks for the account service. */
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { publishAccountWeb } from './account-service.mjs'

export const name = 'dsh-account-service'
export const inject = ['webServer', 'connection', 'sessionController', 'sessions']
export async function accountActivity(ctx) {
  const controller = ctx.get('sessionController')
  if (typeof controller?.list !== 'function') return { checked: false, idle: false }
  const catalog = await controller.list({}, AbortSignal.timeout(15000))
  if (!Array.isArray(catalog?.items) || catalog.items.length > 50000 || catalog.items.some(row => typeof row.running !== 'boolean')) return { checked: false, idle: false }
  const runningSessions = catalog.items.filter(row => row.running).length, activities = []
  const attached = ctx.get('sessions')?.list?.() ?? []
  if (!Array.isArray(attached) || typeof ctx.waterfall !== 'function') return { checked: false, idle: false }
  for (const session of attached) {
    const found = await ctx.waterfall('workspace/session-activity', { sessionId: session.id }, () => Promise.resolve([]))
    if (!Array.isArray(found)) return { checked: false, idle: false }
    for (const item of found) activities.push({ sessionId: session.id, kind: typeof item.kind === 'string' ? item.kind : 'unknown' })
  }
  const globalActivity = await ctx.waterfall('dsh-account-service/activity', {}, () => Promise.resolve([]))
  if (!Array.isArray(globalActivity)) return { checked: false, idle: false }
  for (const item of globalActivity) activities.push({ kind: typeof item.kind === 'string' ? item.kind : 'unknown' })
  return { checked: true, pid: process.pid, idle: runningSessions === 0 && activities.length === 0, runningSessions, activities }
}
function runtimeVersion(fallback) {
  try {
    const require = createRequire(process.argv[1])
    return require('@deepseek-ai/dsh/package.json').version
  } catch { return fallback }
}
export function apply(ctx, config = {}) {
  let disposed = false, timer
  const home = process.env.DSH_HOME || join(homedir(), '.dsh'), root = config.root || join(homedir(), '.local/share/dsh-remote')
  const publish = async () => {
    if (disposed) return
    try {
      const port = ctx.webServer.port
      if (!Number.isInteger(port) || port < 1 || typeof ctx.connection.authenticatedUrl !== 'function') throw Error('not ready')
      const protocol = ctx.webServer.protocol || 'http:', url = ctx.connection.authenticatedUrl(`${protocol}//127.0.0.1:${port}/`)
      const probe = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) }); await probe.body?.cancel()
      if (probe.status !== 303) throw Error('not ready')
      if (!disposed) await publishAccountWeb({ home: await realpath(home), root }, { pid: process.pid, port, url,
        userHome: homedir(), directory: await realpath(home), version: runtimeVersion(config.version) })
    } catch { if (!disposed) { timer = setTimeout(() => { void publish() }, 500); timer.unref?.() } }
  }
  ctx.effect(() => () => { disposed = true; clearTimeout(timer) })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/dsh-account-service/activity', handler: async (req, res) => {
    const denied = ctx.connection.requestRejection(req)
    if (denied) { res.writeHead(denied); res.end(); return }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
    try {
      const value = await accountActivity(ctx)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value))
    } catch { res.writeHead(503); res.end('{"checked":false,"idle":false}') }
  } }))
  void publish()
}
