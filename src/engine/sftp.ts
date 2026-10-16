/**
 * SFTP transfers: upload (file or recursive tree), single-file download, and
 * remote directory listing. Every channel is opened once per operation and
 * released exactly once so sshd's MaxSessions cap is never exhausted.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve as resolvePath } from 'node:path'
import { posix } from 'node:path'
import { Client, type SFTPWrapper } from 'ssh2'
import type { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { RemoteDirEntry, RemoteDirectoryListing, TransferProgress, TransferDestinationInfo } from '../protocol.ts'
import { withClient, type PoolEngine } from './connection-pool.ts'

/** Walk a local directory, collecting relative paths of every file. */
export function walkLocalDir(root: string): string[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      // lstat, not stat: a symlink must never be followed — a link cycle
      // (ln -s . self) recurses forever under stat, and a link to a file
      // would silently upload the target's bytes.
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) visit(full)
      else if (stat.isFile()) files.push(relative(root, full).replaceAll('\\', '/'))
    }
  }
  visit(root)
  return files
}

/** Upload one local file (or directory tree) to a remote path. */
export async function upload(
  engine: PoolEngine,
  alias: string,
  localPath: string,
  remotePath: string,
  recursive: boolean,
  onProgress?: (progress: TransferProgress) => void,
  signal?: AbortSignal,
  expectedUpdatedAt?: number,
): Promise<{ bytes: number; files: number }> {
  signal?.throwIfAborted()
  // Remote paths must be absolute: the mkdir chain and fastPut must agree
  // on one resolution (relative paths previously created dirs at the root).
  if (!remotePath.startsWith('/')) {
    throw new Error('remotePath must be an absolute path (got \'' + remotePath + '\')')
  }
  const local = resolvePath(localPath)
  if (!existsSync(local)) throw new Error('local path not found: \'' + localPath + '\'')
  return withClient(engine, alias, (client) => withSftp(client, async (sftp) => {
    const stat = statSync(local)
    let files: string[]
    if (stat.isDirectory()) {
      if (!recursive) throw new Error('\'' + localPath + '\' is a directory — enable recursive upload')
      files = walkLocalDir(local)
      await ensureRemoteDir(sftp, remotePath, signal)
    } else {
      files = ['']
      await ensureRemoteDir(sftp, dirname(remotePath), signal)
    }
    let bytes = 0
    for (const rel of files) {
      signal?.throwIfAborted()
      const src = rel === '' ? local : join(local, rel)
      // Remote paths always use forward slashes; normalize any OS separators.
      const remoteRel = rel.split(/[\\/]/).join('/')
      const dst = rel === '' ? remotePath : remotePath.replace(/\/$/, '') + '/' + remoteRel
      if (rel !== '') await ensureRemoteDir(sftp, posix.dirname(dst), signal)
      signal?.throwIfAborted()
      await fastTransfer(sftp, 'put', src, dst, engine.opts.sftpConcurrency, onProgress, signal)
      bytes += statSync(src).size
    }
    return { bytes, files: files.length }
  }, signal), signal, expectedUpdatedAt)
}

/** Download one remote file to a local path. */
export async function download(
  engine: PoolEngine,
  alias: string,
  remotePath: string,
  localPath: string,
  onProgress?: (progress: TransferProgress) => void,
  signal?: AbortSignal,
): Promise<{ bytes: number }> {
  signal?.throwIfAborted()
  return withClient(engine, alias, (client) => withSftp(client, async (sftp) => {
    const stat = await new Promise<{ isDirectory: () => boolean }>((resolve, reject) => {
      sftp.stat(remotePath, (error, stats) => error !== undefined ? reject(error) : resolve(stats))
    })
    if (stat.isDirectory()) {
      throw new Error('\'' + remotePath + '\' is a directory — directory download is not supported yet (download individual files)')
    }
    const local = resolvePath(localPath)
    signal?.throwIfAborted()
    if (!existsSync(dirname(local))) mkdirSync(dirname(local), { recursive: true })
    await fastTransfer(sftp, 'get', remotePath, local, engine.opts.sftpConcurrency, onProgress, signal)
    return { bytes: statSync(local).size }
  }, signal), signal)
}

/** Browser downloads stream directly from their own SFTP channel. */
export async function downloadStream(engine: PoolEngine, alias: string, remotePath: string,
  destination: Writable, onSize: (bytes: number) => void, signal?: AbortSignal, expectedUpdatedAt?: number): Promise<{ bytes: number }> {
  signal?.throwIfAborted()
  return withClient(engine, alias, client => withSftp(client, async sftp => {
    const stat = await new Promise<{ size: number; isDirectory: () => boolean }>((resolve, reject) => {
      sftp.stat(remotePath, (error, stats) => error !== undefined ? reject(error) : resolve(stats))
    })
    signal?.throwIfAborted()
    if (stat.isDirectory()) throw new Error('Directory download is not supported; choose a file')
    onSize(stat.size)
    const source = sftp.createReadStream(remotePath, stat.size > 0 ? { start: 0, end: stat.size - 1 } : {})
    let bytes = 0
    source.on('data', (chunk: Buffer) => { bytes += chunk.byteLength })
    try {
      await pipeline(source, destination, { signal })
      if (bytes !== stat.size) throw new Error('Remote file changed or download ended before all bytes were received')
      return { bytes }
    } finally { source.destroy() }
  }, signal), signal, expectedUpdatedAt)
}

/** Read one frozen target; lstat preserves a final symlink's identity. Never reads file content. */
export async function inspectDestination(engine: PoolEngine, alias: string, path: string, expectedUpdatedAt: number, signal?: AbortSignal): Promise<TransferDestinationInfo> {
  if (!path.startsWith('/') || path.length > 4096 || /[\0\r\n]/.test(path)) throw new Error('Choose an absolute remote file path')
  if (!Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt <= 0) throw new Error('Invalid host configuration version')
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20000)])
  return withClient(engine, alias, client => withSftp(client, sftp => new Promise<TransferDestinationInfo>((resolve, reject) => {
    sftp.lstat(path, (error, attrs) => {
      if (error) {
        if ('code' in error && error.code === 2) resolve({ exists: false, checkedAt: Date.now() })
        else reject(error) // Permission and transport failures are never "missing".
        return
      }
      const size = attrs.size, mtimeMs = attrs.mtime * 1000
      if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(mtimeMs) || mtimeMs < 0) {
        reject(new Error('Remote file metadata is incomplete')); return
      }
      resolve({ exists: true, type: attrs.isSymbolicLink() ? 'symlink' : attrs.isDirectory() ? 'dir' : attrs.isFile() ? 'file' : 'other', size, mtimeMs, checkedAt: Date.now() })
    })
  }), bounded), bounded, expectedUpdatedAt)
}

/** List a remote directory (file browser). */
export async function ls(engine: PoolEngine, alias: string, path: string): Promise<RemoteDirEntry[]> {
  return withClient(engine, alias, (client) => withSftp(client, async (sftp) => {
    return await new Promise((resolve, reject) => {
      sftp.readdir(path, (error, list) => {
        if (error !== undefined) {
          reject(error)
          return
        }
        const entries: RemoteDirEntry[] = list.map(item => ({
          name: item.filename,
          type: item.attrs.isDirectory() ? 'dir' : item.attrs.isFile() ? 'file' : 'other',
          size: item.attrs.size,
          mtimeMs: item.attrs.mtime * 1000,
          mode: item.attrs.mode,
        }))
        resolve(entries)
      })
    })
  }))
}

/** Resolve a directory, then return only its child directories. Symlinked directories are followed. */
export async function browseDirectories(engine: PoolEngine, alias: string, path: string, prefix = ''): Promise<RemoteDirectoryListing> {
  if (!path.startsWith('/') || path.length > 4096 || path.includes('\0') || /[\r\n]/.test(path)) throw new Error('Choose an absolute remote directory')
  if (prefix.length > 255 || /[\/\0\r\n]/.test(prefix)) throw new Error('Invalid directory prefix')
  return withClient(engine, alias, client => withSftp(client, async sftp => {
    const resolved = await new Promise<string>((resolve, reject) => sftp.realpath(path, (error, value) => error ? reject(error) : resolve(value)))
    const stat = await new Promise<{ isDirectory: () => boolean }>((resolve, reject) => sftp.stat(resolved, (error, value) => error ? reject(error) : resolve(value)))
    if (!stat.isDirectory()) throw new Error('Remote path is not a directory')
    const list = await new Promise<Array<{ filename: string; attrs: { isDirectory: () => boolean; isSymbolicLink: () => boolean } }>>((resolve, reject) =>
      sftp.readdir(resolved, (error, value) => error ? reject(error) : resolve(value)))
    const candidates = list.filter(item => item.filename !== '.' && item.filename !== '..' && item.filename.startsWith(prefix))
    const directories = candidates.filter(item => item.attrs.isDirectory()).map(item => item.filename)
    const symlinks = candidates.filter(item => item.attrs.isSymbolicLink())
    let next = 0
    await Promise.all(Array.from({ length: Math.min(8, symlinks.length) }, async () => {
      while (next < symlinks.length) {
        const name = symlinks[next++]!.filename
        try {
          const target = await new Promise<{ isDirectory: () => boolean }>((resolve, reject) =>
            sftp.stat(posix.join(resolved, name), (error, value) => error ? reject(error) : resolve(value)))
          if (target.isDirectory()) directories.push(name)
        } catch { /* Broken or inaccessible symlinks are not navigable. */ }
      }
    }))
    directories.sort((a, b) => a.localeCompare(b))
    return { path: resolved, directories: directories.slice(0, 200), truncated: directories.length > 200 }
  }))
}

/**
 * Open one SFTP channel, run the operation, and release the channel exactly
 * once when the operation settles (success or error). ssh2 keeps each
 * subsystem channel open until end(); without this, every transfer leaks a
 * channel until sshd's MaxSessions cap makes all later opens fail.
 */
async function withSftp<T>(client: Client, run: (sftp: SFTPWrapper) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    let channel: SFTPWrapper | undefined
    let settled = false, ended = false
    const end = (): void => {
      if (channel === undefined || ended) return
      ended = true
      try { channel.end() } catch { /* channel already closed */ }
    }
    const finish = (error?: unknown, value?: T): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', cancel)
      client.off('close', disconnected)
      end()
      if (error !== undefined) reject(error)
      else resolve(value as T)
    }
    const cancel = (): void => {
      const error = new Error('transfer cancelled; destination may be incomplete or overwritten; outcome unknown; not retried')
      error.name = 'AbortError'
      finish(error)
    }
    const disconnected = (): void => finish(new Error('SSH disconnected; transfer outcome unknown; not retried'))
    signal?.addEventListener('abort', cancel, { once: true })
    client.once('close', disconnected)
    try {
      client.sftp((error, sftp) => {
        if (error !== undefined) { finish(error); return }
        channel = sftp
        // Keep an error listener until close, including a late ACK after Stop.
        // Only this operation's subsystem is ended; the SSH pool stays alive.
        const onError = (cause: Error): void => finish(cause)
        sftp.on('error', onError)
        sftp.once('close', () => {
          ended = true
          sftp.off('error', onError)
          finish(new Error('SFTP channel closed; transfer outcome unknown; not retried'))
        })
        if (settled) { end(); return }
        try { void run(sftp).then(value => finish(undefined, value), finish) }
        catch (cause) { finish(cause) }
      })
    } catch (cause) { finish(cause) }
  })
}

/** Create a remote directory chain (stat-then-mkdir per segment). */
function ensureRemoteDir(sftp: SFTPWrapper, remote: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const segments = remote.replace(/^\/+/, '').split('/').filter(segment => segment !== '')
    const walk = (index: number): void => {
      if (signal?.aborted) { reject(signal.reason); return }
      if (index >= segments.length) {
        resolve()
        return
      }
      const current = '/' + segments.slice(0, index + 1).join('/')
      sftp.stat(current, (statError) => {
        if (signal?.aborted) { reject(signal.reason); return }
        if (statError === undefined) {
          walk(index + 1)
          return
        }
        // Statting a missing path fails; mkdir it (idempotent because the
        // stat check runs first — some sftp servers throw on EEXIST).
        sftp.mkdir(current, (mkdirError) => {
          if (mkdirError !== undefined) {
            reject(mkdirError)
            return
          }
          walk(index + 1)
        })
      })
    }
    walk(0)
  })
}

/** One fastPut/fastGet transfer with throttled progress (the two directions share everything but the verb). */
function fastTransfer(sftp: SFTPWrapper, kind: 'put' | 'get', src: string, dst: string, concurrency: number, onProgress?: (progress: TransferProgress) => void, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    // Progress frames name the destination on upload, the source on download;
    // the final size comes from the local side of the transfer.
    const file = kind === 'put' ? dst : src
    const finalSize = (): number => statSync(kind === 'put' ? src : dst).size
    let lastEmit = 0
    const started = Date.now()
    if (kind === 'put') {
      onProgress?.({ phase: 'transferring', file, transferred: 0, total: statSync(src).size, percent: 0 })
    }
    const step = (transferred: number, _chunk: number, total: number): void => {
      if (signal?.aborted) return
      const now = Date.now()
      // Throttle: high-speed links fire one callback per chunk; the UI only
      // needs ~10 frames per second.
      if (now - lastEmit < 100 && transferred < total) return
      lastEmit = now
      const elapsed = (now - started) / 1000
      onProgress?.({
        phase: 'transferring',
        file,
        transferred,
        total,
        percent: total > 0 ? Math.round((transferred / total) * 1000) / 10 : 0,
        speedBps: elapsed > 0 ? Math.round(transferred / elapsed) : undefined,
      })
    }
    const done = (error: unknown): void => {
      if (signal?.aborted) { reject(signal.reason); return }
      if (error !== undefined) {
        onProgress?.({ phase: 'error', file, transferred: 0, total: 0, percent: 0, error: String(error) })
        reject(error)
      } else {
        onProgress?.({ phase: 'done', file, transferred: finalSize(), total: finalSize(), percent: 100 })
        resolve()
      }
    }
    if (kind === 'put') sftp.fastPut(src, dst, { concurrency, step }, done)
    else sftp.fastGet(src, dst, { concurrency, step }, done)
  })
}
