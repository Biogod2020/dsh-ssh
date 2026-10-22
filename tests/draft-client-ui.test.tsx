// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { draftClient, seedDraft } from '../src/remote/draft-client.ts'
import { createDraftReplica, type DraftInput } from '../src/remote/draft-replica.ts'
import type { SavedDraft } from '../src/remote/draft-store.ts'

const hostId = 'a'.repeat(24), sessionId = 'fixture'
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined
  window.dispatchEvent(new Event('pagehide'))
  for (const key of ['__dshSshDraftOwner', '__dshSshDrafts', '__dshSshDraftSeeds']) delete (window as any)[key]
  localStorage.clear(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers()
})
async function fixture(existingBrowser = false, unsupported = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); document.documentElement.lang = 'en'
  let saved: SavedDraft = { version: 1, hostId, sessionId, text: 'Generated saved text', revision: randomUUID(), operationId: randomUUID(), hadAttachments: false, hadReferences: false, savedAt: 1 }
  if (existingBrowser) localStorage.setItem('dsh.conversation.fixture', JSON.stringify({ draft: '' }))
  seedDraft({ hostId, sessionId, draft: saved }, true)
  let state: DraftInput = { draft: JSON.parse(localStorage.getItem('dsh.conversation.fixture')!).draft, draftRev: 0, phase: 'plain', occurrences: [], attachmentIds: [] }
  const listeners = new Set<() => void>(), put: any[] = [], submit = vi.fn()
  const update = (draft: string) => { state = { ...state, draft, draftRev: state.draftRev + 1 }; for (const listener of listeners) listener() }
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const face = { state: { subscribe, getSnapshot: () => state }, setDraft: update, submit }
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    let status = 200
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)); put.push(body)
      if (body.expectedRevision !== saved.revision) status = 409
      else saved = { ...saved, text: body.text, operationId: body.operationId, revision: randomUUID(), hadReferences: body.hadReferences, hadAttachments: body.hadAttachments }
    }
    return { ok: status === 200, status, json: async () => ({ draft: saved }) }
  })
  vi.stubGlobal('fetch', fetch)
  let registration: any, Entry: any
  const effects: Array<() => void> = []
  const ctx: any = { sessions: { scope: (id: string) => ({ sessionId: id }) }, get: (name: string) => {
    expect(name).toBe('conversation')
    return unsupported ? undefined : { input: { for: (scope: any) => { expect(scope.sessionId).toBe(sessionId); return face } } }
  }, slots: { inject: (_name: string, apply: () => () => void) => apply(), register: (options: any, component: any) => {
    expect(options.name).toBe('conversation.input.dock'); Entry = component; return () => {}
  } }, effect: (apply: () => () => void) => effects.push(apply()) }
  ctx.root = { inject: (_dependencies: string[], apply: (ctx: any) => void) => { apply(ctx); return { dispose: () => { for (const effect of effects.splice(0)) effect() } } } }
  vi.stubGlobal('__ModuleLoader__', { load: (value: any) => { registration = value } })
  // Execute the same self-contained source form served by the gateway.
  new Function(`(${draftClient.toString()})(${JSON.stringify(hostId)},(${createDraftReplica.toString()}),(${seedDraft.toString()}));`)()
  registration.factory((id: string) => { expect(id).toBe('react'); return React }).apply(ctx)
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root!.render(React.createElement(Entry, { sessionId })) })
  return { update, put, fetch, submit, get saved() { return saved }, get input() { return state },
    clearBeforeUnmount() { state = { ...state, draft: '', draftRev: state.draftRev + 1 } } }
}
it('uses the supplied native input hook, autosaves to the computer and never submits', async () => {
  vi.useFakeTimers(); const f = await fixture()
  expect(document.body.textContent).toContain('Draft saved on this computer')
  await act(async () => f.update('Generated new unsent text'))
  expect(document.body.textContent).toContain('not saved yet')
  await act(async () => { await vi.advanceTimersByTimeAsync(351) })
  expect(f.saved.text).toBe('Generated new unsent text')
  expect(f.put).toHaveLength(1)
  expect(document.body.textContent).toContain('Draft saved on this computer')
  expect(f.submit).not.toHaveBeenCalled()
})
it('keeps an empty browser choice and the saved text separate until explicit selection', async () => {
  const f = await fixture(true)
  expect(document.querySelector('textarea')?.value).toBe('Generated saved text')
  expect(f.input.draft).toBe('')
  expect(await (window as any).__dshSshDrafts.flush()).toBe(false)
  expect(f.put).toHaveLength(0); expect(f.input.draft).toBe('')
  await act(async () => document.querySelector<HTMLButtonElement>('button')!.click())
  expect(f.saved.text).toBe('')
  expect(f.submit).not.toHaveBeenCalled()
})
it('does not claim saving support when the native scoped input contract is absent', async () => {
  const f = await fixture(false, true)
  expect(document.body.textContent).toContain('unavailable in this remote client')
  expect(f.fetch).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
})
it('captures the latest public input snapshot before unmount even if React did not render it', async () => {
  const f = await fixture()
  f.clearBeforeUnmount()
  await act(async () => root!.unmount()); root = undefined
  expect(f.saved.text).toBe('')
  expect(f.put).toHaveLength(1)
  expect(f.submit).not.toHaveBeenCalled()
})
