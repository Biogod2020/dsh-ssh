/** Native 0.2 navigation with a retained panel tree; older shells use the DOM mount. */
import type { Context } from '@deepseek-ai/cordis'
import { useLayoutEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SshApi } from './api.ts'
import type { PanelController } from './panel/controller.ts'
import { SshPanel } from './panel/SshPanel.tsx'
import { tt, type TerminalFontSource } from './panel/helpers.ts'
import type { LocaleRefreshSource } from './sidebar-entry.ts'
import css from './panel/panel.module.css'

const PANEL_ID = 'ssh-ops'
interface Layout {
  selectPanel(id: string | null): void
  panelInfo: { getSnapshot(): { activePanelId: unknown }; subscribe(listener: () => void): () => void }
}
interface Slots {
  inject(name: string, callback: () => () => void): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** The native shell owns labels, focus, collapsed navigation and main selection. */
function Icon({ size }: { size: number }) {
  return <svg data-dsh-panel-entry={PANEL_ID} viewBox="0 0 16 16" width={size} height={size}
    fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.75" />
    <path d="m4.25 5.25 2.75 2.75-2.75 2.75M8.5 10.75h3.25" />
  </svg>
}

/** Return undefined when this shell has no native panel-navigation face. */
export function mountNativeSshPanel(ctx: Pick<Context, 'get' | 'slots'>, controller: PanelController,
  api: SshApi, terminalFont?: TerminalFontSource, locale?: LocaleRefreshSource,
): (() => void) | undefined {
  const layout = ctx.get('layout') as Partial<Layout> | undefined
  if (typeof layout?.selectPanel !== 'function' || typeof layout.panelInfo?.subscribe !== 'function'
    || typeof layout.panelInfo.getSnapshot !== 'function') return undefined
  const native = layout as Layout
  // Structural faces keep the old SDK build and legacy runtime compatible.
  const slots = ctx.slots as unknown as Slots
  const parking = document.createDocumentFragment()
  const view = document.createElement('div')
  view.dataset.dshSshView = ''; view.dataset.dshPlugin = 'ssh'
  view.className = `${css.view} ${css.nativeView}`
  parking.append(view)
  let root: Root | undefined, syncing = false, disposed = false
  const render = () => root?.render(<SshPanel controller={controller} api={api} terminalFont={terminalFont} />)
  function Page() {
    const seat = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => {
      if (disposed || !seat.current) return
      seat.current.append(view)
      if (!root) { root = createRoot(view); render() }
      return () => { parking.append(view) }
    }, [])
    return <div ref={seat} className={css.nativeMount} />
  }
  const releases: Array<() => void> = []
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const release of releases.splice(0).reverse()) release()
    if (native.panelInfo.getSnapshot().activePanelId === PANEL_ID) native.selectPanel(null)
    root?.unmount(); root = undefined; view.remove()
  }
  try {
    // Wait for both owning seats before publishing a selectable sidebar row.
    releases.push(slots.inject('main', () => {
      const removePage = slots.register({ name: 'main', key: PANEL_ID }, Page)
      let removeRow: () => void
      try {
        removeRow = slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => tt('entry.label'),
        }, Icon))
      } catch (error) { removePage(); throw error }
      return () => { removeRow(); removePage() }
    }))
    const syncFromLayout = () => {
      syncing = true
      try {
        if (native.panelInfo.getSnapshot().activePanelId === PANEL_ID) controller.open()
        else controller.close()
      } finally { syncing = false }
    }
    releases.push(native.panelInfo.subscribe(syncFromLayout))
    releases.push(controller.subscribe(() => {
      if (syncing) return
      const selected = native.panelInfo.getSnapshot().activePanelId
      if (controller.getSnapshot().panelOpen) {
        if (selected !== PANEL_ID) native.selectPanel(PANEL_ID)
      } else if (selected === PANEL_ID) native.selectPanel(null)
    }))
    if (locale) releases.push(locale.subscribe(render))
    syncFromLayout()
    return dispose
  } catch (error) { dispose(); throw error }
}
