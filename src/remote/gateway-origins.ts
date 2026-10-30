import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'

/** Keep a Host's browser origin across controller restarts, retaining its
 * native UI preferences/cache and avoiding a new port cookie every time. */
export class GatewayOrigins {
  constructor(readonly root: string) {}
  private file(hostId: string, controller: string): string {
    const url = new URL(controller), origin = url.origin === 'null' ? url.protocol + '//' + url.host : url.origin
    return join(this.root, createHash('sha256').update(JSON.stringify([hostId, origin])).digest('hex') + '.json')
  }
  async preferred(hostId: string, controller: string): Promise<number | undefined> {
    let file
    try {
      file = await open(this.file(hostId, controller), constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = await file.stat(); if (!info.isFile() || info.mode & 0o077 || info.size > 1024) return
      const value = JSON.parse(await file.readFile('utf8'))
      if (value.version === 1 && Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535) return value.port
    } catch { return undefined }
    finally { await file?.close().catch(() => {}) }
  }
  async remember(hostId: string, controller: string, port: number): Promise<void> {
    let temporary: string | undefined
    try {
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const info = await lstat(this.root); if (!info.isDirectory() || info.mode & 0o077) return
      const path = this.file(hostId, controller); temporary = path + '.' + randomUUID() + '.tmp'
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify({ version: 1, port })) } finally { await file.close() }
      await rename(temporary, path); temporary = undefined
    } catch { /* Origin persistence is an optional cache, never session state. */ }
    finally { if (temporary) await unlink(temporary).catch(() => {}) }
  }
}
