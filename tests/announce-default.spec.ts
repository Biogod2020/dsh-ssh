/**
 * Announcement default (issue #839): announceToAgent resolves to false so
 * agent system prompts stay clean unless the user opts in.
 */
import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import { configValues } from '../src/settings.ts'

describe('announcement default (issue #839)', () => {
  it('resolves announceToAgent to false by default', () => {
    const value = configValues(Config({}))
    expect(value.announceToAgent).toBe(false)
    expect(value.enabled).toBe(true)
  })

  it('keeps an explicit true override', () => {
    const value = configValues(Config({ announceToAgent: true }))
    expect(value.announceToAgent).toBe(true)
  })
})
