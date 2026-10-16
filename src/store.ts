/**
 * Host config store: one JSON file (`$DSH_HOME/dsh-ssh.json`, defaulting
 * to `~/.dsh`) holding every
 * SSH host entry, written atomically (tmp + rename). Also parses the user's
 * standard `~/.ssh/config` for one-shot import. Secrets (passwords,
 * passphrases) live in this user-owned file in plaintext — same trust model
 * as ssh-skill's annotated ssh-config comments; document it, never log it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { dshHome } from './dsh-home.ts'
import type { HostPayload, ImportPreview, ImportResult, ImportSkipBlock, ImportSkipReason, SshHostEntry, SshHostSummary } from './protocol.ts'
import { readSshConfigBlocks } from './ssh-config.ts'

/** File format version. */
const FORMAT_VERSION = 1

/** Store file location: $DSH_HOME/dsh-ssh.json (defaults to ~/.dsh). */
export function storePath(): string {
  return join(dshHome(), 'dsh-ssh.json')
}

/** The user's standard OpenSSH config path. */
export function sshConfigPath(): string {
  return join(homedir(), '.ssh', 'config')
}

interface StoreFile {
  version: number
  hosts: SshHostEntry[]
}

/** Validate the wire shape of a host payload; returns a message or undefined. */
export function validateHostPayload(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return 'body must be a JSON object'
  const p = payload as Record<string, unknown>
  if (typeof p.host !== 'string' || p.host.trim() === '') return 'host is required'
  if (typeof p.user !== 'string' || p.user.trim() === '') return 'user is required'
  const auth = p.auth as Record<string, unknown> | undefined
  if (auth !== undefined) {
    if (typeof auth !== 'object' || auth === null) return 'auth must be an object'
    if (auth.kind !== 'key' && auth.kind !== 'password' && auth.kind !== 'agent') return 'auth.kind must be key, password or agent'
    if (auth.kind === 'key' && (typeof auth.keyPath !== 'string' || auth.keyPath.trim() === '')) {
      return 'auth.keyPath is required for key auth'
    }
    if (auth.password !== undefined && typeof auth.password !== 'string') {
      return 'auth.password must be a string when provided'
    }
    if (auth.rememberPassword !== undefined && typeof auth.rememberPassword !== 'boolean') return 'auth.rememberPassword must be a boolean'
    if (auth.kind === 'agent' && auth.agentPath !== undefined && typeof auth.agentPath !== 'string') {
      return 'auth.agentPath must be a string when provided'
    }
  }
  if (p.port !== undefined && (typeof p.port !== 'number' || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535)) {
    return 'port must be an integer in 1..65535'
  }
  if (p.proxyJump !== undefined && (!Array.isArray(p.proxyJump) || p.proxyJump.some(x => typeof x !== 'string' || x === ''))) {
    return 'proxyJump must be an array of alias strings'
  }
  if (p.proxyCommand !== undefined && typeof p.proxyCommand !== 'string') {
    return 'proxyCommand must be a string when provided'
  }
  // OpenSSH resolves ProxyCommand and ProxyJump by "whichever appears first in
  // the config"; a stored entry has no order, so the combination is rejected
  // instead of silently picking one transport.
  const proxyCommand = typeof p.proxyCommand === 'string' ? normalizeProxyCommand(p.proxyCommand) : undefined
  const proxyJump = Array.isArray(p.proxyJump) ? p.proxyJump as string[] : []
  if (proxyCommand !== undefined && proxyJump.length > 0) {
    return 'proxyCommand and proxyJump cannot be combined — pick one transport per host'
  }
  if (p.tags !== undefined && (!Array.isArray(p.tags) || p.tags.some(x => typeof x !== 'string'))) {
    return 'tags must be an array of strings'
  }
  return undefined
}

/** Alias grammar: letters/digits plus dots, hyphens, underscores (IP/domain aliases included). */
const ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** Validate an alias for creation. */
export function validateAlias(alias: string): string | undefined {
  if (!ALIAS_RE.test(alias)) return 'alias must be letters, digits, dots, hyphens or underscores'
  return undefined
}

/**
 * The host store. Pure file I/O — no cordis dependency, unit-testable.
 */
export class HostStore {
  private readonly sessionPasswords = new Map<string, { updatedAt: number; host: string; port: number; user: string; password: string }>()

  /** Session credentials never enter the parsed file cache or its serialized copy. */
  private withSessionPassword(entry: SshHostEntry): SshHostEntry {
    const saved = this.sessionPasswords.get(entry.alias)
    if (saved === undefined) return entry
    if (saved.updatedAt !== entry.updatedAt || saved.host !== entry.host || saved.port !== entry.port || saved.user !== entry.user) {
      this.sessionPasswords.delete(entry.alias)
      return entry
    }
    return { ...entry, auth: { ...entry.auth, password: saved.password, rememberPassword: false } }
  }

  private keepSessionPassword(entry: SshHostEntry, password: string | undefined, remember: boolean): void {
    this.sessionPasswords.delete(entry.alias)
    if (password !== undefined && password !== '' && !remember) {
      this.sessionPasswords.set(entry.alias, { updatedAt: entry.updatedAt, host: entry.host, port: entry.port, user: entry.user, password })
    }
  }

  /** Plugin shutdown discards credentials that were not explicitly remembered. */
  clearSessionPasswords(): void { this.sessionPasswords.clear() }

  /** The JSON file path. */
  readonly path: string
  /** Optional override of the ~/.ssh/config path (tests). */
  private readonly sshConfigOverride: string | undefined

  /**
   * @param path - store file path (defaults to the standard location).
   * @param sshConfigOverride - ssh config path override (tests only).
   */
  constructor(path?: string, sshConfigOverride?: string) {
    this.path = resolve(path ?? storePath())
    this.sshConfigOverride = sshConfigOverride
  }

  /** Load all entries (empty store when the file is absent). */
  list(): SshHostEntry[] {
    const file = this.load()
    return this.sessionPasswords.size ? file.hosts.map(entry => this.withSessionPassword(entry)) : file.hosts
  }

  /** Find one entry by alias. */
  find(alias: string): SshHostEntry | undefined {
    return this.list().find(entry => entry.alias === alias)
  }

  /** Secret-free projection for the browser and agent surfaces. */
  summarize(entry: SshHostEntry): SshHostSummary {
    entry = this.withSessionPassword(entry)
    let keyReady = true
    if (entry.auth.kind === 'key' && entry.auth.keyPath) {
      keyReady = existsSync(expandHome(entry.auth.keyPath))
    } else if (entry.auth.kind === 'agent') {
      keyReady = false
    }
    return {
      alias: entry.alias,
      host: entry.host,
      port: entry.port,
      user: entry.user,
      auth: entry.auth.kind,
      passwordAvailable: Boolean(entry.auth.password),
      passwordRemembered: Boolean(entry.auth.password) && entry.auth.rememberPassword !== false,
      keyReady,
      proxyJump: [...entry.proxyJump],
      ...(entry.proxyCommand !== undefined ? { proxyCommand: entry.proxyCommand } : {}),
      // Optional fields are spread conditionally: the tool bridge rejects
      // undefined-valued properties as non-lossless JSON.
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      ...(entry.environment !== undefined ? { environment: entry.environment } : {}),
      tags: [...entry.tags],
      ...(entry.location !== undefined ? { location: entry.location } : {}),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }
  }

  /** Create one entry. Throws on alias collision or invalid payload. */
  create(payload: HostPayload): SshHostEntry {
    const alias = payload.alias?.trim()
    if (!alias) throw new Error('alias is required')
    const aliasError = validateAlias(alias)
    if (aliasError !== undefined) throw new Error(aliasError)
    const bodyError = validateHostPayload(payload)
    if (bodyError !== undefined) throw new Error(bodyError)
    if (payload.auth === undefined) throw new Error('auth is required')
    const file = this.load()
    if (file.hosts.some(entry => entry.alias === alias)) throw new Error(`alias '${alias}' already exists`)
    const now = Date.now()
    const entry: SshHostEntry = {
      alias,
      host: payload.host.trim(),
      port: payload.port ?? 22,
      user: payload.user.trim(),
      auth: {
        kind: payload.auth.kind,
        keyPath: payload.auth.kind === 'key' ? expandHome(payload.auth.keyPath?.trim() ?? '') : undefined,
        passphrase: payload.auth.kind === 'key' ? payload.auth.passphrase ?? undefined : undefined,
        password: payload.auth.rememberPassword === false ? undefined : payload.auth.password || undefined,
        agentPath: payload.auth.kind === 'agent' ? normalizeAgentPath(payload.auth.agentPath) : undefined,
      },
      proxyJump: [...(payload.proxyJump ?? [])],
      proxyCommand: normalizeProxyCommand(payload.proxyCommand),
      description: payload.description?.trim() || undefined,
      environment: payload.environment?.trim() || undefined,
      tags: [...(payload.tags ?? [])].map(tag => tag.trim()).filter(tag => tag !== ''),
      location: payload.location?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    }
    file.hosts.push(entry)
    this.save(file)
    this.keepSessionPassword(entry, payload.auth.password, payload.auth.rememberPassword !== false)
    return this.withSessionPassword(entry)
  }

  /** Update the fields present in `patch`; unknown aliases throw. */
  update(alias: string, patch: Partial<HostPayload>): SshHostEntry {
    const file = this.load()
    const index = file.hosts.findIndex(candidate => candidate.alias === alias)
    const stored = file.hosts[index]
    if (stored === undefined) throw new Error(`alias '${alias}' not found`)
    // Validate and assemble a copy: a rejected edit must not change the cache.
    const entry = { ...stored, auth: { ...stored.auth } }
    const currentAuth = this.withSessionPassword(entry).auth
    const identityChanged = (typeof patch.host === 'string' && patch.host.trim() !== entry.host)
      || (typeof patch.user === 'string' && patch.user.trim() !== entry.user)
      || (patch.port !== undefined && patch.port !== entry.port)
    const password = patch.auth?.password !== undefined ? patch.auth.password || undefined
      : identityChanged && currentAuth.rememberPassword === false ? undefined : currentAuth.password
    const rememberPassword = patch.auth?.rememberPassword ?? (currentAuth.rememberPassword !== false)
    // Partial-patch validation: only the present fields are checked (a
    // caller may update just tags without resending host/user).
    if (patch.host !== undefined && (typeof patch.host !== 'string' || patch.host.trim() === '')) {
      throw new Error('host is required')
    }
    if (patch.user !== undefined && (typeof patch.user !== 'string' || patch.user.trim() === '')) {
      throw new Error('user is required')
    }
    if (patch.port !== undefined && (typeof patch.port !== 'number' || !Number.isInteger(patch.port) || patch.port < 1 || patch.port > 65535)) {
      throw new Error('port must be an integer in 1..65535')
    }
    if (patch.proxyJump !== undefined && (!Array.isArray(patch.proxyJump) || patch.proxyJump.some(x => typeof x !== 'string' || x === ''))) {
      throw new Error('proxyJump must be an array of alias strings')
    }
    if (patch.proxyCommand !== undefined && typeof patch.proxyCommand !== 'string') {
      throw new Error('proxyCommand must be a string when provided')
    }
    // The mutual exclusion is checked on the MERGED view: a patch that only
    // adds one transport must not slip past a stored value of the other.
    const mergedProxyCommand = patch.proxyCommand !== undefined
      ? normalizeProxyCommand(patch.proxyCommand)
      : entry.proxyCommand
    if (mergedProxyCommand !== undefined && (patch.proxyJump ?? entry.proxyJump).length > 0) {
      throw new Error('proxyCommand and proxyJump cannot be combined — pick one transport per host')
    }
    if (patch.tags !== undefined && (!Array.isArray(patch.tags) || patch.tags.some(x => typeof x !== 'string'))) {
      throw new Error('tags must be an array of strings')
    }
    if (patch.host !== undefined) entry.host = patch.host.trim()
    if (patch.port !== undefined) entry.port = patch.port
    if (patch.user !== undefined) entry.user = patch.user.trim()
    if (patch.auth !== undefined) {
      const auth = patch.auth
      if (auth.kind !== 'key' && auth.kind !== 'password' && auth.kind !== 'agent') throw new Error('auth.kind must be key, password or agent')
      if (auth.kind === 'key' && ((auth.keyPath !== undefined && (typeof auth.keyPath !== 'string' || auth.keyPath.trim() === ''))
        || (auth.keyPath === undefined && (entry.auth.kind !== 'key' || !entry.auth.keyPath)))) {
        throw new Error('auth.keyPath is required for key auth')
      }
      if (auth.password !== undefined && typeof auth.password !== 'string') {
        throw new Error('auth.password must be a string when provided')
      }
      if (auth.rememberPassword !== undefined && typeof auth.rememberPassword !== 'boolean') throw new Error('auth.rememberPassword must be a boolean')
      if (auth.kind === 'agent' && auth.agentPath !== undefined && typeof auth.agentPath !== 'string') {
        throw new Error('auth.agentPath must be a string when provided')
      }
      // A changed key path with no passphrase means the new key has none;
      // only keep the old passphrase when the key path is unchanged.
      const keyChanged = auth.kind === 'key'
        && auth.keyPath !== undefined
        && expandHome(auth.keyPath.trim()) !== entry.auth.keyPath
      entry.auth = {
        kind: auth.kind,
        keyPath: auth.kind === 'key' ? (auth.keyPath === undefined ? entry.auth.keyPath : expandHome(auth.keyPath.trim())) : undefined,
        passphrase: auth.kind === 'key'
          ? (auth.passphrase !== undefined ? auth.passphrase : (keyChanged ? undefined : entry.auth.passphrase))
          : undefined,
        password: rememberPassword ? password : undefined,
        agentPath: auth.kind === 'agent'
          ? (auth.agentPath !== undefined ? normalizeAgentPath(auth.agentPath) : entry.auth.agentPath)
          : undefined,
      }
    }
    if (patch.proxyJump !== undefined) entry.proxyJump = [...patch.proxyJump]
    if (patch.proxyCommand !== undefined) entry.proxyCommand = mergedProxyCommand
    if (patch.description !== undefined) entry.description = patch.description.trim() || undefined
    if (patch.environment !== undefined) entry.environment = patch.environment.trim() || undefined
    if (patch.tags !== undefined) entry.tags = [...patch.tags].map(tag => tag.trim()).filter(tag => tag !== '')
    if (patch.location !== undefined) entry.location = patch.location.trim() || undefined
    entry.updatedAt = Math.max(Date.now(), entry.updatedAt + 1)
    file.hosts[index] = entry
    this.save(file)
    this.keepSessionPassword(entry, password, rememberPassword)
    return this.withSessionPassword(entry)
  }

  /** Remove one entry. */
  delete(alias: string): void {
    const file = this.load()
    const index = file.hosts.findIndex(candidate => candidate.alias === alias)
    if (index < 0) throw new Error(`alias '${alias}' not found`)
    file.hosts.splice(index, 1)
    this.save(file)
    this.sessionPasswords.delete(alias)
  }

  /**
   * Import hosts from `~/.ssh/config`: Host blocks with a single non-wildcard
   * pattern become entries (a missing HostName falls back to the pattern
   * itself; key auth via IdentityFile; jump hosts via ProxyJump; ProxyCommand
   * kept verbatim). `Include` files are expanded, and `Match` blocks,
   * wildcard patterns, and aliases that already exist are skipped with a
   * reason instead of silently disappearing.
   * @returns import statistics.
   */
  private readImportCandidates(): { parsed: number; payloads: HostPayload[]; skippedBlocks: ImportSkipBlock[] } {
    const configPath = this.sshConfigOverride ?? sshConfigPath()
    if (!existsSync(configPath)) return { parsed: 0, payloads: [], skippedBlocks: [] }
    const { blocks, skipped } = readSshConfigBlocks(configPath)
    const skippedBlocks = [...skipped]
    const skip = (name: string, reason: ImportSkipReason): void => {
      if (name === '') return
      if (skippedBlocks.some(block => block.name === name)) return
      skippedBlocks.push({ name, reason })
    }
    const existing = new Set(this.list().map(entry => entry.alias))
    const payloads: HostPayload[] = []
    for (const block of blocks) {
      const pattern = block.pattern.split(/\s+/)[0]
      if (pattern.includes('*') || pattern.includes('?')) {
        skip(pattern, 'wildcard')
        continue
      }
      if (existing.has(pattern) || payloads.some(entry => entry.alias === pattern)) {
        skip(pattern, 'existing')
        continue
      }
      // A block without HostName is a usable OpenSSH entry: the Host pattern
      // itself is the hostname.
      const hostName = block.props.hostname !== undefined && block.props.hostname !== ''
        ? block.props.hostname
        : pattern
      const payload: HostPayload = {
        alias: pattern,
        host: hostName,
        port: block.props.port !== undefined ? Number.parseInt(block.props.port, 10) : 22,
        user: block.props.user ?? process.env.USER ?? 'root',
        auth: {
          kind: block.props.identityfile !== undefined
            ? 'key'
            : block.props.identityagent !== undefined && block.props.identityagent.toLowerCase() !== 'none'
              ? 'agent'
              : 'password',
          keyPath: block.props.identityfile,
          password: block.props.password,
          agentPath: block.props.identityagent !== undefined && block.props.identityagent.toLowerCase() !== 'none'
            ? normalizeAgentPath(block.props.identityagent)
            : undefined,
        },
        proxyJump: block.props.proxyjump !== undefined
          ? block.props.proxyjump.split(',').map(hop => hop.trim()).filter(hop => hop !== '')
          : [],
        proxyCommand: block.props.proxycommand,
        description: block.props.description,
        environment: block.props.environment,
        tags: (block.props.tags ?? '').split(',').map(tag => tag.trim()).filter(tag => tag !== ''),
        location: block.props.location,
      }
      if (validateAlias(pattern) !== undefined || validateHostPayload(payload) !== undefined) {
        skip(pattern, 'invalid')
      } else {
        payloads.push(payload)
      }
    }
    return { parsed: blocks.length, payloads, skippedBlocks }
  }

  /** Read local configuration only: never saves hosts, reads keys or connects. */
  previewSshConfig(): ImportPreview {
    const { parsed, payloads, skippedBlocks } = this.readImportCandidates()
    return {
      parsed, skippedBlocks,
      candidates: payloads.map(payload => ({
        alias: payload.alias!, host: payload.host, port: payload.port ?? 22, user: payload.user,
        auth: payload.auth!.kind, proxyJump: payload.proxyJump ?? [],
        hasProxyCommand: normalizeProxyCommand(payload.proxyCommand ?? '') !== undefined,
      })),
    }
  }

  /** Persist only aliases explicitly chosen by the user; re-read secrets locally. */
  importFromSshConfig(aliases: string[]): ImportResult {
    if (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== 'string' || !alias)) {
      throw new Error('aliases must be an array of selected host aliases')
    }
    const { parsed, payloads, skippedBlocks } = this.readImportCandidates()
    const selected = new Set(aliases)
    for (const alias of selected) {
      if (!payloads.some(payload => payload.alias === alias) && !skippedBlocks.some(block => block.name === alias && block.reason === 'existing')) {
        throw new Error('Selected SSH configuration changed or is unavailable; reopen the host picker')
      }
    }
    let added = 0
    for (const payload of payloads) {
      if (!selected.has(payload.alias!)) continue
      this.create(payload)
      added++
    }
    return { parsed, added, skipped: skippedBlocks.length, skippedBlocks }
  }

  /**
   * Last parsed store keyed by file identity. list/find ride every acquire
   * and GUI refresh; re-reading and re-parsing the whole file each call is
   * wasted work when the file has not changed. Any save invalidates.
   */
  private cache: { mtimeMs: number; size: number; file: StoreFile } | undefined

  private load(): StoreFile {
    let stats: { mtimeMs: number; size: number }
    try {
      stats = statSync(this.path)
    } catch {
      this.cache = undefined
      return { version: FORMAT_VERSION, hosts: [] }
    }
    if (this.cache !== undefined && this.cache.mtimeMs === stats.mtimeMs && this.cache.size === stats.size) {
      return this.cache.file
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StoreFile
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.hosts)) {
        throw new Error('store file shape invalid')
      }
      this.cache = { mtimeMs: stats.mtimeMs, size: stats.size, file: parsed }
      return parsed
    } catch {
      // A corrupt store must not brick the plugin — and must not be silently
      // overwritten by the next save: rename it aside for manual recovery
      // (the plugin then starts from an empty list).
      this.cache = undefined
      try {
        renameSync(this.path, `${this.path}.corrupt-${Date.now()}`)
      } catch { /* best effort */ }
      return { version: FORMAT_VERSION, hosts: [] }
    }
  }

  private save(file: StoreFile): void {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = this.path + '.tmp'
    // Secrets live in this file: keep it readable by the owner only. The
    // tmp file carries the 0600 mode through the rename.
    writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.path)
    this.cache = undefined
  }
}

/** Normalize an agent endpoint for storage: trim, expand `~`, and resolve the SSH_AUTH_SOCK token. */
export function normalizeAgentPath(agentPath: string | undefined): string | undefined {
  const trimmed = agentPath?.trim()
  if (trimmed === undefined || trimmed === '') return undefined
  if (trimmed === 'SSH_AUTH_SOCK' || trimmed === '$SSH_AUTH_SOCK') {
    const sock = process.env.SSH_AUTH_SOCK
    return sock !== undefined && sock !== '' ? sock : undefined
  }
  return expandHome(trimmed)
}

/**
 * Normalize a ProxyCommand for storage: trim, and treat an empty value or
 * OpenSSH's `none` keyword as "no proxy command" (an explicit clear).
 */
export function normalizeProxyCommand(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim()
  if (trimmed === undefined || trimmed === '') return undefined
  if (trimmed.toLowerCase() === 'none') return undefined
  return trimmed
}

/** Expand a leading `~` in a filesystem path. */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}
