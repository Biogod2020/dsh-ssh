/** Per-tab ownership survives reload. This is a view key, never an auth token. */
const OWNER_KEY = 'dsh-ssh:terminal-owner:v1'
const ACTIVE_KEY = 'dsh-ssh:terminal-active:v1'
let fallbackOwner: string | undefined
export function terminalOwner(): string {
  try {
    const saved = sessionStorage.getItem(OWNER_KEY)
    if (saved && /^[a-zA-Z0-9_-]{16,80}$/.test(saved)) return saved
    const owner = crypto.randomUUID(); sessionStorage.setItem(OWNER_KEY, owner); return owner
  } catch { return fallbackOwner ??= crypto.randomUUID() }
}
export function activeTerminal(): string | undefined {
  try { return sessionStorage.getItem(ACTIVE_KEY) ?? undefined } catch { return undefined }
}
export function rememberActiveTerminal(id?: string): void {
  try { if (id) sessionStorage.setItem(ACTIVE_KEY, id); else sessionStorage.removeItem(ACTIVE_KEY) } catch { /* memory-only view */ }
}
