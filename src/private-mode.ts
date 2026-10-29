/**
 * Whether a stat result records owner-only access.
 *
 * The check reads POSIX permission bits, which Windows does not implement:
 * a file created with `mode: 0o600` still reports `0o666` through `fs.stat`,
 * so a raw `mode & 0o077` test rejects every file the plugin itself just
 * created. The recovery key check runs while the Host half mounts, so on
 * Windows that assertion alone makes the whole plugin fail to start
 * ("Remote recovery key must be a private file").
 *
 * On Windows the equivalent protection is the NTFS ACL inherited from the DSH
 * home (by default inside the user profile), so the mode assertion is skipped
 * there instead of failing closed on every entry. POSIX hosts keep the strict
 * owner-only test unchanged.
 */

/** Minimal stat shape the permission check needs. */
export interface StatMode {
  mode: number
}

/**
 * Decide whether an entry is private for the requested platform.
 * @param info - `lstat`/`stat` result carrying the platform mode bits.
 * @param platform - platform to evaluate; the seam tests use for Windows.
 * @returns true when the entry has owner-only POSIX bits, or when the platform
 *   does not expose POSIX bits at all (Windows).
 */
export function isPrivateMode(info: StatMode, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || (info.mode & 0o077) === 0
}
