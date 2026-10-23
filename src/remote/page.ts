import { navigationManifest } from './navigation-client.ts'
import { seedDraft, type DraftSeed } from './draft-client.ts'
import { embeddedClipboard } from './clipboard-client.ts'

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const jsonScript = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c')

/** Serialized into the remote page. No closure captures, credentials or command retries. */
function connectionLamp(recovery: { returnUrl: string; hostId: string; proof: string }): void {
  type State = 'checking' | 'ready' | 'lost' | 'offline' | 'unknown'
  let state: State = 'checking', failures = 0, disposed = false, epoch = 0
  let timer: ReturnType<typeof setTimeout> | undefined, request: AbortController | undefined
  const bar = document.querySelector<HTMLElement>('#dsh-remote-host')
  const reopen = document.querySelector<HTMLAnchorElement>('#dsh-remote-recover')
  const label = document.querySelector<HTMLElement>('#dsh-remote-status')
  const help = document.querySelector<HTMLElement>('#dsh-remote-help')
  const back = document.querySelector<HTMLAnchorElement>('#dsh-remote-back')
  const backFull = document.querySelector<HTMLElement>('#dsh-remote-back-full')
  const backCompact = document.querySelector<HTMLElement>('#dsh-remote-back-compact')
  const write = (node: HTMLElement | null, value: string) => { if (node && node.textContent !== value) node.textContent = value }
  reopen?.addEventListener('click', () => {
    let sessionId: string | undefined
    try {
      const saved = JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: unknown }
      if (typeof saved.sessionId === 'string' && saved.sessionId.length <= 256 && !/[\u0000-\u001f\u007f]/.test(saved.sessionId)) sessionId = saved.sessionId
    } catch { /* Missing browser selection falls back to the last remote session. */ }
    const url = new URL(recovery.returnUrl)
    url.hash = new URLSearchParams({ 'dsh-ssh-recover': JSON.stringify({ hostId: recovery.hostId, proof: recovery.proof, sessionId }) }).toString()
    reopen.href = url.href
  })
  const measure = () => {
    const height = bar?.getBoundingClientRect().height
    if (height) document.body.style.setProperty('--dsh-remote-bar-height', Math.ceil(height) + 'px')
  }
  const render = () => {
    if (disposed) return
    const en = document.documentElement.lang.toLowerCase().startsWith('en')
    const labels = en
      ? { checking: 'Checking connection', ready: 'Connected', lost: 'Connection lost', offline: 'Browser offline', unknown: 'Status unconfirmed' }
      : { checking: '正在检查连接', ready: '已连接', lost: '连接已中断', offline: '浏览器离线', unknown: '状态待确认' }
    if (bar) bar.dataset.state = state
    write(label, labels[state]); write(backFull, en ? 'Local workspaces ↗' : '本机工作区 ↗'); write(backCompact, en ? 'Local ↗' : '本机 ↗')
    back?.setAttribute('aria-label', en ? 'Local workspaces' : '本机工作区')
    write(reopen, en ? 'Recover original session ↗' : '恢复原会话 ↗')
    write(help, en ? 'Keep this tab for your draft. Submitted operations will not be replayed.' : '保留此标签中的草稿；已提交操作不会重放。')
    const showRecovery = state === 'lost' && failures >= 2
    if (reopen) reopen.hidden = !showRecovery
    if (help) help.hidden = !showRecovery
    if (bar) bar.dataset.recovery = String(showRecovery)
    for (const row of document.querySelectorAll('[role="treeitem"][class*="projectRow"]')) {
      if (row.querySelector('[data-dsh-remote-lamp]')) continue
      const text = row.querySelector('[class*="projectText"]')
      if (!text) continue
      const dot = document.createElement('span'); dot.dataset.dshRemoteLamp = ''; dot.setAttribute('role', 'img')
      text.before(dot)
    }
    for (const lamp of document.querySelectorAll<HTMLElement>('#dsh-remote-lamp,[data-dsh-remote-lamp]')) {
      lamp.dataset.state = state; lamp.setAttribute('aria-label', 'SSH · ' + labels[state]); lamp.title = labels[state]
    }
    measure()
  }
  const observer = new MutationObserver(render)
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['lang'] })
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined
  if (bar) resize?.observe(bar)
  const active = () => !disposed && !document.hidden && navigator.onLine
  const poll = async () => {
    if (!active()) return
    const current = ++epoch, controller = new AbortController(); request = controller
    const deadline = setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetch('/__dsh_remote/status', { cache: 'no-store', signal: controller.signal })
      const value = await response.json()
      if (current !== epoch || !active()) return
      state = response.ok && value.ready === true ? 'ready' : 'lost'
      failures = state === 'ready' ? 0 : failures + 1
    } catch {
      if (current !== epoch || !active()) return
      state = 'lost'; failures++
    } finally {
      clearTimeout(deadline)
      if (current === epoch && active()) { request = undefined; render(); timer = setTimeout(() => { void poll() }, 5000) }
    }
  }
  const refresh = () => {
    clearTimeout(timer); epoch++; request?.abort(); request = undefined
    state = !navigator.onLine ? 'offline' : document.hidden ? 'unknown' : 'checking'; render()
    if (active()) void poll()
  }
  document.addEventListener('visibilitychange', refresh); window.addEventListener('offline', refresh); window.addEventListener('online', refresh)
  const pageHide = (event: PageTransitionEvent) => {
    if (event.persisted) { clearTimeout(timer); epoch++; request?.abort(); state = 'unknown'; render(); return }
    disposed = true; epoch++; clearTimeout(timer); request?.abort(); observer.disconnect(); resize?.disconnect()
    document.removeEventListener('visibilitychange', refresh); window.removeEventListener('offline', refresh); window.removeEventListener('online', refresh)
    window.removeEventListener('pageshow', refresh); window.removeEventListener('pagehide', pageHide)
  }
  window.addEventListener('pagehide', pageHide); window.addEventListener('pageshow', refresh)
  refresh()
}

/** Host identity stays visible while the remote service owns native workspace/session navigation. */
export function remotePage(html: string, options: { alias: string; returnUrl: string; hostId: string; recoveryProof: string; sessionId?: string; embedded?: boolean; draftSeed?: DraftSeed }): string {
  if (options.draftSeed && (options.draftSeed.hostId !== options.hostId || options.draftSeed.sessionId !== options.sessionId)) throw new Error('Invalid saved draft ownership')
  const init = (options.sessionId ? `<script>localStorage.setItem('dsh.sessions.current',${jsonScript(JSON.stringify({ sessionId: options.sessionId }))});</script>` : '')
    + (options.draftSeed ? `<script>(${seedDraft.toString()})(${jsonScript(options.draftSeed)},true);</script>` : '')
    + (options.embedded ? `<script>(${embeddedClipboard.toString()})();</script>` : '')
  const bar = `<div id="dsh-remote-host" data-state="checking" data-recovery="false"${options.embedded ? ' data-desktop="true"' : ''} aria-label="SSH">
    <div class="dsh-remote-identity"><span class="dsh-remote-tag">SSH</span><strong title="${escapeHtml(options.alias)}">${escapeHtml(options.alias)}</strong></div>
    <div class="dsh-remote-connection"><span id="dsh-remote-lamp" role="img" aria-label="SSH checking"></span><span id="dsh-remote-status" role="status" aria-live="polite"></span></div>
    <a id="dsh-remote-back" href="${escapeHtml(options.returnUrl)}"><span id="dsh-remote-back-full"></span><span id="dsh-remote-back-compact"></span></a>
    <p id="dsh-remote-help" hidden></p>
    <a id="dsh-remote-recover" href="${escapeHtml(options.returnUrl)}" target="_blank" rel="noopener noreferrer" hidden></a>
  </div>
  <style>
    body{padding-top:var(--dsh-remote-bar-height,48px)!important;box-sizing:border-box!important}
    #root{height:calc(100dvh - var(--dsh-remote-bar-height,48px))!important}
    #dsh-remote-host{box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:0 16px;padding:0 16px;min-height:48px;background:var(--dsw-alias-bg-layer-1,#f6f7f9);color:var(--dsw-alias-label-primary,#242831);border-bottom:1px solid var(--dsw-alias-border-l1,#dfe2e7);font:12px/1.5 system-ui;position:fixed;inset:0 0 auto;z-index:2147483647}
    #dsh-remote-host [hidden]{display:none}
    #dsh-remote-host[data-desktop] #dsh-remote-back,#dsh-remote-host[data-desktop] #dsh-remote-recover{display:none!important}
    .dsh-remote-identity{display:flex;align-items:center;gap:8px;min-width:0;height:47px}
    .dsh-remote-identity strong{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .dsh-remote-tag{font-size:10px;font-weight:650;letter-spacing:.06em;padding:2px 5px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2,#d5d9e0);color:var(--dsw-alias-label-secondary,#636b77);flex-shrink:0}
    .dsh-remote-connection{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,#636b77);white-space:nowrap}
    #dsh-remote-lamp,[data-dsh-remote-lamp]{display:inline-block;width:7px;height:7px;flex:0 0 7px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#8a929e)}
    [data-dsh-remote-lamp]{margin-right:6px}
    #dsh-remote-lamp[data-state=ready],[data-dsh-remote-lamp][data-state=ready]{background:var(--dsw-alias-state-success-primary,#26966b)}
    #dsh-remote-lamp[data-state=lost],[data-dsh-remote-lamp][data-state=lost]{background:var(--dsw-alias-state-warning-primary,#bc7b24)}
    #dsh-remote-host a{color:var(--dsw-alias-state-business-primary,#416fd6);text-decoration:none;border-radius:4px}
    #dsh-remote-host a:hover{text-decoration:underline}
    #dsh-remote-host a:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#416fd6);outline-offset:4px}
    #dsh-remote-back{white-space:nowrap}
    #dsh-remote-back-compact{display:none}
    #dsh-remote-help{grid-column:1/3;font-size:11px;color:var(--dsw-alias-label-secondary,#636b77);margin:0 0 10px;overflow-wrap:anywhere}
    #dsh-remote-recover{grid-column:3;justify-self:end;margin-bottom:10px;font-weight:600;white-space:nowrap}
    @media(max-width:640px){#dsh-remote-host{padding:0 10px;gap:0 10px;font-size:11px}#dsh-remote-back-full{display:none}#dsh-remote-back-compact{display:inline}#dsh-remote-help{grid-column:1/-1;margin-bottom:6px}#dsh-remote-recover{grid-column:1/-1;justify-self:start}}
  </style>
  <script>(${connectionLamp.toString()})(${jsonScript({ returnUrl: options.returnUrl, hostId: options.hostId, proof: options.recoveryProof })});</script>`
  const docked = options.embedded ? `<style>
    html,body{background:var(--dsw-alias-bg-base,#141414)!important}
    body{padding-top:0!important;--dsh-remote-bar-height:0px!important}
    #root{height:100dvh!important}
    [class*="sidebarCol"]{visibility:hidden!important;pointer-events:none!important}
    [style*="grid-template-columns"]:has(>[class*="sidebarCol"]){grid-template-columns:var(--dsh-remote-columns,0px minmax(0,1fr) 0px)!important}
    #dsh-remote-host{display:none!important}
    #dsh-remote-back,#dsh-remote-recover{display:none!important}
  </style><script>(${embeddedWorkspace.toString()})();</script>` : ''
  return html.replace(/<head([^>]*)>/i, `<head$1>${init}`)
    .replace(/<\/head>/i, `${options.embedded ? `<script>(${navigationManifest.toString()})();</script>` : ''}</head>`)
    .replace(/<body([^>]*)>/i, `<body$1>${bar}${docked}`)
}

/** Keep one outer project sidebar; this guest retains its own Host context. */
function embeddedWorkspace(): void {
  let frame: number | undefined
  const sync = () => {
    frame = undefined
    for (const sidebar of document.querySelectorAll<HTMLElement>('[class*="sidebarCol"]')) {
      sidebar.inert = true
      const shell = sidebar.parentElement
      const columns = shell?.style.gridTemplateColumns
      if (!shell || !columns) continue
      const rest = columns.replace(/^\S+\s+/, '')
      const value = `0px ${rest}`
      if (shell.style.getPropertyValue('--dsh-remote-columns') !== value) shell.style.setProperty('--dsh-remote-columns', value)
    }
  }
  const observer = new MutationObserver(() => { if (frame === undefined) frame = requestAnimationFrame(sync) })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
  window.addEventListener('pagehide', () => { observer.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame) }, { once: true })
  sync()
}
