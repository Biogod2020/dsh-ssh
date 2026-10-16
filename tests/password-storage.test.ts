import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostStore, validateHostPayload } from '../src/store.ts'
import { SshEngine } from '../src/engine.ts'
import type { HostPayload } from '../src/protocol.ts'

const directories: string[] = []
const payload = (auth: HostPayload['auth']): HostPayload => ({ alias: 'fixture', host: 'fixture.test', user: 'tester', auth })
function fixture(): HostStore {
  const directory = mkdtempSync(join(tmpdir(), 'ssh-password-store-')); directories.push(directory)
  return new HostStore(join(directory, 'hosts.json'), join(directory, 'ssh_config'))
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('password lifetime and fallback storage', () => {
  it('keeps an unremembered fallback in memory through unrelated saves, never in the file or browser summary', () => {
    const store = fixture()
    store.create(payload({ kind: 'key', keyPath: '/fixture/key', password: 'session-only-secret', rememberPassword: false }))
    expect(store.find('fixture')?.auth.password).toBe('session-only-secret')
    store.update('fixture', { tags: ['updated'] })
    store.create({ ...payload({ kind: 'password', password: 'other' }), alias: 'other' })
    expect(readFileSync(store.path, 'utf8')).not.toContain('session-only-secret')
    const summary = store.summarize(store.find('fixture')!)
    expect(summary).toMatchObject({ auth: 'key', passwordAvailable: true, passwordRemembered: false })
    expect(JSON.stringify(summary)).not.toContain('session-only-secret')
    expect(new HostStore(store.path).find('fixture')?.auth.password).toBeUndefined()
    const engine = new SshEngine(store); engine.dispose()
    expect(store.find('fixture')?.auth.password).toBeUndefined()
  })

  it.each(['key', 'agent'] as const)('persists an explicitly remembered %s fallback with owner-only permissions', kind => {
    const store = fixture()
    store.create(payload({ kind, keyPath: kind === 'key' ? '/fixture/key' : undefined, password: 'remembered', rememberPassword: true }))
    const reloaded = new HostStore(store.path)
    expect(reloaded.find('fixture')?.auth.password).toBe('remembered')
    expect(reloaded.summarize(reloaded.find('fixture')!)).toMatchObject({ passwordAvailable: true, passwordRemembered: true })
    expect(statSync(store.path).mode & 0o777).toBe(0o600)
  })

  it('edits a fallback without resending the private key path or passphrase, and toggles remember both ways', () => {
    const store = fixture()
    store.create(payload({ kind: 'key', keyPath: '/fixture/key', passphrase: 'fixture-passphrase' }))
    const updated = store.update('fixture', { auth: { kind: 'key', password: 'fallback', rememberPassword: false } })
    expect(updated.auth).toMatchObject({ kind: 'key', keyPath: '/fixture/key', passphrase: 'fixture-passphrase', password: 'fallback' })
    store.update('fixture', { auth: { kind: 'key', rememberPassword: true } })
    expect(new HostStore(store.path).find('fixture')?.auth.password).toBe('fallback')
    store.update('fixture', { auth: { kind: 'key', rememberPassword: false } })
    expect(new HostStore(store.path).find('fixture')?.auth.password).toBeUndefined()
    expect(store.find('fixture')?.auth.password).toBe('fallback')
    store.update('fixture', { auth: { kind: 'key', password: '' } })
    expect(store.find('fixture')?.auth.password).toBeUndefined()
    expect(store.summarize(store.find('fixture')!).passwordAvailable).toBe(false)
  })

  it.each([{ host: 'different.test' }, { user: 'different' }, { port: 2222 }])('does not carry a session password to a changed endpoint: %j', patch => {
    const store = fixture()
    store.create(payload({ kind: 'password', password: 'session-only', rememberPassword: false }))
    store.update('fixture', patch)
    expect(store.find('fixture')?.auth.password).toBeUndefined()
  })

  it('drops a session password after an external edit or delete/recreate', () => {
    const store = fixture()
    store.create(payload({ kind: 'password', password: 'session-only', rememberPassword: false }))
    const disk = JSON.parse(readFileSync(store.path, 'utf8'))
    disk.hosts[0].updatedAt += 1000
    writeFileSync(store.path, JSON.stringify(disk))
    expect(store.find('fixture')?.auth.password).toBeUndefined()
    store.update('fixture', { auth: { kind: 'password', password: 'new-session', rememberPassword: false } })
    store.delete('fixture'); store.create(payload({ kind: 'password' }))
    expect(store.find('fixture')?.auth.password).toBeUndefined()
  })

  it('rejects malformed fallback fields without mutating the loaded entry', () => {
    const store = fixture(); store.create(payload({ kind: 'key', keyPath: '/fixture/key' }))
    expect(validateHostPayload(payload({ kind: 'key', keyPath: '/fixture/key', password: 123 as never }))).toContain('password')
    expect(validateHostPayload(payload({ kind: 'agent', rememberPassword: 'yes' as never }))).toContain('rememberPassword')
    expect(() => store.update('fixture', { host: 'changed.test', auth: { kind: 'key', password: 123 as never } })).toThrow('password')
    expect(store.find('fixture')?.host).toBe('fixture.test')
  })
})
