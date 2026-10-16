import { expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { terminalSettings } from '../src/client/terminal-settings.ts'

it('mounts without an obsolete settings service, observes both versions, and detaches on disposal', () => {
  const injections = new Map<string, (ctx: Context) => void>()
  const disposers: Array<() => void> = []
  const listeners = new Set<() => void>()
  let font = 'Alpha Mono', ready = true
  const form = {
    getSnapshot: () => ({ status: ready ? 'ready' : 'loading', value: { terminalFontFamily: font } }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const ctx = {
    inject: (keys: string[], callback: (ctx: Context) => void) => injections.set(keys[0], callback),
    get: (name: string) => name === 'settingsScope' ? { bind: () => form } : name === 'configForms' ? { get: () => form } : undefined,
    effect: (callback: () => () => void) => disposers.push(callback()),
  } as unknown as Context
  const source = terminalSettings(ctx)
  expect(source.get()).toBeUndefined()
  let changes = 0
  const stop = source.subscribe(() => { changes++ })
  injections.get('settingsScope')!(ctx)
  expect(source.get()).toBe('Alpha Mono')
  font = 'Native Mono'
  injections.get('configForms')!(ctx)
  expect(source.get()).toBe('Native Mono')
  font = 'Updated Mono'
  for (const listener of listeners) listener()
  expect(source.get()).toBe('Updated Mono')
  expect(changes).toBeGreaterThan(2)
  ready = false
  expect(source.get()).toBeUndefined()
  for (const dispose of disposers) dispose()
  expect(listeners.size).toBe(0)
  const before = changes; stop()
  expect(changes).toBe(before)
})
