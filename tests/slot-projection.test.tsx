import { createElement, type ReactElement } from 'react'
import { expect, it } from 'vitest'
import { SlotCore, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { projectEntry } from '../src/client/slot-projection.tsx'

it('preserves native child actions through private declarations and releases every mirror', async () => {
  const core = new SlotCore()
  const slots = core as unknown as Parameters<typeof projectEntry>[0]
  const register = slots.register.bind(core)
  register({ name: 'root', children: { pane: { kind: 'keyed', scope: 'session' } } }, () => null)
  const children = { actions: { kind: 'list', scope: 'session' } }
  register({ name: 'pane', key: 'files', children }, () => null)
  const action = () => null, store = { create: () => ({}) }
  const removeAction = register({ name: 'actions', id: 'open', locale: 'native', store }, action)
  const native = slots.entries('pane')[0]!
  let delegated: Record<string, unknown> = {}
  const projected = projectEntry(slots, 'pane', native, props => {
    delegated = props; return createElement('div')
  }, -100)
  const wrapper = slots.entries('pane').find(entry => entry.component === projected.component)!
  const alias = Object.keys(wrapper.children!)[0]!
  expect(alias).not.toBe('actions')
  expect(slots.entries(alias)).toHaveLength(1)
  expect(slots.entries(alias)[0]).toMatchObject({ locale: 'native', store, options: { id: 'open' } })
  const calls: unknown[][] = []
  ;(projected.component as (props: Record<string, unknown>) => unknown)({
    renderSlot: (...args: unknown[]) => { calls.push(args) },
  })
  ;(delegated.renderSlot as (...args: unknown[]) => unknown)('actions', { absolutePath: '/local' })
  expect(calls).toEqual([[alias, { absolutePath: '/local' }]])
  removeAction()
  await new Promise<void>(resolve => queueMicrotask(resolve))
  expect(slots.entries(alias)).toHaveLength(0)
  register({ name: 'actions', id: 'new' }, action)
  await new Promise<void>(resolve => queueMicrotask(resolve))
  expect(slots.entries(alias)[0]?.options.id).toBe('new')
  projected.dispose()
  expect(core.spec(alias as never)).toBeUndefined()
  expect(slots.entries('pane')).toEqual([native])
  expect(slots.entries('actions')).toHaveLength(1)
})

it('projects nested child declarations without changing the original ownership', () => {
  const core = new SlotCore(), slots = core as unknown as Parameters<typeof projectEntry>[0]
  const register = slots.register.bind(core)
  register({ name: 'root', children: { pane: { kind: 'single', scope: 'root' } } }, () => null)
  register({ name: 'pane', children: { actions: { kind: 'list', scope: 'root' } } }, () => null)
  register({ name: 'actions', id: 'menu', children: { menu: { kind: 'single', scope: 'root' } } }, () => null)
  register({ name: 'menu' }, () => null)
  const native = slots.entries('pane')[0] as StoredEntry
  const projected = projectEntry(slots, 'pane', native, () => createElement('div'), -100)
  const alias = Object.keys(slots.entries('pane')[0]!.children!)[0]!
  const nested = Object.keys(slots.entries(alias)[0]!.children!)[0]!
  expect(slots.entries(nested)).toHaveLength(1)
  projected.dispose()
  expect(core.spec(nested as never)).toBeUndefined()
  expect(slots.entries('menu')).toHaveLength(1)
})

it('adapts each current mirrored child entry and passes its original component entry', async () => {
  const core = new SlotCore(), slots = core as unknown as Parameters<typeof projectEntry>[0]
  const register = slots.register.bind(core)
  register({ name: 'root', children: { pane: { kind: 'single', scope: 'root' } } }, () => null)
  register({ name: 'pane', children: { actions: { kind: 'list', scope: 'root' } } }, () => null)
  const first = () => createElement('i'), removeFirst = register({ name: 'actions', id: 'first' }, first)
  const native = slots.entries('pane')[0]!
  const calls: Array<{ source: string; entry: StoredEntry; props: Record<string, unknown> }> = []
  const projected = projectEntry(slots, 'pane', native, () => createElement('div'), -100,
    (source, entry, props) => { calls.push({ source, entry, props }); return createElement('output', { 'data-entry': entry.options.id }) })
  const alias = Object.keys(slots.entries('pane').find(entry => entry.component === projected.component)!.children!)[0]!
  const render = (entry: StoredEntry, props: Record<string, unknown>): ReactElement | null =>
    (entry.component as (value: Record<string, unknown>) => ReactElement | null)(props)

  expect(render(slots.entries(alias)[0]!, { sessionId: 'one' })?.props).toMatchObject({ 'data-entry': 'first' })
  expect(calls).toEqual([{ source: 'actions', entry: slots.entries('actions')[0], props: { sessionId: 'one' } }])
  expect(calls[0]?.entry.component).toBe(first)

  removeFirst(); await new Promise<void>(resolve => queueMicrotask(resolve))
  const second = () => createElement('b')
  register({ name: 'actions', id: 'second' }, second)
  await new Promise<void>(resolve => queueMicrotask(resolve))
  expect(render(slots.entries(alias)[0]!, { sessionId: 'two' })?.props).toMatchObject({ 'data-entry': 'second' })
  expect(calls.at(-1)).toEqual({ source: 'actions', entry: slots.entries('actions')[0], props: { sessionId: 'two' } })
  expect(calls.at(-1)?.entry.component).toBe(second)
  projected.dispose()
})

it('keeps the original child component behavior when no child renderer is supplied', () => {
  const core = new SlotCore(), slots = core as unknown as Parameters<typeof projectEntry>[0]
  const register = slots.register.bind(core)
  register({ name: 'root', children: { pane: { kind: 'single', scope: 'root' } } }, () => null)
  register({ name: 'pane', children: { actions: { kind: 'list', scope: 'root' } } }, () => null)
  const action = (props: Record<string, unknown>) => createElement('output', { ...props, 'data-original': 'yes' })
  register({ name: 'actions', id: 'original' }, action)
  const projected = projectEntry(slots, 'pane', slots.entries('pane')[0]!, () => createElement('div'), -100)
  const alias = Object.keys(slots.entries('pane').find(entry => entry.component === projected.component)!.children!)[0]!
  const component = slots.entries(alias)[0]!.component as (props: Record<string, unknown>) => ReactElement | null
  const element = component({ sessionId: 'local' })
  expect(element?.type).toBe(action)
  expect(element?.props).toEqual({ sessionId: 'local' })
  projected.dispose()
})
