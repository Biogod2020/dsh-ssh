import { expect, it, vi } from 'vitest'
import { createOperationLedger } from '../src/remote/operation-ledger.ts'
import { ViewReceiptStore } from '../src/remote/view-receipts.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

it('does not turn missing startup coverage into zero pending requests', () => {
  const ledger = createOperationLedger(), token = ledger.freeze()
  expect(ledger.inspection()).toMatchObject({ coverage: 'unknown', pendingRequests: null, unconfirmedOperations: null })
  expect(ledger.commitRelease(token)).toBe(false)
})

it('rejects absent or non-string tokens rather than matching an unfrozen owner', async () => {
  for (const token of [undefined,null,'',0,false,{}]) {
    const ledger=createOperationLedger();ledger.coverage(true)
    expect(await ledger.seal(token as any,async()=>[])).toBe(false)
    expect(ledger.commitRelease(token as any)).toBe(false);expect(ledger.thaw(token as any)).toBe(false)
    expect(ledger.inspection().closed).toBe(false)
  }
})

it('ends a never-dispatched reservation rejected by freeze without reactivating its old handle after thaw', () => {
  const ledger=createOperationLedger();ledger.coverage(true);const op=ledger.reserve('session','http'),token=ledger.freeze()
  expect(()=>op.dispatched()).toThrow('frozen')
  expect(ledger.inspection().pendingRequests).toBe(0)
  expect(ledger.thaw(token)).toBe(true);expect(()=>op.dispatched()).toThrow('frozen')
  expect(ledger.inspection().unconfirmedOperations).toBe(0)
})

it('invalidates a freeze when coverage is lost and regained during its outstanding metadata write', async () => {
  const ledger=createOperationLedger();ledger.coverage(true);const op=ledger.reserve('session','http');op.dispatched();op.finish(false)
  let finish!:(rows:{observationId:string;status:'saved'}[])=>void,ids:string[]=[]
  const token=ledger.freeze(),saving=ledger.seal(token,async rows=>{ids=rows.map(row=>row.observationId);return new Promise(resolve=>{finish=resolve})})
  ledger.coverage(false);ledger.coverage(true)
  finish(ids.map(observationId=>({observationId,status:'saved'})))
  expect(await saving).toBe(false);expect(ledger.commitRelease(token)).toBe(false)
})

it('serializes without capturing module imports or caller data', () => {
  const make = new Function(`return (${createOperationLedger.toString()})`)()
  const ledger: ReturnType<typeof createOperationLedger> = make()
  ledger.coverage(true)
  const operation = ledger.reserve('session', 'http', 'generated-session')
  operation.dispatched(); operation.finish(false)
  expect(ledger.inspection()).toMatchObject({ pendingRequests: 0, unconfirmedOperations: 1 })
  expect(JSON.stringify(ledger.inspection())).not.toContain('generated-session')
})

it('keeps a pending operation protected and blocks dispatch synchronously while frozen', async () => {
  const ledger = createOperationLedger(); ledger.coverage(true)
  const pending = ledger.reserve('files', 'http'); pending.dispatched()
  const token = ledger.freeze(), save = vi.fn()
  expect(await ledger.seal(token, save)).toBe(false)
  expect(save).not.toHaveBeenCalled(); expect(ledger.commitRelease(token)).toBe(false)
  expect(() => ledger.reserve('session', 'http')).toThrow('frozen')
  pending.finish(true)
  expect(await ledger.seal(token, save)).toBe(true)
  expect(ledger.commitRelease(token)).toBe(true)
  expect(() => ledger.reserve('other', 'http')).toThrow('frozen')
})

it('distinguishes a pre-dispatch cancellation from a lost acknowledgement', async () => {
  const ledger = createOperationLedger(); ledger.coverage(true)
  const cancelled = ledger.reserve('settings', 'http'); cancelled.finish(false)
  const lost = ledger.reserve('session', 'http', 'generated-session'); lost.dispatched(); lost.finish(false); lost.finish(true)
  expect(ledger.inspection()).toMatchObject({ pendingRequests: 0, unconfirmedOperations: 1 })
  const token = ledger.freeze(), save = vi.fn(async records => records.map((record: { observationId: string }) => ({ observationId: record.observationId, status: 'saved' as const })))
  expect(await ledger.seal(token, save)).toBe(true)
  const record = save.mock.calls[0][0][0]
  expect(Object.keys(record).sort()).toEqual(['category','endedAt','observationId','selectedSessionIdAtDispatch','startedAt','transport'])
  expect(record.endedAt).toBeGreaterThanOrEqual(record.startedAt)
  expect(ledger.inspection().unconfirmedOperations).toBe(0)
  expect(ledger.commitRelease(token)).toBe(true)
})

it('retains an unknown result if persistence fails or returns a mismatched receipt', async () => {
  const ledger = createOperationLedger(); ledger.coverage(true)
  const operation = ledger.reserve('terminal', 'stream'); operation.dispatched(); operation.finish(false)
  const token = ledger.freeze()
  expect(await ledger.seal(token, async () => { throw Error('Generated disk failure') })).toBe(false)
  expect(await ledger.seal(token, async () => [{ observationId: 'wrong-id', status: 'saved' }])).toBe(false)
  expect(ledger.inspection().unconfirmedOperations).toBe(1); expect(ledger.commitRelease(token)).toBe(false)
})

it('does not release during an outstanding save or after transport coverage changes', async () => {
  const ledger = createOperationLedger(); ledger.coverage(true)
  const operation = ledger.reserve('other', 'http'); operation.dispatched(); operation.finish(false)
  let finish!: (value: { observationId: string; status: 'saved' }[]) => void
  let records!: { observationId: string }[]
  const token = ledger.freeze(), saving = ledger.seal(token, async batch => { records = batch; return new Promise(resolve => { finish = resolve }) })
  expect(ledger.commitRelease(token)).toBe(false)
  ledger.coverage(false)
  finish(records.map(record => ({ observationId: record.observationId, status: 'saved' })))
  expect(await saving).toBe(false); expect(ledger.commitRelease(token)).toBe(false)
  expect(ledger.thaw(token)).toBe(true)
})

it('lets cancelled release resume dispatch while a metadata save finishes, without reviving its old permit', async () => {
  const ledger = createOperationLedger(); ledger.coverage(true)
  const op = ledger.reserve('other','http');op.dispatched();op.finish(false)
  let finish!: (rows:{observationId:string;status:'saved'}[])=>void, ids:string[]=[]
  const token = ledger.freeze(), saving = ledger.seal(token, async rows => { ids=rows.map(row=>row.observationId);return new Promise(resolve=>{finish=resolve}) })
  expect(ledger.thaw(token)).toBe(true)
  const next=ledger.reserve('session','http');next.dispatched()
  finish(ids.map(observationId=>({observationId,status:'saved'})))
  expect(await saving).toBe(false);expect(ledger.commitRelease(token)).toBe(false)
  expect(ledger.inspection().pendingRequests).toBe(1);next.finish(true)
})

it('requires a completed seal even when there are no observations to persist', async () => {
  const ledger=createOperationLedger();ledger.coverage(true);const token=ledger.freeze()
  expect(ledger.commitRelease(token)).toBe(false)
  expect(await ledger.seal(token,async()=>[])).toBe(true)
  ledger.coverage(false);ledger.coverage(true)
  expect(ledger.commitRelease(token)).toBe(false)
  expect(await ledger.seal(token,async()=>[])).toBe(false);expect(ledger.thaw(token)).toBe(true)
  const next=ledger.freeze();expect(await ledger.seal(next,async()=>[])).toBe(true);expect(ledger.commitRelease(next)).toBe(true)
})

it('never removes an already-dispatched pending operation if its handle is reused during freeze', () => {
  const ledger=createOperationLedger();ledger.coverage(true);const op=ledger.reserve('terminal','stream');op.dispatched()
  const token=ledger.freeze();expect(()=>op.dispatched()).toThrow('already dispatched')
  // A duplicate marker invalidates coverage but cannot erase the actual wait.
  expect(ledger.inspection()).toMatchObject({coverage:'unknown',pendingRequests:null})
  expect(ledger.commitRelease(token)).toBe(false);op.finish(false)
  expect(ledger.commitRelease(token)).toBe(false)
})

it('binds the release to its exact freeze token and refuses an old permit after thaw', async () => {
  const ledger = createOperationLedger(); ledger.coverage(true)
  const old = ledger.freeze(); expect(await ledger.seal(old, async () => [])).toBe(true)
  expect(ledger.thaw(old)).toBe(true)
  const current = ledger.freeze()
  expect(ledger.commitRelease(old)).toBe(false); expect(ledger.thaw(old)).toBe(false)
  expect(await ledger.seal(current, async () => [])).toBe(true); expect(ledger.commitRelease(current)).toBe(true)
})

it('does not share a concurrent freeze or allow an operation reserved before freezing to dispatch', () => {
  const ledger = createOperationLedger(); ledger.coverage(true)
  const operation = ledger.reserve('workspace', 'http'), token = ledger.freeze()
  expect(() => ledger.freeze()).toThrow('already frozen')
  expect(() => operation.dispatched()).toThrow('frozen')
  operation.finish(false)
  expect(ledger.inspection()).toMatchObject({ pendingRequests: 0, unconfirmedOperations: 0 })
  expect(ledger.thaw(token)).toBe(true)
})

it('checks every persistence acknowledgement before dropping any unknown snapshot', async () => {
  const ledger = createOperationLedger(); ledger.coverage(true)
  for (let i=0;i<2;i++) { const op = ledger.reserve('session','http'); op.dispatched(); op.finish(false) }
  const token = ledger.freeze()
  expect(await ledger.seal(token, async rows => rows.map(() => ({ observationId: rows[0].observationId, status: 'saved' })))).toBe(false)
  expect(ledger.inspection().unconfirmedOperations).toBe(2)
  expect(await ledger.seal(token, async rows => rows.map(row => ({ observationId: row.observationId, status: 'dismissed' })))).toBe(true)
})

it('batches durable metadata and fails closed for release at the observation bound', async () => {
  const ledger = createOperationLedger(); ledger.coverage(true)
  for(let i=0;i<130;i++){const op=ledger.reserve('other','http');op.dispatched();op.finish(false)}
  const sizes:number[]=[], token=ledger.freeze()
  expect(await ledger.seal(token,async rows=>{sizes.push(rows.length);return rows.map(row=>({observationId:row.observationId,status:'saved'}))})).toBe(true)
  expect(sizes).toEqual([64,64,2])
  expect(ledger.thaw(token)).toBe(true)
  let overflow!:ReturnType<typeof ledger.reserve>
  for(let i=0;i<4097;i++)overflow=ledger.reserve('other','http')
  expect(ledger.inspection()).toMatchObject({coverage:'unknown',pendingRequests:null,unconfirmedOperations:null})
  expect(ledger.commitRelease(ledger.freeze())).toBe(false)
  expect(()=>overflow.dispatched()).toThrow('frozen')
})

it('confirms unknown metadata in the real private store before release and can read it after restart', async () => {
  const parent=await mkdtemp(join(tmpdir(),'dsh-operation-ledger-')),root=join(parent,'observations'),host='a'.repeat(24)
  const store=new ViewReceiptStore(root),ledger=createOperationLedger();ledger.coverage(true)
  try {
    const op=ledger.reserve('session','http','generated-session');op.dispatched();op.finish(false)
    const token=ledger.freeze()
    expect(await ledger.seal(token,records=>store.saveMany(host,records))).toBe(true)
    expect(ledger.commitRelease(token)).toBe(true)
    await store.close()
    const restarted=new ViewReceiptStore(root)
    try {
      const rows=(await restarted.list(host)).entries
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({hostId:host,outcome:'unconfirmed',category:'session',selectedSessionIdAtDispatch:'generated-session'})
      expect((await restarted.list('b'.repeat(24))).entries).toHaveLength(0)
    } finally { await restarted.close() }
  } finally { await store.close();await rm(parent,{recursive:true,force:true}) }
})
