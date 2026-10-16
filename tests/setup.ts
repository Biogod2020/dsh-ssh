import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { DEFAULT_KNOWN_HOSTS } from '../src/engine/known-hosts.ts'

// Each worker trusts ONLY its generated fixture keys, never the user's files.
const directory = mkdtempSync(join(tmpdir(), 'dsh-ssh-trust-test-'))
DEFAULT_KNOWN_HOSTS.splice(0, DEFAULT_KNOWN_HOSTS.length, join(directory, 'known_hosts'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
