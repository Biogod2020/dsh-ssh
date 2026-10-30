/** A bounded, presentation-safe subset of a Host archive-admission refusal. */
export interface SessionActivityItemSummary {
  id: string
  label?: string
}

/** Unknown provider kinds are retained; callers must not interpret them as commands. */
export interface SessionActivitySummary {
  kind: string
  items?: SessionActivityItemSummary[]
}

const maxActivity = 32
const maxItems = 100
const maxKindLength = 64
const maxIdLength = 256
const maxLabelLength = 1024
const maxBytes = 64 * 1024
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype'])
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)
const textEncoder = new TextEncoder()

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  for (const key of Object.keys(value)) if (unsafeKeys.has(key)) return undefined
  return value as Record<string, unknown>
}

function string(value: unknown, maxLength: number, required = false): string | undefined {
  return typeof value === 'string' && value.length <= maxLength && (!required || value.length > 0) ? value : undefined
}

/**
 * Copy only the activity fields the native archive dialog displays. This is a
 * protocol parser, not a generic error-details serializer.
 */
export function parseSessionActivity(value: unknown): SessionActivitySummary[] | undefined {
  if (!Array.isArray(value) || value.length > maxActivity) return undefined
  let bytes = 2
  const activity: SessionActivitySummary[] = []
  for (const entryValue of value) {
    const entry = record(entryValue), kind = entry && string(entry.kind, maxKindLength, true)
    if (!entry || kind === undefined) return undefined
    bytes += textEncoder.encode(kind).byteLength + 16
    if (bytes > maxBytes) return undefined
    if (!own(entry, 'items')) { activity.push({ kind }); continue }
    if (!Array.isArray(entry.items) || entry.items.length > maxItems) return undefined
    const items: SessionActivityItemSummary[] = []
    for (const itemValue of entry.items) {
      const item = record(itemValue), id = item && string(item.id, maxIdLength, true)
      if (!item || id === undefined) return undefined
      const output: SessionActivityItemSummary = { id }
      bytes += textEncoder.encode(id).byteLength + 12
      if (own(item, 'label')) {
        const label = string(item.label, maxLabelLength)
        if (label === undefined) return undefined
        output.label = label
        bytes += textEncoder.encode(label).byteLength + 12
      }
      if (bytes > maxBytes) return undefined
      items.push(output)
    }
    activity.push({ kind, items })
  }
  return activity
}
