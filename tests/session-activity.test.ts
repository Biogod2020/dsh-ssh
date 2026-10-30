import { describe, expect, it, vi } from 'vitest'
import { parseSessionActivity } from '../src/remote/session-activity.ts'

describe('parseSessionActivity', () => {
  it('copies only bounded fields while retaining an unknown provider kind', () => {
    const source = [{ kind: 'third-party-work', ignored: 'not copied', items: [{ id: 'item-1', label: 'Readable item', extra: true }] }]
    expect(parseSessionActivity(source)).toEqual([{ kind: 'third-party-work', items: [{ id: 'item-1', label: 'Readable item' }] }])
  })

  it('runs in a browser-like global without Buffer', () => {
    vi.stubGlobal('Buffer', undefined)
    try {
      expect(parseSessionActivity([{ kind: 'vendor-work', items: [{ id: 'item-1', label: '' }] }])).toEqual([
        { kind: 'vendor-work', items: [{ id: 'item-1', label: '' }] },
      ])
    } finally { vi.unstubAllGlobals() }
  })

  it.each([
    undefined,
    {},
    [{ items: [] }],
    [{ kind: '' }],
    [{ kind: 'job', items: [{}] }],
    [{ kind: 'job', items: [{ id: '' }] }],
    [{ kind: 'job', items: 'not-an-array' }],
    Array.from({ length: 33 }, () => ({ kind: 'job' })),
    [{ kind: 'job', items: Array.from({ length: 101 }, (_, index) => ({ id: String(index) })) }],
    [{ kind: 'x'.repeat(65) }],
    [{ kind: 'job', items: [{ id: 'x'.repeat(257) }] }],
    [{ kind: 'job', items: [{ id: 'item', label: 'x'.repeat(1025) }] }],
    JSON.parse('[{"kind":"job","__proto__":{"polluted":true}}]'),
    JSON.parse('[{"kind":"job","items":[{"id":"x","constructor":"unsafe"}]}]'),
  ])('rejects malformed, oversized, or prototype-dangerous input', value => {
    expect(parseSessionActivity(value)).toBeUndefined()
  })

  it('rejects summaries that exceed the total 64 KiB limit', () => {
    const value = [{ kind: 'job', items: Array.from({ length: 65 }, (_, index) => ({ id: String(index), label: 'x'.repeat(1024) })) }]
    expect(parseSessionActivity(value)).toBeUndefined()
  })
})
