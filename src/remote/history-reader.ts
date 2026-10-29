import type * as fs from 'node:fs/promises'
import type * as paths from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { SshEngine } from '../engine.ts'
import type { RemoteReceipt } from './types.ts'
import type { HistoryRecord } from './history-cache.ts'
import { remoteScript, shellQuote } from './transport.ts'

export interface HistoryDelta { cursor: number; throughSeq: number; records: HistoryRecord[] }
interface Request { sessionId: string; afterSeq: number; throughSeq?: number }

/** Runs on the remote Node already selected by the installer. Only public,
 * non-activating DSH reads; authentication never crosses this SSH channel. */
export async function remoteHistoryRead(root: string, expected: { pid: number; port: number }, request: Request,
  { readFile, lstat, join, isAbsolute }: { readFile: typeof fs.readFile; lstat: typeof fs.lstat; join: typeof paths.join; isAbsolute: typeof paths.isAbsolute }): Promise<HistoryDelta> {
  if (!isAbsolute(root) || !request.sessionId || request.sessionId.length > 256 || /[\u0000-\u001f\u007f]/.test(request.sessionId)
    || !Number.isSafeInteger(request.afterSeq) || request.afterSeq < -1
    || request.throughSeq !== undefined && (!Number.isSafeInteger(request.throughSeq) || request.throughSeq < request.afterSeq)) throw new Error('Invalid history request')
  const path = join(root, 'state/server.json'), info = await lstat(path)
  // This function is serialized and executed on the remote Node. Keep the
  // platform check inline so it does not depend on a local module closure.
  if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error('Unsafe remote server receipt')
  const receipt = JSON.parse(await readFile(path, 'utf8'))
  if (receipt.protocol !== 1 || receipt.root !== root || receipt.pid !== expected.pid || receipt.port !== expected.port) throw new Error('Remote server identity changed')
  const login = new URL(receipt.url)
  if (login.protocol !== 'http:' || login.hostname !== '127.0.0.1' || Number(login.port) !== expected.port || !login.searchParams.get('token')) throw new Error('Invalid remote history address')
  const response = await fetch(login, { redirect: 'manual', signal: AbortSignal.timeout(30000) })
  await response.body?.cancel()
  const cookie = response.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')
  if (response.status !== 303 || !cookie) throw new Error('History authentication failed')
  const rpc = async (method: string, args: object) => {
    const rpcId = crypto.randomUUID()
    const result = await fetch(login.origin + '/api/' + method, { method: 'POST', redirect: 'error',
      headers: { Host: login.host, Origin: login.origin, Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }), signal: AbortSignal.timeout(30000) })
    if (!result.ok) throw new Error('History read failed')
    const body = await result.json() as any
    if (body.rpcId !== rpcId || body.result?.ok !== true) throw new Error('History read rejected')
    return body.result.value
  }
  // List activity is not an event watermark: assistant/tool events may advance
  // without another user prompt. Projections expose the exact durable cursor.
  const head = request.throughSeq ?? (await rpc('session/projections', { request: { sessionId: request.sessionId } }))?.asOfSeq
  if (!Number.isSafeInteger(head) || head < -1 || head < request.afterSeq) throw new Error('Remote history moved backwards; local copy was preserved')
  const throughSeq = Math.min(head, request.afterSeq + 500)
  if (throughSeq === request.afterSeq) return { cursor: head, throughSeq, records: [] }
  // Message-aligned upstream pages may overlap. Filter on the remote machine,
  // before compression and SSH, so the wire carries only the missing events.
  const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId: request.sessionId }, throughSeq, maxMessages: 500 } })
  if (!Array.isArray(page?.records)) throw new Error('Invalid remote history page')
  const records = page.records.filter((row: HistoryRecord) => row?.event?.seq > request.afterSeq && row.event.seq <= throughSeq)
  if (records.length !== throughSeq - request.afterSeq || records.some((row: HistoryRecord, n: number) => row?.type !== 'event'
    || typeof row.event?.type !== 'string' || row.event.seq !== request.afterSeq + n + 1)) throw new Error('Remote history has a gap; local copy was preserved')
  return { cursor: head, throughSeq, records }
}

/** One read dispatch, no retry, file installation, service restart or profile
 * mutation. The script and non-secret identity go through stdin, not argv. */
export async function readHistoryDelta(engine: SshEngine, alias: string, node: string, receipt: RemoteReceipt,
  request: Request, expectedUpdatedAt: number): Promise<HistoryDelta> {
  let encoded = '', complete = false
  const source = `try { const {readFile,lstat}=await import('node:fs/promises'); const {join,isAbsolute}=await import('node:path'); const value = await (${remoteHistoryRead.toString()})(${JSON.stringify(receipt.root)},${JSON.stringify({ pid: receipt.pid, port: receipt.port })},${JSON.stringify(request)},{readFile,lstat,join,isAbsolute});\n`
    + `const { gzipSync } = await import('node:zlib'); const data = gzipSync(JSON.stringify(value)).toString('base64');\n`
    + `for(let n=0;n<data.length;n+=65536) console.log('DSH_HISTORY:'+data.slice(n,n+65536)); console.log('DSH_HISTORY_END');\n`
    + `} catch { console.log('DSH_ERROR: Remote history read failed; the saved local copy was preserved.'); process.exitCode=1 }\n`
  await remoteScript(engine, alias, `${shellQuote(node)} --input-type=module`, source, line => {
    if (line.startsWith('DSH_HISTORY:')) encoded += line.slice(12)
    if (line === 'DSH_HISTORY_END') complete = true
  }, 90000, expectedUpdatedAt, 24 * 1024 * 1024)
  if (!complete || !encoded) throw new Error('Remote history read was interrupted; local copy was preserved')
  return JSON.parse(gunzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8')) as HistoryDelta
}
