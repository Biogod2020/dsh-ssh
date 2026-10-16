/**
 * The SSH operations panel shell: a header with a close control, a five-tab
 * bar, and the active tab's content. Visited tabs remain mounted, preserving
 * terminal connections, drafts and transfer progress across navigation.
 * The hosts tab's connect action switches here to the terminal
 * tab with the chosen alias preselected.
 */
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SshApi } from '../api.ts'
import type { PanelController } from './controller.ts'
import { tt, type TerminalFontSource } from './helpers.ts'
import { ClusterTab } from './ClusterTab.tsx'
import { HostsTab } from './HostsTab.tsx'
import { TerminalSessions } from './TerminalSessions.tsx'
import { TransferTab } from './TransferTab.tsx'
import { TunnelsTab } from './TunnelsTab.tsx'
import css from './panel.module.css'

/** The panel's tab identifiers. */
export type SshTab = 'hosts' | 'terminal' | 'transfer' | 'tunnels' | 'cluster'

/** Panel shell props. */
export interface SshPanelProps {
  /** The panel state owner (open/close/toggle). */
  controller: PanelController
  /** The SSH API client every tab operates through. */
  api: SshApi
  /** Live terminal-font setting source handed to the terminal tab (issue #577). */
  terminalFont?: TerminalFontSource
}

/** The tab bar definition (labels resolved at render time). */
const TABS: ReadonlyArray<{ id: SshTab; label: () => string }> = [
  { id: 'hosts', label: () => tt('tab.hosts') },
  { id: 'terminal', label: () => tt('tab.terminal') },
  { id: 'transfer', label: () => tt('tab.transfer') },
  { id: 'tunnels', label: () => tt('tab.tunnels') },
  { id: 'cluster', label: () => tt('tab.cluster') },
]

/** A pending "connect this host" request handed to the terminal tab. */
interface ConnectRequest {
  alias: string
  nonce: number
}

/** The tabbed SSH panel. */
export function SshPanel({ controller, api, terminalFont }: SshPanelProps) {
  const panelOpen = useSyncExternalStore(
    useCallback(listener => controller.subscribe(listener), [controller]),
    useCallback(() => controller.getSnapshot().panelOpen, [controller]),
  )
  const [activeTab, setActiveTab] = useState<SshTab>('hosts')
  const [visited, setVisited] = useState<Set<SshTab>>(() => new Set(['hosts']))
  const [connectRequest, setConnectRequest] = useState<ConnectRequest | null>(null)
  const tabBar = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const bar = tabBar.current
    if (!bar || !panelOpen) return
    const reveal = (): void => {
      const selected = bar.querySelector<HTMLElement>('[aria-selected="true"]')
      if (!selected) return
      const bounds = bar.getBoundingClientRect(), width = bar.clientWidth || bounds.width
      if (width <= 0) return
      const item = selected.getBoundingClientRect(), left = item.left - bounds.left + bar.scrollLeft, right = left + item.width
      if (left < bar.scrollLeft) bar.scrollLeft = Math.max(0, left)
      else if (right > bar.scrollLeft + width) bar.scrollLeft = right - width
    }
    reveal()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(reveal)
    observer?.observe(bar); window.addEventListener('resize', reveal)
    return () => { observer?.disconnect(); window.removeEventListener('resize', reveal) }
  }, [activeTab, panelOpen])

  const selectTab = (tab: SshTab): void => {
    setVisited(previous => new Set([...previous, tab]))
    setActiveTab(tab)
  }

  const handleConnect = (alias: string): void => {
    selectTab('terminal')
    setConnectRequest(prev => ({ alias, nonce: (prev?.nonce ?? 0) + 1 }))
  }

  return (
    <div className={css.panel} data-dsh-plugin="ssh">
      <div className={css.panelHeader}>
        {/* Shared hook: dsh-web-all offsets center-view back controls beside the collapsed mobile sidebar. */}
        <button
          type="button"
          className={`${css.ghostButton} ${css.backButton}`}
          aria-label={tt('panel.backToConversation')}
          data-dsh-center-view-back=""
          onClick={() => { controller.close() }}
        >
          <span aria-hidden="true">‹</span>
          <span>{tt('panel.backToConversation')}</span>
        </button>
        <h2 className={css.panelTitle}>{tt('panel.title')}</h2>
      </div>
      <div ref={tabBar} className={css.tabBar} role="tablist" data-dsh-part="tab-bar">
        {TABS.map(tab => (
          <button key={tab.id} id={`ssh-tab-${tab.id}`} type="button" role="tab" aria-controls={`ssh-pane-${tab.id}`} aria-selected={activeTab === tab.id} data-active={activeTab === tab.id ? '' : undefined} data-dsh-part="tab" className={css.tab} onClick={() => { selectTab(tab.id) }}>
            {tab.label()}
          </button>
        ))}
      </div>
      <div className={css.panelContent}>
        {TABS.filter(tab => visited.has(tab.id)).map(tab => <section key={tab.id}
          id={`ssh-pane-${tab.id}`} role="tabpanel" aria-labelledby={`ssh-tab-${tab.id}`}
          hidden={activeTab !== tab.id} className={css.tabPane}>
          {tab.id === 'hosts' && <HostsTab api={api} onConnect={handleConnect} active={panelOpen && activeTab === 'hosts'} />}
          {tab.id === 'terminal' && <TerminalSessions api={api} presetAlias={connectRequest?.alias} requestId={connectRequest?.nonce} terminalFont={terminalFont} visible={panelOpen && activeTab === 'terminal'} />}
          {tab.id === 'transfer' && <TransferTab api={api} active={panelOpen && activeTab === 'transfer'} />}
          {tab.id === 'tunnels' && <TunnelsTab api={api} active={panelOpen && activeTab === 'tunnels'} />}
          {tab.id === 'cluster' && <ClusterTab api={api} active={panelOpen && activeTab === 'cluster'} />}
        </section>)}
      </div>
    </div>
  )
}
