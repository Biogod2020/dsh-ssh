import { tt } from './panel/helpers.ts'
import css from './panel/panel.module.css'

/** Strip only this workspace's generated suffix; persisted titles stay intact. */
export function remoteWorkspaceName(workspace: { title: string; alias: string }): string {
  const suffix = ` [SSH:${workspace.alias}]`
  const name = workspace.title.endsWith(suffix) ? workspace.title.slice(0, -suffix.length) : workspace.title
  return name.trim() ? name : workspace.title
}

/** Non-interactive identity: the parent keeps its native click and drag behavior. */
export function createRemoteHostBadge(alias: string, path: string): HTMLSpanElement {
  const badge = document.createElement('span')
  badge.className = css.workspaceHostBadge
  badge.dataset.dshRemoteHost = ''
  badge.setAttribute('role', 'img')
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  for (const [name, value] of Object.entries({ viewBox: '0 0 16 16', width: '14', height: '14', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) icon.setAttribute(name, value)
  const outline = document.createElementNS(icon.namespaceURI, 'path')
  outline.setAttribute('d', 'M9 3H2.5A.5.5 0 0 0 2 3.5v7a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5V7M5 14h5M7.5 11v3M10.5 1.5h4v4M14.5 1.5l-6 6')
  icon.append(outline)
  const host = document.createElement('span'); host.textContent = alias
  badge.append(icon, host)
  updateRemoteHostBadge(badge, alias, path)
  return badge
}

export function updateRemoteHostBadge(badge: HTMLElement, alias: string, path: string): void {
  const label = tt('workspace.remoteHost', { alias })
  badge.setAttribute('aria-label', label)
  badge.title = `${label}\n${path}`
  const host = badge.lastElementChild
  if (host && host.textContent !== alias) host.textContent = alias
}
