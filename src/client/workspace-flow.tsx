import { createElement, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SshApi } from './api.ts'
import { WorkspaceFlow } from './WorkspaceFlow.tsx'
import { projectEntry } from './slot-projection.tsx'

/** Add SSH as a choice while retaining the host's browse/native interaction and injected services. */
export function mountWorkspaceFlows(ctx: Pick<Context, 'slots'>, api: SshApi): () => void {
  const slots = ctx.slots as unknown as Parameters<typeof projectEntry>[0] & {
    inject(name: string, callback: () => () => void): () => void
  }
  const disposers = ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow'].map(name => {
    let original: StoredEntry | undefined, release: (() => void) | undefined, syncing = false
    const wrappers = new Set<unknown>()
    const sync = () => {
      if (syncing) return
      syncing = true
      try {
        const next = [...slots.entries(name)].filter(entry => !wrappers.has(entry.component))
          .sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0]
        if (next === original) return
        release?.(); release = undefined; original = next
        if (!next) return
        const projected = projectEntry(slots, name, next, props =>
          <WorkspaceFlow {...props as unknown as DirectoryFlowOwnerProps} api={api}
            renderLocal={owner => createElement(next.component as ComponentType<Record<string, unknown>>, { ...props, ...owner })} />,
          (next.options.priority ?? 0) - 100)
        wrappers.add(projected.component); release = projected.dispose
      } finally { syncing = false }
    }
    return slots.inject(name, () => {
      sync()
      const unsubscribe = slots.subscribe(name, sync)
      return () => { unsubscribe(); release?.(); original = undefined; wrappers.clear() }
    })
  })
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
