/** Local fork: fail-closed OpenSSH known_hosts verification; never learns keys. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ConnectConfig } from 'ssh2'

export const DEFAULT_KNOWN_HOSTS = [join(homedir(), '.ssh', 'known_hosts'), '/etc/ssh/ssh_known_hosts']
const failure = Symbol('host-key-verification-failure')
type VerifiedConfig = ConnectConfig & { [failure]?: () => Error | undefined }

export function hostKeyFailure(config: ConnectConfig): Error | undefined {
  return (config as VerifiedConfig)[failure]?.()
}

function matches(pattern: string, host: string): boolean {
  if (pattern.startsWith('|')) {
    const parts = pattern.split('|')
    if (parts.length !== 4 || parts[1] !== '1') return false
    const expected = Buffer.from(parts[3], 'base64')
    const actual = createHmac('sha1', Buffer.from(parts[2], 'base64')).update(host).digest()
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp('^' + escaped + '$', 'i').test(host)
}

function matchesHosts(patterns: string, host: string): boolean {
  const values = patterns.split(',')
  if (values.some(p => p.startsWith('!') && matches(p.slice(1), host))) return false
  return values.some(p => !p.startsWith('!') && matches(p, host))
}

/** Install verification before authentication, for target AND every jump host. */
export function installHostVerifier(config: ConnectConfig, paths: readonly string[]): void {
  const host = String(config.host).toLowerCase()
  const address = (config.port ?? 22) === 22 ? host : `[${host}]:${config.port}`
  const records = paths.flatMap(path => {
    let text: string
    try { text = readFileSync(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error('Cannot read SSH known_hosts; refusing connection', { cause: error })
    }
    return text.split(/\r?\n/).flatMap(line => {
      const fields = line.trim().split(/\s+/)
      if (fields[0]?.startsWith('#') || fields.length < 3) return []
      const marker = fields[0].startsWith('@') ? fields.shift() : undefined
      if (fields.length < 3 || !matchesHosts(fields[0], address)) return []
      return [{ marker, key: Buffer.from(fields[2], 'base64') }]
    })
  })
  let error: Error | undefined
  ;(config as VerifiedConfig)[failure] = () => error
  // Do not set hostHash: comparing the complete SSH public-key blob is exact.
  config.hostVerifier = (key: Buffer): boolean => {
    const same = records.filter(row => row.key.length === key.length && timingSafeEqual(row.key, key))
    const revoked = same.some(row => row.marker === '@revoked')
    if (!revoked && same.some(row => row.marker === undefined)) return true
    const reason = revoked ? 'REVOKED' : records.length > 0 ? 'MISMATCH (or unsupported host certificate)' : 'UNKNOWN'
    const fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
    error = new Error(`SSH host key ${reason} for ${address}; presented ${fingerprint}. Connection refused before authentication. Verify the fingerprint with the server administrator, then establish trust using OpenSSH. This plugin never auto-accepts or overwrites known_hosts.`)
    return false
  }
}
