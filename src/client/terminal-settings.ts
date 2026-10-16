import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope, SettingsScopeSpec } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TerminalFontSource } from './panel/helpers.ts'

interface TerminalSettings { terminalFontFamily?: string }
interface Form {
  getSnapshot(): { status: string; value?: TerminalSettings }
  subscribe(listener: () => void): () => void
}
interface ConfigForms { get<T>(entryId: string): Form }
interface LegacyBinder { bind<S>(spec: SettingsScopeSpec<S>): SettingsScope<S> }

/** Late settings activation never holds the SSH UI hostage on either SDK. */
export function terminalSettings(ctx: Context): TerminalFontSource {
  const forms = new Map<number, Form>()
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  const attach = (form: Form, priority: number): (() => void) => {
    forms.set(priority, form)
    const unsubscribe = form.subscribe(notify)
    notify()
    return () => { unsubscribe(); forms.delete(priority); notify() }
  }
  ctx.inject(['settingsScope'], provider => {
    const binder = (provider.get('webUiSettings') ?? provider.get('settingsScope')) as LegacyBinder
    provider.effect(() => attach(binder.bind<TerminalSettings>({ namespace: 'dsh-ssh' }), 0), 'dsh-ssh: alpha terminal settings')
  })
  ctx.inject(['configForms'], provider => {
    const service = provider.get('configForms') as ConfigForms
    provider.effect(() => attach(service.get<TerminalSettings>('ssh-ops'), 1), 'dsh-ssh: native terminal settings')
  })
  return {
    get: () => {
      for (const priority of [1, 0]) {
        const snapshot = forms.get(priority)?.getSnapshot()
        if (snapshot?.status === 'ready') return snapshot.value?.terminalFontFamily
      }
      return undefined
    },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
