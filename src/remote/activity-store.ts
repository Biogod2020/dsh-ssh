import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RemoteOperation, RemotePhase, RemoteWorkspace } from './types.ts'
import { isPrivateMode } from '../private-mode.ts'

export interface RemoteActivityEntry { operation: RemoteOperation; dismissed?: boolean }
const phases = new Set<RemotePhase>(['checking', 'installing-node', 'installing-dsh', 'starting', 'connecting', 'ready', 'failed', 'disconnected'])
const MAX_BYTES = 8 * 1024 * 1024
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value < 8640000000000000

/** Whitelist public fields. Never serialize a runtime receipt, launch URL, cookie or host configuration. */
function publicEntry(value: unknown): RemoteActivityEntry {
  if (!record(value) || !record(value.operation)) throw new Error('Invalid remote preparation history')
  const op = value.operation
  if (!string(op.id, 256) || !string(op.alias, 1024) || typeof op.phase !== 'string' || !phases.has(op.phase as RemotePhase)
    || !string(op.message, 65536) || !timestamp(op.createdAt) || !timestamp(op.updatedAt) || op.updatedAt < op.createdAt
    || (op.hostId !== undefined && (typeof op.hostId !== 'string' || !/^[a-f0-9]{24}$/.test(op.hostId)))
    || (op.remotePath !== undefined && !string(op.remotePath, 4096))
    || (op.errorCode !== undefined && !string(op.errorCode, 128))
    || (op.lastPhase !== undefined && (typeof op.lastPhase !== 'string' || !phases.has(op.lastPhase as RemotePhase)))
    || (value.dismissed !== undefined && typeof value.dismissed !== 'boolean')) throw new Error('Invalid remote preparation history')
  const operation: RemoteOperation = { id: op.id, alias: op.alias, phase: op.phase as RemotePhase, message: op.message,
    createdAt: op.createdAt, updatedAt: op.updatedAt,
    ...(op.hostId === undefined ? {} : { hostId: op.hostId as string }),
    ...(op.remotePath === undefined ? {} : { remotePath: op.remotePath as string }),
    ...(op.errorCode === undefined ? {} : { errorCode: op.errorCode as string }),
    ...(op.lastPhase === undefined ? {} : { lastPhase: op.lastPhase as RemotePhase }),
  }
  if (op.workspace !== undefined) {
    const ws = op.workspace
    if (!record(ws) || !string(ws.id, 256) || !string(ws.hostId, 24) || !/^[a-f0-9]{24}$/.test(ws.hostId)
      || !string(ws.alias, 1024) || !string(ws.remotePath, 4096) || !ws.remotePath.startsWith('/')
      || !string(ws.title, 8192) || !string(ws.workspaceId, 512)
      || ws.alias !== operation.alias || ws.hostId !== operation.hostId) throw new Error('Invalid remote preparation history')
    operation.workspace = { id: ws.id, hostId: ws.hostId, alias: ws.alias, remotePath: ws.remotePath, title: ws.title, workspaceId: ws.workspaceId } satisfies RemoteWorkspace
  }
  if (operation.phase === 'ready' && !operation.workspace) throw new Error('Invalid remote preparation history')
  return { operation, ...(value.dismissed ? { dismissed: true } : {}) }
}

/** Atomic private journal, separate from live connections. Reading it never dispatches remote work. */
export class RemoteActivityStore {
  private path: string
  constructor(private root: string) {
    const info = lstatSync(root)
    if (!info.isDirectory() || !isPrivateMode(info) || (process.getuid && info.uid !== process.getuid())) throw new Error('Remote preparation history must use a private directory')
    this.path = join(root, 'activity.json')
  }
  load(): RemoteActivityEntry[] {
    let link
    try { link = lstatSync(this.path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    if (!link.isFile()) throw new Error('Remote preparation history must be a private file')
    const fd = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const info = fstatSync(fd)
      if (!info.isFile() || !isPrivateMode(info) || info.size > MAX_BYTES || (process.getuid && info.uid !== process.getuid())) throw new Error('Remote preparation history must be a bounded private file')
      const value = JSON.parse(readFileSync(fd, 'utf8')) as unknown
      if (!record(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 200) throw new Error('Invalid remote preparation history')
      const entries = value.entries.map(publicEntry)
      if (new Set(entries.map(x => x.operation.id)).size !== entries.length) throw new Error('Duplicate remote preparation identity')
      return entries
    } finally { closeSync(fd) }
  }
  save(entries: RemoteActivityEntry[]): void {
    if (entries.length > 200) throw new Error('Remote preparation history limit exceeded')
    const checked = entries.map(publicEntry)
    if (new Set(checked.map(x => x.operation.id)).size !== checked.length) throw new Error('Duplicate remote preparation identity')
    const body = JSON.stringify({ version: 1, entries: checked })
    if (Buffer.byteLength(body) > MAX_BYTES) throw new Error('Remote preparation history limit exceeded')
    const temporary = join(this.root, `activity.${randomUUID()}.tmp`)
    let created = false
    try {
      const fd = openSync(temporary, 'wx', 0o600); created = true
      try { writeFileSync(fd, body); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temporary, this.path); created = false
      if (process.platform !== 'win32') {
        const dir = openSync(this.root, constants.O_RDONLY)
        try { fsyncSync(dir) } finally { closeSync(dir) }
      }
    } finally { if (created) try { unlinkSync(temporary) } catch {} }
  }
}
