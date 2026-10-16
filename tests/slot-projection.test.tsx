import { createElement } from 'react'
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
