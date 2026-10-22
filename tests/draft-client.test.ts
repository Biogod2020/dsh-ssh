// @vitest-environment jsdom
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { seedDraft, type DraftSeed } from '../src/remote/draft-client.ts'
import { remotePage } from '../src/remote/page.ts'

const hostId = 'a'.repeat(24)
afterEach(() => { localStorage.clear(); delete (window as any).__dshSshDraftSeeds; vi.restoreAllMocks() })
function fixture(text = '生成草稿') : DraftSeed {
  return { hostId, sessionId: 'fixture', draft: { version: 1, hostId, sessionId: 'fixture', text, revision: randomUUID(), operationId: randomUUID(), hadAttachments: false, hadReferences: false, savedAt: 1 } }
}
it('seeds only the addressed native draft and keeps existing browser content', () => {
  const seed = fixture(); localStorage.setItem('unrelated-auth', 'fixture-only')
  seedDraft(seed)
  expect(JSON.parse(localStorage.getItem('dsh.conversation.fixture')!)).toEqual({ draft: seed.draft!.text })
  localStorage.setItem('dsh.conversation.fixture', JSON.stringify({ draft: 'newer unsaved browser text' }))
  seedDraft(fixture('older server text'))
  expect(JSON.parse(localStorage.getItem('dsh.conversation.fixture')!).draft).toBe('newer unsaved browser text')
  expect(localStorage.getItem('unrelated-auth')).toBe('fixture-only')
})
it('retains a recoverable seed and surfaces storage failure without replacing the disk snapshot', () => {
  const seed = fixture()
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Fixture quota') })
  expect(() => seedDraft(seed)).not.toThrow()
  const retained = (window as any).__dshSshDraftSeeds.get(seed.sessionId)
  expect(retained.issue).toContain('Saved text remains')
  expect(retained.draft).toEqual(seed.draft)
})
it('escapes restored text in inline HTML and rejects mismatched Host ownership', () => {
  const seed = fixture('</script><img src=x onerror=alert(1)>')
  const html = remotePage('<html><head></head><body></body></html>', { alias: 'fixture', returnUrl: 'http://127.0.0.1:1/', hostId, recoveryProof: 'fixture', sessionId: seed.sessionId, draftSeed: seed })
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  expect(parsed.querySelector('img')).toBeNull()
  new Function(parsed.head.querySelectorAll('script')[1]!.textContent!)()
  expect(JSON.parse(localStorage.getItem('dsh.conversation.fixture')!).draft).toBe(seed.draft!.text)
  expect(() => seedDraft({ ...seed, hostId: 'b'.repeat(24) })).toThrow('ownership')
})
