// @vitest-environment jsdom
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { createDraftReplica, type DraftInput } from '../src/remote/draft-replica.ts'
import type { SavedDraft } from '../src/remote/draft-store.ts'

const hostId = 'a'.repeat(24), sessionId = 'fixture'
const replicas: Array<ReturnType<typeof createDraftReplica>> = []
afterEach(async () => { for (const replica of replicas.splice(0)) await replica.dispose(); vi.unstubAllGlobals() })
const input = (draft = '', draftRev = 0): DraftInput => ({ draft, draftRev, phase: 'plain', occurrences: [], attachmentIds: [] })
const doc = (text: string): SavedDraft => ({ version: 1, hostId, sessionId, text, revision: randomUUID(), operationId: randomUUID(), hadReferences: false, hadAttachments: false, savedAt: 1 })
const response = (draft?: SavedDraft, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => ({ draft }) })
function fixture(initial?: SavedDraft, current = input(), seeded = true) {
  let saved = initial, intercept: ((body: any) => Promise<void>) | undefined, failAfterCommit = false
  const writes: any[] = [], restore = vi.fn()
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe('/__dsh_remote/draft?sessionId=fixture')
    if (init?.method !== 'PUT') return response(saved)
    const body = JSON.parse(String(init.body)); writes.push(body)
    if ((saved?.revision ?? null) !== body.expectedRevision) return response(undefined, 409)
    await intercept?.(body)
    saved = { ...doc(body.text), operationId: body.operationId, hadReferences: body.hadReferences, hadAttachments: body.hadAttachments }
    if (failAfterCommit) throw new TypeError('Generated lost local reply')
    return response(saved)
  })
  vi.stubGlobal('fetch', fetch)
  const replica = createDraftReplica({ hostId, sessionId, input: current, restore,
    ...(seeded ? { seed: { hostId, sessionId, draft: initial } } : {}) })
  replicas.push(replica)
  return { replica, restore, fetch, writes, get saved() { return saved }, set saved(value) { saved = value },
    intercept(fn: (body: any) => Promise<void>) { intercept = fn }, loseReply() { failAfterCommit = true } }
}
it('loads the owned seed without a request and still supports a later explicit recheck', async () => {
  const f = fixture(doc('saved'))
  expect(await f.replica.load()).toBe(true)
  expect(f.restore).toHaveBeenCalledExactlyOnceWith('saved')
  expect(f.fetch).not.toHaveBeenCalled()
  f.saved = doc('another editor')
  expect(await f.replica.load(true)).toBe(false)
  expect(f.replica.getSnapshot().status).toBe('conflict')
  expect(f.replica.getSnapshot().savedText).toBe('another editor')
  expect(f.fetch).toHaveBeenCalledOnce()
})
it('never replaces text typed while an older disk read was pending', async () => {
  const f = fixture(undefined, input(), false)
  let finish!:(value: any) => void, started!:() => void
  const began = new Promise<void>(resolve => { started = resolve })
  f.fetch.mockImplementationOnce(async () => { started(); return new Promise(resolve => { finish = resolve }) })
  const loading = f.replica.load(); await began
  f.replica.update(input('new user text', 1)); finish(response(doc('older saved text')))
  expect(await loading).toBe(false)
  expect(f.restore).not.toHaveBeenCalled()
  expect(f.writes).toHaveLength(0)
  expect(f.replica.getSnapshot().status).toBe('conflict')
})
it('commits edits received during a dispatched save as a new snapshot, in order', async () => {
  const f = fixture(doc('zero'), input('zero'))
  await f.replica.load()
  let release!:() => void, started!:() => void
  const began = new Promise<void>(resolve => { started = resolve })
  f.intercept(async () => { if (f.writes.length === 1) { started(); await new Promise<void>(resolve => { release = resolve }) } })
  f.replica.update(input('one', 1)); const saving = f.replica.flush(); await began
  f.replica.update(input('two', 2)); release()
  expect(await saving).toBe(true)
  expect(f.writes.map(row => row.text)).toEqual(['one', 'two'])
  expect(f.saved?.text).toBe('two')
  expect(f.replica.getSnapshot().status).toBe('saved')
})
it('confirms a lost local write reply by operation identity without sending the write again', async () => {
  const f = fixture(doc('old'), input('old')); await f.replica.load(); f.loseReply()
  f.replica.update(input('new', 1))
  expect(await f.replica.flush()).toBe(true)
  expect(f.writes).toHaveLength(1)
  expect(f.fetch).toHaveBeenCalledTimes(2)
  expect(f.saved?.text).toBe('new')
})
it('preserves a clear in another view and requires explicit choice before saving current text', async () => {
  const f = fixture(doc('old'), input('old')); await f.replica.load()
  const cleared = doc(''); f.saved = cleared
  f.replica.update(input('unsaved edit from old view', 1))
  expect(await f.replica.flush()).toBe(false)
  expect(f.saved).toEqual(cleared)
  expect(f.replica.getSnapshot()).toMatchObject({ status: 'conflict', savedText: '' })
  expect(f.restore).not.toHaveBeenCalled()
  expect(await f.replica.keepCurrent()).toBe(true)
  expect(f.saved?.text).toBe('unsaved edit from old view')
})
it('does not restore a late read into a disposed Session', async () => {
  const f = fixture(undefined, input(), false)
  let finish!:(value: any) => void, started!:() => void
  const began = new Promise<void>(resolve => { started = resolve })
  f.fetch.mockImplementationOnce(async () => { started(); return new Promise(resolve => { finish = resolve }) })
  const loading = f.replica.load(); await began
  await f.replica.dispose(); finish(response(doc('must remain on disk')))
  expect(await loading).toBe(false)
  expect(f.restore).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(0)
})
it('keeps an unsuccessful save visible and does not retry it during view disposal', async () => {
  const f = fixture(doc('old'), input('old')); await f.replica.load()
  f.fetch.mockImplementationOnce(async () => response(undefined, 507))
  f.replica.update(input('keep this browser text', 1))
  expect(await f.replica.flush()).toBe(false)
  expect(f.replica.getSnapshot().status).toBe('error')
  expect(f.restore).not.toHaveBeenCalled()
  const calls = f.fetch.mock.calls.length
  expect(await f.replica.dispose()).toBe(false)
  expect(f.fetch).toHaveBeenCalledTimes(calls)
})
it('retains missing reference and attachment notices until the user acknowledges them', async () => {
  const initial = { ...doc('restored text'), hadReferences: true, hadAttachments: true }
  const f = fixture(initial, input('restored text')); await f.replica.load()
  f.replica.update(input('restored text plus edit', 1)); await f.replica.flush()
  expect(f.saved).toMatchObject({ hadReferences: true, hadAttachments: true })
  f.replica.acknowledgeReferences(); await f.replica.flush()
  expect(f.saved).toMatchObject({ hadReferences: false, hadAttachments: false })
})
it('keeps an edit made after the editor read its boot seed, including an early clear', async () => {
  const saved = doc('saved before boot'), restore = vi.fn(), writes: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); writes.push(body)
    return response({ ...doc(body.text), operationId: body.operationId })
  }))
  const replica = createDraftReplica({ hostId, sessionId, input: input('', 2), restore, seed: { hostId, sessionId, draft: saved, nativeBoot: true } })
  replicas.push(replica)
  expect(await replica.load()).toBe(true)
  expect(await replica.flush()).toBe(true)
  expect(restore).not.toHaveBeenCalled()
  expect(writes[0].text).toBe('')
  expect(writes[0].expectedRevision).toBe(saved.revision)
})
it('does not import over an explicitly empty browser draft', async () => {
  const restore = vi.fn(), replica = createDraftReplica({ hostId, sessionId, input: input(), restore,
    seed: { hostId, sessionId, draft: doc('old disk draft'), browserDraftExisted: true } })
  replicas.push(replica)
  expect(await replica.load()).toBe(false)
  expect(restore).not.toHaveBeenCalled()
  expect(replica.getSnapshot().status).toBe('conflict')
})

it('reports lifecycle metadata without text and does not equate a saved attachment flag with a recoverable handle',async()=>{
  const f=fixture(undefined,input('private generated draft'))
  await f.replica.load();expect(f.replica.inspection()).toMatchObject({persisted:false,hasAttachments:false})
  await f.replica.flush()
  expect(f.replica.inspection()).toMatchObject({persisted:true,inputPhase:'plain',revision:0})
  expect(JSON.stringify(f.replica.inspection())).not.toContain('private generated draft')
  f.replica.update({...input('private generated draft',1),attachmentIds:['private-handle']})
  await f.replica.flush()
  expect(f.replica.inspection()).toMatchObject({persisted:true,hasAttachments:true})
  expect(JSON.stringify(f.replica.inspection())).not.toContain('private-handle')
})

it('marks a draft unpersisted until its actual save completes and requires matching durable content for retired recovery',async()=>{
  const f=fixture();await f.replica.load()
  let done!:()=>void,began!:()=>void
  const ready=new Promise<void>(resolve=>{began=resolve})
  f.intercept(async()=>{began();await new Promise<void>(resolve=>{done=resolve})})
  f.replica.update(input('unmounted text',1));const saving=f.replica.flush();await ready
  expect(f.replica.inspection()).toMatchObject({persisted:false,status:'saving'})
  expect(f.replica.preservedBy(doc(''))).toBe(false)
  done();await saving
  expect(f.replica.preservedBy(f.saved)).toBe(true)
  expect(f.replica.preservedBy({...f.saved!,hostId:'different-host'})).toBe(false)
  expect(f.replica.preservedBy({...f.saved!,sessionId:'different-session'})).toBe(false)
  expect(f.replica.preservedBy({...f.saved!,hadAttachments:true})).toBe(false)
})
