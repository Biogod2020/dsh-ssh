import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { REMOTE_DSH_VERSION, REMOTE_DSH_INTEGRITY, REMOTE_DSH_VERSIONS } from '../src/remote/types.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-preflight-')); roots.push(home)
  const bin = join(home, 'bin'), root = join(home, 'runtime'); mkdirSync(bin)
  const command = (name: string, source: string) => writeFileSync(join(bin, name), '#!/bin/sh\n' + source + '\n', { mode: 0o700 })
  command('uname', 'case "$1" in -s) echo Linux;; -m) echo x86_64;; -r) echo 5.15.0;; esac')
  command('getconf', 'echo "glibc 2.35"')
  command('node', 'exit 1')
  command('df', 'printf "Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 9000000 1 8999999 1%% /\\n"')
  command('curl', 'printf bad-archive > "${10}"')
  const run = () => spawnSync('/bin/sh', [new URL('../assets/remote-install.sh', import.meta.url).pathname, root,
    REMOTE_DSH_VERSION, REMOTE_DSH_INTEGRITY, REMOTE_DSH_VERSIONS.join('|')], {
    encoding: 'utf8', env: { HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` }, timeout: 15000,
  })
  return { home, root, bin, command, run }
}
it('rejects unsupported machines before downloading or changing releases', () => {
  const f = fixture(); f.command('uname', 'case "$1" in -s) echo FreeBSD;; -m) echo x86_64;; esac')
  const result = f.run(); expect(result.status).not.toBe(0)
  expect(result.stdout).toContain('Unsupported operating system')
  expect(existsSync(f.root)).toBe(false)
})
it('rejects old libc and insufficient disk before attempting installation', () => {
  const f = fixture(); f.command('getconf', 'echo "glibc 2.17"')
  expect(f.run().stdout).toContain('glibc 2.28')
  expect(existsSync(join(f.root, 'node'))).toBe(false)
  f.command('df', 'printf "Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 100 99 1 99%% /\\n"')
  expect(f.run().stdout).toContain('1 GiB')
})
it('preserves another install owner and rejects a symlinked installation root', () => {
  const f = fixture(); mkdirSync(join(f.root, 'install.lock'), { recursive: true }); writeFileSync(join(f.root, 'install.lock/pid'), '123')
  expect(f.run().stdout).toContain('active or interrupted')
  expect(existsSync(join(f.root, 'install.lock/pid'))).toBe(true)
  const other = fixture(); symlinkSync(f.root, other.root)
  expect(other.run().stdout).toContain('must not be a symlink')
})
it('never activates a Node archive whose checksum does not match the pinned release', () => {
  const f = fixture()
  f.command('curl', 'while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; printf bad-archive > "$1"; exit 0; fi; shift; done; exit 1')
  const result = f.run()
  expect(result.stdout).toContain('Node checksum mismatch')
  expect(existsSync(join(f.root, 'node'))).toBe(false)
  expect(existsSync(join(f.root, 'releases'))).toBe(false)
  expect(existsSync(join(f.root, 'install.lock'))).toBe(false)
})

it.each(REMOTE_DSH_VERSIONS)('reuses tested DSH %s without downloading and reports the actual installed version', version => {
    const f = fixture()
    f.command('node', `exec '${process.execPath}' "$@"`)
    f.command('dsh', `echo '${version}'`)
    f.command('curl', 'exit 99')
    const result = f.run()
    expect(result.status).toBe(0)
    const receipt = JSON.parse(result.stdout.split('DSH_INSTALL:')[1])
    expect(receipt.version).toBe(version)
    expect(receipt.root).toBe(f.root)
    expect(existsSync(join(f.root, 'releases'))).toBe(false)
})

it('rejects an unverified DSH archive before dependency installation or activation', () => {
  const f = fixture()
  f.command('node', `exec '${process.execPath}' "$@"`)
  f.command('dsh', 'echo unreviewed-release')
  f.command('npm', 'exit 99')
  f.command('curl', 'while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; printf bad-archive > "$1"; exit 0; fi; shift; done; exit 1')
  const result = f.run()
  expect(result.status).not.toBe(0)
  expect(result.stdout).toContain('DSH checksum mismatch')
  expect(existsSync(join(f.root, 'releases', REMOTE_DSH_VERSION))).toBe(false)
})
