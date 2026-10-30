import { createElement, type ComponentType, type ReactElement } from 'react'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

type Props = Record<string, unknown>
export type ProjectedChildRenderer = (sourceSlotName: string, entry: StoredEntry, props: Props) => ReactElement | null
interface Slots {
  entries(name: string): readonly StoredEntry[]
  subscribe(name: string, listener: () => void): () => void
  register(options: object, component: unknown): () => void
}
let serial = 0

/** Preserve native child outlets without redeclaring another plugin's slots. */
export function projectEntry(slots: Slots, name: string, entry: StoredEntry,
  render: (props: Props) => ReactElement | null, priority = entry.options.priority,
  renderChild?: ProjectedChildRenderer,
): { component: ComponentType<Props>; dispose: () => void } {
  const aliases = new Map(Object.keys(entry.children ?? {}).map(key => [key, `dsh.ssh.guard.${++serial}`]))
  const children = Object.fromEntries([...aliases].map(([key, alias]) => [alias, entry.children![key]]))
  const component = (props: Props) => {
    const delegated = { ...props }
    for (const face of ['renderSlot', 'renderSlotChain']) {
      const outlet = props[face]
      if (typeof outlet === 'function') delegated[face] = (key: string, ...args: unknown[]) =>
        outlet(aliases.get(key) ?? key, ...args)
    }
    return render(delegated)
  }
  const release = slots.register({ name, ...entry.options, priority,
    store: entry.store, inject: entry.inject, locale: entry.locale, select: entry.select,
    ...(aliases.size ? { children } : {}),
  }, component)
  const mirrors: Array<() => void> = []
  try {
    for (const [source, alias] of aliases) {
      const copies = new Map<StoredEntry, () => void>()
      const sync = () => {
        const entries = slots.entries(source)
        for (const [original, dispose] of copies) {
          if (!entries.includes(original)) { dispose(); copies.delete(original) }
        }
        for (const original of entries) {
          if (!copies.has(original)) copies.set(original, projectEntry(slots, alias, original,
            props => renderChild ? renderChild(source, original, props) : createElement(original.component as ComponentType<Props>, props),
            original.options.priority, renderChild).dispose)
        }
      }
      const unsubscribe = slots.subscribe(source, sync)
      mirrors.push(() => { unsubscribe(); for (const dispose of copies.values()) dispose(); copies.clear() })
      sync()
    }
  } catch (error) {
    for (const dispose of mirrors.reverse()) dispose()
    release()
    throw error
  }
  return { component, dispose: () => {
    for (const dispose of mirrors.splice(0).reverse()) dispose()
    release()
  } }
}
