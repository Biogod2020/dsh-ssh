/**
 * Browser-half entry for the dsh-ssh plugin — runs inside the dsh web GUI.
 *
 * Registers the dsh-ssh locale dictionaries and mounts the two DOM surfaces:
 * the sidebar entry row (toggles the panel) and the SSH operations panel in
 * the center column. Failure policy: DOM mounting problems are logged, never
 * thrown — the web shell fails the whole boot when a plugin apply throws, and
 * an external plugin must not take the GUI down.
 *
 * Export discipline (packages/client rule): the /client surface carries what
 * cordis loading needs plus types only — all value exports stay internal.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings-surface Context merge (ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ctx.slots merge (the renderer owns the slot registry since 0.1.2).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { SshApi } from './api.ts'
import { en, zh, type SshKey } from './locales.ts'
import { mountPanel } from './mount.tsx'
import { PanelController } from './panel/controller.ts'
import { setRuntimeTranslate } from './panel/helpers.ts'
import { mountSidebarEntry } from './sidebar-entry.ts'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { WorkspaceFlow } from './WorkspaceFlow.tsx'
import { mountWorkspaceStatus } from './workspace-status.ts'
import { guardWorkspaceSurfaces } from './workspace-surfaces.tsx'
import { mountRemoteWorkspaces } from './remote-workspaces.ts'
import { terminalSettings } from './terminal-settings.ts'
import { mountNativeSshPanel } from './native-panel.tsx'
import { mountDesktopWorkspaces } from './desktop-workspace.ts'
import { mountNativeWorkspaces, mountNativeSessionControls } from './native-workspaces.tsx'

/** Locale namespace this plugin owns. */
const NS = 'dsh-ssh'


declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-ssh surface copy. */
    'dsh-ssh': SshKey
  }
}

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'locale', 'uiWorkspace']

/** Type-only surface (export discipline: no value exports beyond the plugin contract). */
export type { PanelControllerSnapshot } from './panel/controller.ts'
export type { SshPanelProps } from './panel/SshPanel.tsx'
export type { HostsTabProps } from './panel/HostsTab.tsx'
export type { HostFormDialogProps } from './panel/HostFormDialog.tsx'
export type { TerminalTabProps } from './panel/TerminalTab.tsx'
export type { TransferTabProps } from './panel/TransferTab.tsx'
export type { TunnelsTabProps } from './panel/TunnelsTab.tsx'
export type { ClusterTabProps } from './panel/ClusterTab.tsx'
export type { SshKey } from './locales.ts'

/**
 * Mount the SSH panel.
 * @param ctx - client root context (locale service).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en })
    } catch {
      return () => {}
    }
  }, 'dsh-ssh: dictionaries')

  // Wire the SDK translate seat into the module-level tt (sidebar row and
  // other plain-DOM callers): reads the active locale at call time, so they
  // follow the Language setting without a reload.
  try { setRuntimeTranslate(ctx.locale.bind(NS)) } catch { /* locale missing: document-language fallback stays */ }

  const controller = new PanelController()
  const api = new SshApi()
  const injected = () => ({ api, pickLocal: () => ctx.uiWorkspace.pickDirectory() })
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
    ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
      yield ctx.slots.register({ name: 'conversation.hero.workspace.directoryFlow', priority: -100, inject: injected }, WorkspaceFlow)
      yield ctx.slots.register({ name: 'sidebar.workspaces.directoryFlow', priority: -100, inject: injected }, WorkspaceFlow)
    }))
  // Live terminal-font preference (issue #577): the settings namespace is
  // edited by the host-registered GUI section; the panel re-applies changes
  // to open terminals without a reconnect.
  const terminalFont = terminalSettings(ctx)
  guardWorkspaceSurfaces(ctx, () => controller.open(), api, terminalFont)
  const disposers: Array<() => void> = []
  try {
    const desktop = mountDesktopWorkspaces(ctx.locale, ctx)
    if (desktop) disposers.push(desktop)
    if (desktop) disposers.push(mountNativeWorkspaces(ctx))
    if (desktop) disposers.push(mountNativeSessionControls(ctx))
    const native = mountNativeSshPanel(ctx, controller, api, terminalFont, ctx.locale)
    if (native) disposers.push(native)
    else {
      disposers.push(mountSidebarEntry(controller, ctx.locale))
      disposers.push(mountPanel(controller, api, terminalFont, ctx.locale))
    }
    disposers.push(mountWorkspaceStatus(api, ctx.locale))
    disposers.push(mountRemoteWorkspaces(ctx.locale))
  } catch (error) {
    // DOM failures degrade the panel, never the GUI.
    console.warn('[dsh-ssh] mount failed:', error)
  }
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  }, 'dsh-ssh: ui mounts')
}
