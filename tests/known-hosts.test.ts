import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ConnectConfig } from 'ssh2'
import { hostKeyFailure, installHostVerifier } from '../src/engine/known-hosts.ts'

const dir = mkdtempSync(join(tmpdir(), 'known-hosts-cases-'))
const path = join(dir, 'known_hosts')
const key = Buffer.from('fixture ssh public-key blob')
const encoded = key.toString('base64')
afterAll(() => rmSync(dir, { recursive: true, force: true }))
function check(lines: string, host = 'server.test', port = 22, presented = key) {
  writeFileSync(path, lines)
  const config: ConnectConfig = { host, port }
  installHostVerifier(config, [path])
  const ok = (config.hostVerifier as (key: Buffer) => boolean)(presented)
  return { ok, error: hostKeyFailure(config)?.message }
}
describe('strict OpenSSH known_hosts', () => {
  it('accepts an exact pinned public key', () => expect(check(`server.test ssh-ed25519 ${encoded}`).ok).toBe(true))
  it('refuses unknown keys', () => expect(check('').error).toContain('UNKNOWN'))
  it('refuses changed keys', () => expect(check(`server.test ssh-ed25519 ${encoded}`, 'server.test', 22, Buffer.from('other')).error).toContain('MISMATCH'))
  it('matches non-default ports exactly', () => {
    expect(check(`[server.test]:2222 ssh-ed25519 ${encoded}`, 'server.test', 2222).ok).toBe(true)
    expect(check(`[server.test]:2222 ssh-ed25519 ${encoded}`).ok).toBe(false)
  })
  it('accepts hashed hostnames', () => {
    const salt = Buffer.from('test salt')
    const hash = createHmac('sha1', salt).update('[server.test]:2222').digest('base64')
    expect(check(`|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${encoded}`, 'server.test', 2222).ok).toBe(true)
  })
  it('supports wildcard, negation and multiple hostnames', () => {
    expect(check(`!server.test,*.test ssh-ed25519 ${encoded}`).ok).toBe(false)
    expect(check(`other.test,*.test ssh-ed25519 ${encoded}`).ok).toBe(true)
  })
  it('rejects revoked keys even if another line trusts them', () => {
    expect(check(`server.test ssh-ed25519 ${encoded}\n@revoked server.test ssh-ed25519 ${encoded}`).error).toContain('REVOKED')
  })
  it('does not mistake a CA for a directly trusted host key', () => expect(check(`@cert-authority server.test ssh-ed25519 ${encoded}`).ok).toBe(false))
  it('matches IPv6 literals at non-default ports', () => expect(check(`[::1]:2222 ssh-ed25519 ${encoded}`, '::1', 2222).ok).toBe(true))
  it('fails closed when a trust file cannot be read', () => expect(() => installHostVerifier({ host: 'server.test' }, [dir])).toThrow(/Cannot read/))
})
