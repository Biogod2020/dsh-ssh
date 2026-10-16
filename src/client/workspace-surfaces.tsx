import { createElement, useEffect, useState, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { tt } from './panel/helpers.ts'
import type { TerminalFontSource } from './panel/helpers.ts'
import type { SshApi } from './api.ts'
import type { SshWorkspace } from '../workspaces.ts'
import { TerminalTab } from './panel/TerminalTab.tsx'
import { projectEntry } from './slot-projection.tsx'
import css from './panel/panel.module.css'

type PaneProps = PropsRuntime<'sidebar.right.pane.tab'> & Record<string, unknown>

function identityPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\/private(?=\/var\/)/, '').replace(/\/$/, '')
}

/** The old local workspace identity opens an SSH PTY, never a local PTY. */
function LegacyTerminal({ api, cwd, openSsh, terminalFont }: {
  api: SshApi; cwd: string; openSsh: () => void; terminalFont?: TerminalFontSource
}) {
  const [state, setState] = useState<{ binding?: SshWorkspace; error?: string }>({})
  useEffect(() => {
    let active = true
    setState({})
    void api.listWorkspaces().then(workspaces => {
      if (!active) return
      const binding = workspaces.find(item => identityPath(item.localPath) === identityPath(cwd))
      setState(binding ? { binding } : { error: tt('workspace.bindingMissing') })
    }).catch(error => {
      if (active) setState({ error: error instanceof Error ? error.message : String(error) })
    })
    return () => { active = false }
  }, [api, cwd])
  if (state.binding) return <div className={css.workspaceTerminal}>
    <TerminalTab key={`${state.binding.alias}:${state.binding.remotePath}`} api={api}
      lockedAlias={state.binding.alias} remoteCwd={state.binding.remotePath}
      autoConnect terminalFont={terminalFont} />
  </div>
  return <div className={css.workspaceNotice}>
    <p className={css.hint}>{state.error ?? tt('workspace.loadingBinding')}</p>
    {state.error && <button type="button" className={css.primaryButton} onClick={openSsh}>{tt('workspace.openPanel')}</button>}
  </div>
}

/** Native file/terminal panels still use local backends. Never mount them on an SSH identity. */
export function WorkspaceSurface({ original, openSsh, surface = 'body', api, terminalFont, ...props }: PaneProps & {
  original: ComponentType<PaneProps>; openSsh: () => void; surface?: 'body' | 'terminal' | 'title' | 'hidden'
  api?: SshApi; terminalFont?: TerminalFontSource
}) {
  const cwd = props.useSessions((sessions: { byId: Record<string, { cwd?: string }> }) => sessions.byId[props.sessionId]?.cwd)
  if (cwd === undefined) return null
  if (!cwd.replaceAll('\\', '/').includes('/ssh-workspaces/')) return createElement(original, props as PaneProps)
  if (surface === 'hidden') return null
  if (surface === 'title') return <span>{tt('workspace.sshTerminal')}</span>
  if (surface === 'terminal' && api) return <LegacyTerminal api={api} cwd={cwd} openSsh={openSsh} terminalFont={terminalFont} />
  return <div className={css.workspaceNotice}>
    <h3>{tt('workspace.ssh')}</h3>
    <p className={css.hint}>{tt('workspace.panels')}</p>
    <button type="button" className={css.primaryButton} onClick={openSsh}>{tt('workspace.openPanel')}</button>
  </div>
}

/** Shadow native surfaces through public slots; retain their nested local outlets. */
export function guardWorkspaceSurfaces(ctx: Context, openSsh: () => void, api: SshApi, terminalFont?: TerminalFontSource): () => void {
  const terminal = '@deepseek-ai/dsh-client-ui-sidebar-terminal'
  // Merely rendering the terminal title or its recovery action creates a local
  // PTY in this SDK. Guard those seats too, before their hooks or effects run.
  const targets = [
    { slot: 'sidebar.right.pane.tab', key: '@deepseek-ai/dsh-client-ui-sidebar-files', surface: 'body' },
    { slot: 'sidebar.right.pane.tab', key: terminal, surface: 'terminal' },
    { slot: 'sidebar.right.pane.tab.title', key: terminal, surface: 'title' },
    { slot: 'conversation.session.header.actions', key: terminal, surface: 'hidden' },
  ] as const
  const disposers = targets.map(({ slot, key, surface }) => {
    const wrappers = new Set<unknown>()
    let current: StoredEntry | undefined
    let release: (() => void) | undefined
    let syncing = false
    const sync = (): void => {
      if (syncing) return
      syncing = true
      try {
        const original = [...ctx.slots.entries(slot)].filter(entry => (entry.options.key ?? entry.options.id) === key && !wrappers.has(entry.component))
          .sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0]
        if (original === current) return
        release?.(); release = undefined; current = undefined
        if (!original) return
        current = original
        const render = (props: Record<string, unknown>) => <WorkspaceSurface {...props as PaneProps}
          original={original.component as ComponentType<PaneProps>} openSsh={openSsh} surface={surface}
          api={api} terminalFont={terminalFont} />
        // StoredEntry is the SDK's erased registration view; preserve its seats verbatim.
        const projected = projectEntry(ctx.slots as unknown as Parameters<typeof projectEntry>[0],
          slot, original, render, (original.options.priority ?? 0) - 100)
        wrappers.add(projected.component)
        release = projected.dispose
      } finally { syncing = false }
    }
    return ctx.slots.inject(slot, () => {
      sync()
      const unsubscribe = ctx.slots.subscribe(slot, sync)
      return () => { unsubscribe(); release?.(); wrappers.clear(); current = undefined }
    })
  })
  return () => { for (const dispose of disposers) dispose() }
}
