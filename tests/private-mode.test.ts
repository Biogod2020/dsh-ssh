import { describe, expect, it } from 'vitest'
import { isPrivateMode } from '../src/private-mode.ts'

describe('isPrivateMode', () => {
  it('accepts owner-only POSIX modes', () => {
    expect(isPrivateMode({ mode: 0o100600 }, 'linux')).toBe(true)
    expect(isPrivateMode({ mode: 0o100400 }, 'linux')).toBe(true)
    expect(isPrivateMode({ mode: 0o040700 }, 'linux')).toBe(true)
  })

  it('rejects any group or other access on POSIX', () => {
    for (const mode of [0o100644, 0o100660, 0o100604, 0o100777, 0o040755]) {
      expect(isPrivateMode({ mode }, 'darwin')).toBe(false)
    }
  })

  it('accepts every Windows mode because NTFS has no POSIX permission bits', () => {
    // fs.stat reports 0o666 for a file created with mode 0o600 on Windows;
    // the recovery-key check runs while the Host half mounts, so failing here
    // makes the whole plugin show "failed to start".
    for (const mode of [0o100666, 0o100777, 0o100444]) {
      expect(isPrivateMode({ mode }, 'win32')).toBe(true)
    }
  })
})
