import type { Context } from '@deepseek-ai/cordis'
import { useLayoutEffect, useRef } from 'react'

const PANEL_ID = 'ssh-remote-workspace'
export type DesktopShellContext = Pick<Context, 'get' | 'slots'>
/** Native main-panel ownership, with the guest kept attached outside React. */
export function mountDesktopWorkspaceSeat(ctx: DesktopShellContext, update: (visible: boolean, bounds?: DOMRect) => void) {
  const layout = ctx.get('layout') as {
    selectPanel(id: string | null): void
    panelInfo: { getSnapshot(): { activePanelId: unknown }; subscribe(fn: () => void): () => void }
  } | undefined
  if (typeof layout?.selectPanel !== 'function' || typeof layout.panelInfo?.subscribe !== 'function'
    || typeof layout.panelInfo.getSnapshot !== 'function') return undefined
  const slots = ctx.slots as unknown as {
    inject(name: string, fn: () => () => void): () => void
    register(options: object, component: unknown): () => void
  }
  let anchor: HTMLElement | undefined, disposed = false
  const inert = new Map<HTMLElement, boolean>()
  const restore = () => { for (const [node, value] of inert) node.inert = value; inert.clear() }
  const sync = () => {
    if (disposed) return
    const visible = layout.panelInfo.getSnapshot().activePanelId === PANEL_ID && !!anchor?.isConnected
    let bounds = anchor?.getBoundingClientRect()
    // The guest owns its remote Files/Terminal pane as well. Cover and silence
    // the local right pane without changing the user's saved pane preference.
    const frame = anchor?.closest('[class*="centerCol"]')?.parentElement
    if (visible && frame) {
      for (const child of frame.querySelectorAll<HTMLElement>(':scope > [class*="rightbarCol"]')) {
        if (!inert.has(child)) inert.set(child, child.inert)
        child.inert = true
      }
      const right = frame.getBoundingClientRect().right
      if (bounds && Number.isFinite(right) && right > bounds.left) bounds = new DOMRect(bounds.left, bounds.top, right - bounds.left, bounds.height)
    } else restore()
    update(visible, bounds)
  }
  function Page() {
    const seat = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => {
      anchor = seat.current ?? undefined
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : undefined
      if (anchor) observer?.observe(anchor)
      sync()
      return () => { observer?.disconnect(); anchor = undefined; sync() }
    }, [])
    return <div ref={seat} data-dsh-remote-seat="" style={{ width: '100%', height: '100%', minWidth: 0, minHeight: 0 }} />
  }
  const release = slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, Page))
  // Guests are process-owned. A persisted panel selection cannot restore a
  // vanished lease after restart; start in the user's local conversation.
  if (layout.panelInfo.getSnapshot().activePanelId === PANEL_ID) layout.selectPanel(null)
  const unsubscribe = layout.panelInfo.subscribe(sync)
  window.addEventListener('resize', sync); window.addEventListener('scroll', sync, true)
  return {
    select: () => { layout.selectPanel(PANEL_ID); sync() },
    hide: () => { if (layout.panelInfo.getSnapshot().activePanelId === PANEL_ID) layout.selectPanel(null) },
    dispose: () => {
      disposed = true; restore(); unsubscribe(); release(); window.removeEventListener('resize', sync); window.removeEventListener('scroll', sync, true)
      if (layout.panelInfo.getSnapshot().activePanelId === PANEL_ID) layout.selectPanel(null)
    },
  }
}
