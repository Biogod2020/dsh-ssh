import { gunzipSync, gzipSync } from 'node:zlib'
import { readFile, lstat } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import type { SshEngine } from '../engine.ts'
import type { RemoteReceipt } from './types.ts'
import { bootAssetPath } from './boot-assets.ts'
import { remoteScript, shellQuote } from './transport.ts'

export interface BootArtifact { kind: 'code' | 'image'; body: string; sourceBytes: number; rawBytes: number; hash: string; mime: string }
export interface BootRead { source: string; image?: string }
interface Dependencies { readFile: typeof readFile; lstat: typeof lstat; join: typeof join; isAbsolute: typeof isAbsolute; createHash: typeof createHash; gzipSync: typeof gzipSync }

/** Runs beside the existing remote DSH. Reads static native code only, without
 * installing a helper, changing profiles, or transferring credentials. */
export async function remoteBootRead(root: string, expected: {pid: number; port: number}, input: BootRead,
  allowed: (url: URL) => boolean, { readFile, lstat, join, isAbsolute, createHash, gzipSync }: Dependencies): Promise<BootArtifact> {
  const source = new URL(input.source, 'http://127.0.0.1')
  if (!isAbsolute(root) || !allowed(source) || source.pathname !== '/plugins/'
    || input.source !== source.pathname + source.search || input.source.length > 8192 || input.image !== undefined && !/^[a-f0-9]{64}$/.test(input.image)) throw Error('Invalid static code read')
  const receiptPath = join(root, 'state/server.json'), info = await lstat(receiptPath)
  if (!info.isFile() || info.mode & 0o077) throw Error('Unsafe server receipt')
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  if (receipt.protocol !== 1 || receipt.root !== root || receipt.pid !== expected.pid || receipt.port !== expected.port) throw Error('Remote server identity changed')
  const login = new URL(receipt.url)
  if (login.protocol !== 'http:' || login.hostname !== '127.0.0.1' || Number(login.port) !== expected.port || !login.searchParams.get('token')) throw Error('Invalid local asset service')
  const auth = await fetch(login, { redirect: 'manual', signal: AbortSignal.timeout(10000) }); await auth.body?.cancel()
  const cookie = auth.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')
  if (auth.status !== 303 || !cookie) throw Error('Static service authentication failed')
  const response = await fetch(login.origin + input.source, { redirect: 'error', headers: { Cookie: cookie, Origin: login.origin, 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(10000) })
  const cache = response.headers.get('cache-control')?.toLowerCase() ?? ''
  if (response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().includes('javascript')
    || !/(?:^|,)\s*public\s*(?:,|$)/.test(cache) || !/(?:^|,)\s*immutable\s*(?:,|$)/.test(cache)
    || !/(?:^|,)\s*max-age=[1-9]\d*\s*(?:,|$)/.test(cache)
    || /(?:private|no-store|no-cache)/.test(cache) || response.headers.has('set-cookie')
    || (response.headers.get('vary') ?? '').split(',').some(value => !['', 'accept-encoding'].includes(value.trim().toLowerCase()))) { await response.body?.cancel(); throw Error('Not immutable native code') }
  let size = 0; const chunks: Uint8Array[] = [], reader = response.body!.getReader()
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 24 * 1024 * 1024) throw Error('Static code too large'); chunks.push(value) }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const original = Buffer.concat(chunks).toString('utf8')
  const sourceKey = Buffer.from(input.source).toString('base64url')
  let image: Buffer | undefined
  const code = original.replace(/data:image\/png;base64,([A-Za-z0-9+/=]{32768,})/g, (uri, encoded: string) => {
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length > 2 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return uri
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (input.image === hash) image = bytes
    return `/__dsh_remote/boot-image/${hash}.png?source=${sourceKey}`
  })
  if (input.image && !image) throw Error('Native image was not found')
  const raw = image ?? Buffer.from(code), body = image ?? gzipSync(raw)
  return { kind: image ? 'image' : 'code', body: body.toString('base64'), sourceBytes: size, rawBytes: raw.length,
    hash: createHash('sha256').update(raw).digest('hex'), mime: image ? 'image/png' : 'text/javascript; charset=utf-8' }
}

/** Each invocation dispatches once; memoization in the gateway shares its
 * result. Even failed exports are not automatically dispatched again. */
export async function readBootArtifact(engine: SshEngine, alias: string, node: string, receipt: RemoteReceipt, request: BootRead, updatedAt: number): Promise<BootArtifact> {
  let encoded = '', complete = false
  const source = `try { const deps={...await import('node:fs/promises'),...await import('node:path'),...await import('node:crypto'),...await import('node:zlib')}; const value=await (${remoteBootRead.toString()})(${JSON.stringify(receipt.root)},${JSON.stringify({pid:receipt.pid,port:receipt.port})},${JSON.stringify(request)},(${bootAssetPath.toString()}),deps); const data=deps.gzipSync(JSON.stringify(value)).toString('base64');for(let i=0;i<data.length;i+=65536)console.log('DSH_BOOT:'+data.slice(i,i+65536));console.log('DSH_BOOT_END') } catch { console.log('DSH_ERROR: Static code preparation failed; no command was replayed.');process.exitCode=1 }`
  await remoteScript(engine, alias, `${shellQuote(node)} --input-type=module`, source, line => {
    if (line.startsWith('DSH_BOOT:')) encoded += line.slice(9)
    if (line === 'DSH_BOOT_END') complete = true
  }, 30000, updatedAt, 8 * 1024 * 1024)
  if (!complete) throw Error('Static code preparation incomplete')
  return JSON.parse(gunzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 24 * 1024 * 1024 }).toString('utf8')) as BootArtifact
}
