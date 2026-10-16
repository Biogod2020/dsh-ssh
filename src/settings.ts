import z from '@deepseek-ai/schemastery'
import legacySchema from 'schemastery'

type Live<T> = T | { get(): T }
export interface Config {
  announceToAgent?: Live<boolean>
  enabled?: Live<boolean>
  terminalFontFamily?: Live<string>
}
export interface ConfigValues { announceToAgent: boolean; enabled: boolean; terminalFontFamily: string }

/** Native 0.2 forms update these references without remounting SSH sessions. */
export const Config: z = z.object({
  announceToAgent: z.boolean().default(false).volatile(),
  enabled: z.boolean().default(true).volatile(),
  terminalFontFamily: z.string().default('').volatile(),
})

/** Alpha's settings provider owns plain values in its separate namespace. */
export const LegacyConfig: legacySchema<ConfigValues> = legacySchema.object({
  announceToAgent: legacySchema.boolean().default(false),
  enabled: legacySchema.boolean().default(true),
  terminalFontFamily: legacySchema.string().default(''),
})

function read<T extends boolean | string>(value: Live<T> | undefined, fallback: T): T {
  return value !== null && typeof value === 'object' ? value.get() : value ?? fallback
}

export function configValues(config: Config = {}): ConfigValues {
  return {
    announceToAgent: read(config.announceToAgent, false),
    enabled: read(config.enabled, true),
    terminalFontFamily: read(config.terminalFontFamily, ''),
  }
}
