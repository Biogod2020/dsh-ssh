import { lstat, opendir } from 'node:fs/promises'
import { join } from 'node:path'
import type { HistoryStorageAudit } from './history-cache.ts'
import { isPrivateMode } from '../private-mode.ts'

/** Observe file sizes, never history contents. This is a read-only, bounded
 * inventory, not a deletion plan or a measurement of unique physical blocks
 * (sparse files, clones and hard links can differ). No paths leave this helper. */
export async function auditHistoryFiles(root: string, references: ReadonlyMap<string, number | undefined>,
  stopped: () => boolean = () => false): Promise<HistoryStorageAudit> {
  const report: HistoryStorageAudit = { observedAt: Date.now(), fileBytes: 0, files: 0, unreferencedBytes: 0,
    skipped: 0, incomplete: false, stale: false, byKey: {} }
  let visited = 0
  const scan = async (parts: string[]): Promise<void> => {
    if (stopped() || visited >= 200000 || parts.length > 8) { report.incomplete = true; return }
    const path = join(root, ...parts)
    try {
      const info = await lstat(path)
      ++visited
      if (!isPrivateMode(info) || info.isSymbolicLink()) { ++report.skipped; report.incomplete = true; return }
      if (info.isDirectory()) {
        const directory = await opendir(path)
        for await (const entry of directory) {
          if (stopped() || visited >= 200000) { report.incomplete = true; break }
          await scan([...parts, entry.name])
        }
      } else if (info.isFile()) {
        const name = parts.join('/'), known = references.has(name)
          || /^v2\/(?:control\.json|writer\.lock|recovery\.lock|owner-[a-f0-9-]+\.tmp)$/.test(name) || name === 'index.json'
        const used = references.get(name)
        const extra = known ? typeof used === 'number' ? Math.max(0, info.size - used) : 0 : info.size
        report.files++; report.fileBytes += info.size; report.unreferencedBytes += extra
        const key = /^[a-f0-9]{64}\.json$/.test(parts[0] ?? '') ? parts[0]!.slice(0, -5)
          : parts[0] === 'v2' && /^[a-f0-9]{64}$/.test(parts[1] ?? '') ? parts[1] : undefined
        if (key) {
          const row = report.byKey[key] ??= { fileBytes: 0, files: 0, unreferencedBytes: 0 }
          row.fileBytes += info.size; row.files++; row.unreferencedBytes += extra
        }
      } else { ++report.skipped; report.incomplete = true }
    } catch { ++report.skipped; report.incomplete = true }
  }
  await scan([])
  report.observedAt = Date.now()
  return report
}
