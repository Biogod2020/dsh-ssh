/** Sidebar presentation only. These ids never go to a Workspace controller. */
export const WORKSPACE_ORDER_KEY = 'dsh-ssh:workspace-order:v1'
const MAX_ITEMS = 10000, MAX_BYTES = 1024 * 1024
type OrderStorage = Pick<Storage, 'getItem' | 'setItem'>
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index])

function validIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_ITEMS && value.every(id => typeof id === 'string'
    && id.length > 0 && id.length <= 512 && !/[\u0000-\u001f\u007f]/.test(id)) && new Set(value).size === value.length
}
function decode(raw: string | null): string[] {
  if (raw === null) return []
  if (raw.length > MAX_BYTES) throw new Error('Invalid workspace order')
  const value = JSON.parse(raw)
  if (value?.version !== 1 || !validIds(value.order)) throw new Error('Invalid workspace order')
  return value.order
}

/** Unknown saved ids stay in place while another Host's catalog is loading. */
export function moveWorkspaceBefore(saved: readonly string[], visible: readonly string[], source: string, before?: string): string[] {
  if (!validIds(saved) || !validIds(visible) || !visible.includes(source) || before !== undefined && !visible.includes(before)) throw new Error('Workspace is no longer visible')
  const present = new Set(saved), all = [...saved, ...visible.filter(id => !present.has(id))]
  if (source === before) return all
  const next = all.filter(id => id !== source)
  next.splice(before === undefined ? next.length : next.indexOf(before), 0, source)
  if (!validIds(next)) throw new Error('Invalid workspace order')
  return next
}

/** Reconcile saved positions with current identities; new projects keep their native order. */
export function orderedWorkspaces<T extends { workspaceId: string }>(items: readonly T[], order: readonly string[]): T[] {
  const remaining = new Map(items.map(item => [item.workspaceId, item])), result: T[] = []
  for (const id of order) {
    const item = remaining.get(id)
    if (item) { result.push(item); remaining.delete(id) }
  }
  return [...result, ...remaining.values()]
}

/** Same persistence boundary as native view preferences: this browser/client.
 * Missing storage permits a temporary layout. Corrupt preferences are retained.
 * No HTTP, SSH, controller mutation or command retry belongs to this class. */
export class WorkspaceOrder {
  private value: readonly string[] = []
  private raw: string | null | undefined
  private malformed = false
  private listeners = new Set<() => void>()
  constructor(private readonly storage: () => OrderStorage = () => localStorage,
    private readonly events: Pick<Window, 'addEventListener' | 'removeEventListener'> | undefined = typeof window === 'undefined' ? undefined : window) {
    this.refresh()
  }
  getSnapshot = (): readonly string[] => this.value
  subscribe = (listener: () => void): (() => void) => {
    if (!this.listeners.size) this.events?.addEventListener('storage', this.storageChanged)
    this.listeners.add(listener); this.refresh()
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) this.events?.removeEventListener('storage', this.storageChanged)
    }
  }
  private storageChanged = (event: Event) => {
    const key = (event as StorageEvent).key
    if (key === WORKSPACE_ORDER_KEY || key === null) this.refresh()
  }
  private publish(next: readonly string[]): void {
    if (same(next, this.value)) return
    this.value = next
    for (const listener of this.listeners) listener()
  }
  private refresh(): void {
    try {
      const raw = this.storage().getItem(WORKSPACE_ORDER_KEY)
      if (raw === this.raw) return
      this.raw = raw
      try { const next = decode(raw); this.malformed = false; this.publish(next) }
      catch { this.malformed = true }
    } catch { /* View preferences must not prevent the rest of the client from opening. */ }
  }
  /** Returns false only when the new layout could not be persisted. */
  move(source: string, before: string | undefined, visible: readonly string[]): boolean {
    this.refresh()
    const next = moveWorkspaceBefore(this.value, visible, source, before)
    let saved = false
    if (!this.malformed) {
      try {
        const raw = JSON.stringify({ version: 1, order: next })
        if (raw.length > MAX_BYTES) throw new Error('Workspace order is too large')
        this.storage().setItem(WORKSPACE_ORDER_KEY, raw); this.raw = raw; saved = true
      } catch { /* Keep the gesture usable and report temporary persistence to the caller. */ }
    }
    this.publish(next)
    return saved
  }
}
