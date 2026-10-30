import type { Context } from '@deepseek-ai/cordis'
import { NativeSessionAdapter } from './native-session-adapter.tsx'
import { remoteNavigation, remoteSessionKey } from './remote-navigation.ts'
import { remotePresentation, remoteSelection, selectRemoteView } from './remote-presentation.ts'
import { tt } from './panel/helpers.ts'

type InputContext = { modal: string | null; region: string; source?: string; target?: Element | null }
type Resolution = { status: 'handled'; run(): void } | { status: 'blocked'; reason: string } | { status: 'pass' }
type Resolver = (context: InputContext) => Resolution
interface Command { id: string; resolve: Resolver }
const reviewed: Record<string, string> = {
  'session.new': '92:19d33cc3', 'session.rename': '374:f0d74354',
  'session.fork': '669:7b8d3237', 'session.archive': '235:ac54280e',
}

/** Compatibility identity, not a security digest. Taken from unmodified RC2/RC3
 * resolver functions; an upstream implementation change requires review. */
function fingerprint(fn: Function): string {
  const code = Function.prototype.toString.call(fn)
  let hash = 2166136261
  for (let i = 0; i < code.length; i++) hash = Math.imul(hash ^ code.charCodeAt(i), 16777619)
  return `${code.length}:${(hash >>> 0).toString(16)}`
}

/** The only private SDK seam. Keep existing command objects so Web dispatch,
 * Desktop gestures and native menu invocation use one target resolver. Do not
 * touch bindings, preferences, registrations, transport or installed files. */
export function installShortcutTargetRouter(service: unknown, version: unknown,
  resolve: (id: string, context: InputContext) => Resolution | undefined,
  unsupported: () => void = () => {},
): { supported: boolean; dispose(): void } {
  const unavailable = { supported: false, dispose() {} }
  try {
  if (!['0.2.1-rc.2', '0.2.1-rc.3'].includes(String(version))) return unavailable
  const face = service as { registry?: { commands?: unknown }; catalog?: { subscribe(listener: () => void): () => void } } | undefined
  const commands = face?.registry?.commands
  if (!(commands instanceof Map) || typeof face?.catalog?.subscribe !== 'function') return unavailable
  let active = true
  const changes: Array<{ command: Command; original: Resolver; wrapped: Resolver }> = []
  for (const [id, identity] of Object.entries(reviewed)) {
    const command = commands.get(id) as Command | undefined
    const descriptor = command && Object.getOwnPropertyDescriptor(command, 'resolve')
    if (!command || command.id !== id || !descriptor?.writable || typeof descriptor.value !== 'function'
      || fingerprint(descriptor.value) !== identity) return unavailable
    const original = command.resolve
    const wrapped: Resolver = function (this: Command, context) {
      let decision: Resolution | undefined
      try { decision = active ? resolve(id, context) : undefined }
      catch { return { status: 'blocked', reason: tt('remote.shortcutUnsupported') } }
      return decision ?? Reflect.apply(original, this, [context])
    }
    changes.push({ command, original, wrapped })
  }
  const installed: typeof changes = []
  let off: (() => void) | undefined
  const restore = () => {
    active = false
    off?.(); off = undefined
    for (const { command, original, wrapped } of installed.splice(0).reverse()) {
      try { if (commands.get(command.id) === command && command.resolve === wrapped) command.resolve = original } catch { /* An outer owner may freeze its replacement. */ }
    }
  }
  try {
    for (const change of changes) { change.command.resolve = change.wrapped; installed.push(change) }
    off = face.catalog.subscribe(() => {
      if (active && changes.some(({ command, wrapped }) => commands.get(command.id) !== command || command.resolve !== wrapped)) {
        restore(); unsupported()
      }
    })
  } catch { restore(); return unavailable }
  return { get supported() { return active }, dispose: restore }
  } catch { return unavailable }
}

export function mountRemoteShortcutRouting(ctx: Pick<Context, 'get'>, adapter: NativeSessionAdapter) {
  const boot = (globalThis as { __DSH_BOOT__?: { release?: { version?: string } } }).__DSH_BOOT__
  return installShortcutTargetRouter(ctx.get('shortcuts'), boot?.release?.version, (id, context) => {
    const selected = remoteSelection()
    if (!selected) return undefined // Preserve the exact local resolver and its result.
    const state = remoteNavigation.getSnapshot(), workspace = state.workspaces.find(row => row.id === selected.workspaceId)
    const blocked = (reason: string): Resolution => ({ status: 'blocked', reason })
    if (!workspace) return blocked(tt('remote.desktopIdentityChanged'))
    if (context.modal !== null) return blocked(tt('remote.shortcutModal'))
    if (!navigator.onLine || state.hosts?.get(workspace.hostId) !== 'ready') return blocked(tt('remote.actionConnectionRequired'))
    const sessionId = selected.sessionId, key = remoteSessionKey(workspace, sessionId)
    // Resolve once, recheck ownership when the registry runs the captured action.
    return { status: 'handled', run() {
      const current = remoteSelection(), owner = remoteNavigation.getSnapshot().workspaces.find(row => row.id === workspace.id)
      if (current?.workspaceId !== selected.workspaceId || current.sessionId !== selected.sessionId
        || owner?.hostId !== workspace.hostId || owner.workspaceId !== workspace.workspaceId) {
        adapter.report(tt('remote.desktopIdentityChanged')); return
      }
      if (id === 'session.new') remoteNavigation.open(workspace, undefined, true)
      else if (!sessionId) adapter.report(tt('remote.shortcutNoSession'))
      else if (id === 'session.rename') adapter.requestRename(key)
      else adapter.run(() => id === 'session.fork' ? adapter.fork(key) : adapter.archive(key), key)
    } }
  }, () => {
    remoteNavigation.cancelOpen()
    try { remotePresentation()?.suspend?.() } finally { selectRemoteView() }
    adapter.report(tt('remote.shortcutUnsupported'))
  })
}
