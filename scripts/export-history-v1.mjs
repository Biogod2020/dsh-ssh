import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

// Explicit offline downgrade export. No default HOME discovery, service stop,
// automatic restoration or copying of SSH/model credentials.
const [root,target] = process.argv.slice(2)
if (!root || !target) throw new Error('Usage: node --experimental-transform-types scripts/export-history-v1.mjs HISTORY_DIRECTORY NEW_EXPORT_DIRECTORY. Fully exit DSH writers first.')
const {SegmentedHistoryCache}=await import(pathToFileURL(resolve(import.meta.dirname,'../src/remote/history-store.ts')).href)
const {RemoteHistoryCache}=await import(pathToFileURL(resolve(import.meta.dirname,'../src/remote/history-cache.ts')).href)
const cache=new SegmentedHistoryCache(resolve(root))
try {
  const initial=await cache.list();if(initial.warning)throw new Error('History storage reported an issue; inspect it before downgrade')
  await cache.exportV1(resolve(target))
  const source=await cache.list()
  const exported=new RemoteHistoryCache(resolve(target)), status=await exported.list()
  if(status.warning||status.entries.length!==source.entries.length)throw new Error('Export verification failed; source storage was preserved')
  const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
  let records=0
  for(const entry of source.entries) {
    const a=await cache.read(entry.key), b=await exported.read(entry.key)
    if(!a||!b||hash(a.records)!==hash(b.records)||a.meta.firstSavedAt!==b.meta.firstSavedAt||a.meta.cursor!==b.meta.cursor)throw new Error('Export content verification failed; source storage was preserved')
    records+=a.records.length
  }
  console.log(JSON.stringify({verified:true,sessions:source.entries.length,records,historyRecordsUnchanged:true,automaticRestore:false}))
} finally {await cache.close()}
