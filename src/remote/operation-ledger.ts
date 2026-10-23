import type { ViewReceiptInput } from './view-receipts.ts'

/** Page-owned metadata only. A reserved operation is not proof of dispatch. */
export function createOperationLedger() {
  type Record = ViewReceiptInput
  type Receipt = { observationId: string; status: 'saved' | 'dismissed' }
  const active = new Map<string, { record: Omit<Record, 'endedAt'>; dispatched: boolean }>()
  const unknown = new Map<string, Record>()
  let covered = false, fault = false, closed = false, frozen: string | undefined
  let sealing: string | undefined, sealed: string | undefined
  let composition = {}, frozenComposition: object | undefined
  const matches = (token: string) => !closed && typeof token === 'string' && !!token && frozen !== undefined && frozen === token
  const permitted = (token: string) => matches(token) && frozenComposition === composition && covered && !fault && !active.size && !unknown.size
  const fail = () => { fault = true; sealed = undefined }
  const reserve = (category: Record['category'], transport: Record['transport'], selectedSessionIdAtDispatch?: string) => {
    if (closed || frozen) throw new Error('View dispatch is frozen')
    // Fail closed for release if metadata cannot stay bounded. Observing a
    // full ledger must not prevent an otherwise valid user operation.
    if (active.size + unknown.size >= 4096) {
      fail()
      let ended = false, dispatched = false
      return {
        dispatched() {
          if (ended || closed || frozen) { ended = true; throw new Error('View dispatch is frozen') }
          if (dispatched) throw new Error('Operation was already dispatched')
          dispatched = true
        },
        finish(_confirmed: boolean) { ended = true },
      }
    }
    const id = crypto.randomUUID()
    const value = { record: { observationId: id, startedAt: Date.now(), category, transport,
      ...(selectedSessionIdAtDispatch === undefined ? {} : { selectedSessionIdAtDispatch }) }, dispatched: false }
    active.set(id, value)
    let ended = false
    return {
      dispatched() {
        if (ended || !active.has(id)) throw new Error('View dispatch is frozen')
        if (value.dispatched) { fail(); throw new Error('Operation was already dispatched') }
        if (closed || frozen) { ended = true; active.delete(id); throw new Error('View dispatch is frozen') }
        value.dispatched = true
      },
      finish(confirmed: boolean) {
        if (ended) return
        ended = true; active.delete(id)
        if (value.dispatched && !confirmed) unknown.set(id, { ...value.record, endedAt: Math.max(value.record.startedAt, Date.now()) })
      },
    }
  }
  return {
    reserve,
    // The owner calls this only after verifying the current composition.
    // Missing, replaced or unsupported transports never become numeric zero.
    coverage(complete: boolean) { covered = complete; composition = {}; sealed = undefined },
    fail,
    inspection() {
      return { scope: 'operation-ledger' as const, coverage: covered && !fault ? 'verified' as const : 'unknown' as const,
        frozen: !!frozen, closed, pendingRequests: covered && !fault ? active.size : null,
        unconfirmedOperations: covered && !fault ? unknown.size : null }
    },
    freeze() {
      if (closed || frozen) throw new Error('View dispatch is already frozen')
      sealed = undefined; frozenComposition = composition; frozen = crypto.randomUUID(); return frozen
    },
    thaw(token: string) {
      if (!matches(token)) return false
      sealed = undefined; frozenComposition = undefined; frozen = undefined; return true
    },
    /** Persist only ended unknown observations. Pending work cannot be
     * converted into an ended receipt to make a view eligible for release. */
    async seal(token: string, persist: (records: Record[]) => Promise<Receipt[]>): Promise<boolean> {
      if (!matches(token) || frozenComposition !== composition || !covered || fault || active.size || sealing) return false
      sealed = undefined; sealing = token
      try {
        while (unknown.size) {
          if (!matches(token) || frozenComposition !== composition || !covered || fault || active.size) return false
          const batch = [...unknown.values()].slice(0, 64)
          // Detached copies prevent a persistence callback from changing the
          // retained records or their identity while its write is pending.
          const receipts = await persist(batch.map(record => ({ ...record })))
          if (!Array.isArray(receipts) || receipts.length !== batch.length) return false
          const expected = new Set(batch.map(record => record.observationId))
          for (const receipt of receipts) {
            if (!receipt || !expected.delete(receipt.observationId) || !['saved', 'dismissed'].includes(receipt.status)) return false
          }
          if (expected.size) return false
          for (const record of batch) if (unknown.get(record.observationId) === record) unknown.delete(record.observationId)
        }
        if (!permitted(token)) return false
        sealed = token; return true
      } catch { return false }
      finally { if (sealing === token) sealing = undefined }
    },
    /** The exact owner holds the dispatch freeze until removing its guest.
     * A later inspection alone cannot authorize a release. */
    commitRelease(token: string): boolean {
      if (sealing || sealed !== token || !permitted(token)) return false
      closed = true; return true
    },
  }
}
