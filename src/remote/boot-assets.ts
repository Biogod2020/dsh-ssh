import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type { IncomingHttpHeaders } from 'node:http'

interface Asset { headers: Record<string, string>; body: Buffer }
const entryLimit = 12 * 1024 * 1024
const diskLimit = 64 * 1024 * 1024

/** Only version-addressed native code/styles, never HTML, API data or files. */
export function bootAssetPath(url: URL): boolean {
  if (/^\/assets\/[^/]+[-.][A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(url.pathname)) return !url.search
  return url.pathname === '/plugins/'
    && /^\?\?(?:@?[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*\/client\.(?:js|css))(?:,@?[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*\/client\.(?:js|css))*&rev=[a-f0-9]{8,64}$/.test(url.search)
}

/** Private, bounded disk cache. An unavailable/corrupt cache is a normal miss. */
export class BootAssetCache {
  private ready?: Promise<void>
  private writes = new Map<string, Promise<void>>()
  private writing: Promise<void> = Promise.resolve()
  constructor(readonly root: string) {}
  private init(): Promise<void> {
    return this.ready ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const info = await lstat(this.root)
      if (!info.isDirectory() || (info.mode & 0o077)) throw new Error('Boot cache must be private')
    })()
  }
  private key(scope: string, url: URL, encoding: string): string {
    return createHash('sha256').update(JSON.stringify([scope, url.pathname + url.search, encoding])).digest('hex')
  }
  async read(scope: string, url: URL, encoding: string): Promise<Asset | undefined> {
    if (!bootAssetPath(url)) return
    let file
    try {
      await this.init()
      file = await open(join(this.root, this.key(scope, url, encoding) + '.asset'), constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = await file.stat()
      if (!info.isFile() || info.mode & 0o077 || info.size > entryLimit + 4096) return
      const bytes = await file.readFile(), split = bytes.indexOf(10)
      if (split < 0 || split > 4096) return
      const meta = JSON.parse(bytes.subarray(0, split).toString('utf8')), body = bytes.subarray(split + 1)
      if (meta.version !== 1 || typeof meta.expiresAt !== 'number' || !Number.isFinite(meta.expiresAt) || meta.expiresAt <= Date.now()
        || meta.size !== body.length || body.length > entryLimit
        || meta.hash !== createHash('sha256').update(body).digest('hex') || !meta.headers || typeof meta.headers !== 'object'
        || Object.entries(meta.headers).some(([key, value]) => !['content-type', 'content-encoding', 'cache-control', 'etag', 'vary'].includes(key)
          || typeof value !== 'string' || /[\r\n]/.test(value)) || !this.storable(meta.headers)) return
      return { headers: meta.headers, body }
    } catch { return undefined }
    finally { await file?.close().catch(() => {}) }
  }
  storable(headers: IncomingHttpHeaders): boolean {
    const cache = String(headers['cache-control'] ?? '').toLowerCase()
    return !headers['set-cookie'] && !/\b(?:private|no-store|no-cache)\b/.test(cache)
      && /(?:^|,)\s*public\s*(?:,|$)/.test(cache) && /(?:^|,)\s*immutable\s*(?:,|$)/.test(cache)
      && /(?:javascript|text\/css)/i.test(String(headers['content-type']))
      && String(headers.vary ?? '').split(',').every(value => ['', 'accept-encoding'].includes(value.trim().toLowerCase()))
      && (!headers['content-encoding'] || ['gzip', 'br', 'deflate', 'identity'].includes(String(headers['content-encoding'])))
      && /(?:^|,)\s*max-age=[1-9]\d*\s*(?:,|$)/.test(cache)
  }
  async save(scope: string, url: URL, encoding: string, headers: IncomingHttpHeaders, body: Buffer): Promise<void> {
    if (!bootAssetPath(url) || !this.storable(headers) || !body.length || body.length > entryLimit) return
    const key = this.key(scope, url, encoding)
    if (this.writes.has(key)) return this.writes.get(key)
    const operation = this.writing.then(async () => {
      let temporary: string | undefined
      try {
        await this.init()
        const kept: Record<string, string> = {}
        for (const name of ['content-type', 'content-encoding', 'cache-control', 'etag', 'vary']) if (typeof headers[name] === 'string') kept[name] = headers[name]
        const age = Number(/(?:^|,)\s*max-age=(\d+)/.exec(String(headers['cache-control']).toLowerCase())?.[1])
        const meta = { version: 1, expiresAt: Date.now() + Math.min(age, 31536000) * 1000, headers: kept,
          size: body.length, hash: createHash('sha256').update(body).digest('hex') }
        temporary = join(this.root, key + '.' + randomUUID() + '.tmp')
        const file = await open(temporary, 'wx', 0o600)
        try { await file.writeFile(Buffer.concat([Buffer.from(JSON.stringify(meta) + '\n'), body])) } finally { await file.close() }
        await rename(temporary, join(this.root, key + '.asset')); temporary = undefined
        const rows = await Promise.all((await readdir(this.root)).filter(name => /^[a-f0-9]{64}\.asset$/.test(name)).map(async name => {
          const path = join(this.root, name), info = await lstat(path); return { path, bytes: info.size, at: info.mtimeMs }
        }))
        let total = rows.reduce((sum, row) => sum + row.bytes, 0)
        for (const row of rows.sort((a, b) => a.at - b.at)) {
          if (total <= diskLimit) break
          await unlink(row.path).catch(() => {}); total -= row.bytes
        }
      } catch { /* Cache writes never fail a completed native request. */ }
      finally { if (temporary) await unlink(temporary).catch(() => {}) }
    })
    this.writing = operation
    this.writes.set(key, operation)
    try { await operation } finally { this.writes.delete(key) }
  }
}

export const bootAssetEntryLimit = entryLimit
