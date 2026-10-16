import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SshApi } from './api.ts'
import type { RemoteDirectoryListing, SshHostSummary } from '../protocol.ts'
import { HostFormDialog } from './panel/HostFormDialog.tsx'
import { ImportHostsDialog } from './panel/ImportHostsDialog.tsx'
import { errorMessage, tt } from './panel/helpers.ts'
import css from './panel/panel.module.css'
import { connectRemoteWorkspace, openRemoteWorkspace } from './remote-workspaces.ts'
import { RemoteErrorNotice } from './RemoteErrorNotice.tsx'

export type WorkspaceFlowProps = DirectoryFlowOwnerProps & { api: SshApi; pickLocal: () => Promise<string | null> }

/** A trailing slash means "show this directory"; a partial last segment filters its parent. */
function suggestionQuery(value: string): { path: string; prefix: string } {
  const path = value.trim()
  if (!path || path === '~' || path.endsWith('/')) return { path: path || '~', prefix: '' }
  const slash = path.lastIndexOf('/')
  return slash < 0 ? { path: '~', prefix: path } : { path: path.slice(0, slash) || '/', prefix: path.slice(slash + 1) }
}

function childPath(parent: string, name: string): string { return (parent === '/' ? '' : parent.replace(/\/$/, '')) + '/' + name }
function parentPath(path: string): string { return path === '/' ? '/' : path.slice(0, path.lastIndexOf('/')) || '/' }

/** Occupies the official directory-flow slot used by both Add workspace controls. */
export function WorkspaceFlow({ open, busy, onPicked, onCancel, api, pickLocal }: WorkspaceFlowProps) {
  const [mode, setMode] = useState<'choose' | 'ssh'>('choose')
  const [hosts, setHosts] = useState<SshHostSummary[]>([])
  const [alias, setAlias] = useState('')
  const [remotePath, setRemotePath] = useState('~')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [browseOpen, setBrowseOpen] = useState(false)
  const [listing, setListing] = useState<RemoteDirectoryListing | null>(null)
  const [browseBusy, setBrowseBusy] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [addingHost, setAddingHost] = useState(false)
  const [editingHost, setEditingHost] = useState<SshHostSummary | null>(null)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [progress, setProgress] = useState('')
  const dialog = useRef<HTMLDivElement>(null)
  const lifetime = useRef<AbortController>()
  const connectButton = useRef<HTMLButtonElement>(null)
  const generation = useRef(0)
  const locked = busy || pending
  useEffect(() => {
    const request = ++generation.current
    if (!open) return
    const controller = new AbortController(); lifetime.current = controller
    setMode('choose'); setAlias(''); setHosts([]); setImporting(false); setError(null); setBrowseError(null); setPending(false); setConnecting(false); setAddingHost(false); setEditingHost(null); setProgress(''); setRemotePath('~'); setSelectedPath(null); setBrowseOpen(false)
    void api.listHosts().then(value => {
      if (request !== generation.current) return
      setHosts(value)
    }).catch(cause => { if (request === generation.current) setError(cause) })
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLElement>('button')?.focus()
    return () => { generation.current++; controller.abort(); previous?.focus() }
  }, [api, open])

  const selectedHostVersion = hosts.find(host => host.alias === alias)?.updatedAt
  useEffect(() => {
    if (open && error && !pending && document.activeElement === document.body) connectButton.current?.focus()
  }, [open, error, pending])

  useEffect(() => {
    if (!open || mode !== 'ssh' || !browseOpen || !alias) { setListing(null); setBrowseBusy(false); return }
    const { path, prefix } = selectedPath === remotePath ? { path: remotePath, prefix: '' } : suggestionQuery(remotePath)
    let active = true
    setBrowseBusy(true); setBrowseError(null); setListing(null)
    const timer = setTimeout(() => {
      void api.browseDirectories(alias, path, prefix).then(value => {
        if (active) setListing(value)
      }).catch(cause => {
        if (active) setBrowseError(errorMessage(cause))
      }).finally(() => { if (active) setBrowseBusy(false) })
    }, 250)
    return () => { active = false; clearTimeout(timer) }
  }, [api, open, mode, browseOpen, alias, remotePath, selectedPath, selectedHostVersion])

  if (!open) return null

  const action = async (run: (active: () => boolean) => Promise<void>): Promise<void> => {
    if (locked) return
    setPending(true); setError(null); setProgress('')
    const request = generation.current
    try { await run(() => request === generation.current) } catch (cause) { if (request === generation.current) setError(cause) }
    finally { if (request === generation.current) { setPending(false); setConnecting(false) } }
  }
  const background = () => {
    generation.current++; lifetime.current?.abort(); setPending(true); setConnecting(false); onCancel()
  }

  // Native sidebars change stacking/containment when collapsed at narrow widths.
  // Keep the dialog above the whole application, including nested host forms.
  return createPortal(<>
    <div className={css.modalBackdrop} onClick={() => { if (!locked && !addingHost && !editingHost && !importing) onCancel() }}>
      <div ref={dialog} className={css.modal} role="dialog" aria-modal="true" aria-label={tt('workspace.add')}
        aria-hidden={addingHost || editingHost || importing ? true : undefined}
        onClick={event => event.stopPropagation()} onKeyDown={event => {
          if (event.key === 'Escape' && !locked && !addingHost && !editingHost && !importing) { event.stopPropagation(); onCancel() }
          if (event.key === 'Tab') {
            const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary') ?? [])
            const first = items[0], last = items.at(-1)
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
            if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
          }
        }}>
        <h3 className={css.modalTitle}>{tt('workspace.add')}</h3>
        <div className={css.formRow}>
          <button type="button" className={css.ghostButton} disabled={locked} onClick={() => { void action(async active => {
            const path = await pickLocal()
            if (path !== null && active()) onPicked(path)
          }) }}>{tt('workspace.local')}</button>
          <button type="button" className={css.primaryButton} disabled={locked} onClick={() => { setMode('ssh') }}>{tt('workspace.ssh')}</button>
        </div>
        {mode === 'ssh' && <>
          <p className={css.hint}>{tt('workspace.help')}</p>
          <label className={css.field}>
            <span className={css.fieldLabel}>{tt('workspace.host')}</span>
            <select className={css.input} value={alias} disabled={locked} onChange={event => { setAlias(event.target.value); setRemotePath('~'); setSelectedPath(null); setBrowseOpen(false); setBrowseError(null); setError(null) }}>
              <option value="">{tt('workspace.chooseHost')}</option>
            {hosts.map(host => <option key={host.alias} value={host.alias}>{host.alias} — {host.user}@{host.host}:{host.port ?? 22}</option>)}
            </select>
          </label>
          <div className={css.formRow}>
            <button type="button" className={css.linkButton} disabled={locked} onClick={() => { setBrowseOpen(false); setAddingHost(true) }}>{tt('hosts.add')}</button>
            <button type="button" className={css.linkButton} disabled={locked || !alias} onClick={() => { setBrowseOpen(false); setEditingHost(hosts.find(host => host.alias === alias) ?? null) }}>{tt('workspace.editAuthentication')}</button>
            <button type="button" className={css.linkButton} disabled={locked} onClick={() => { setBrowseOpen(false); setImporting(true) }}>{tt('hosts.import')}</button>
          </div>
          <label className={css.field}>
            <span className={css.fieldLabel}>{tt('workspace.path')}</span>
            <input className={css.input} value={remotePath} disabled={locked} placeholder="~/projects/my-project" autoComplete="off" spellCheck={false}
              onChange={event => { setRemotePath(event.target.value); setSelectedPath(null); setBrowseOpen(false); setBrowseError(null) }}
              onKeyDown={event => {
                if (event.key === 'ArrowDown') {
                  const first = dialog.current?.querySelector<HTMLElement>('[data-directory-choice]')
                  if (first) { event.preventDefault(); first.focus() }
                }
              }} />
          </label>
          <button type="button" className={css.linkButton} disabled={locked || !alias} aria-expanded={browseOpen}
            onClick={() => setBrowseOpen(value => !value)}>{browseOpen ? tt('workspace.hideDirectories') : tt('workspace.browseDirectories')}</button>
          {browseOpen && alias && <div className={css.browsePanel} aria-label={tt('workspace.directories')}>
            {listing && <div className={css.browseHeader}>
              <button type="button" className={css.linkButton} disabled={locked || listing.path === '/'}
                aria-label={tt('workspace.parentDirectory')} onClick={() => {
                  const parent = parentPath(listing.path)
                  setSelectedPath(null); setRemotePath(parent === '/' ? '/' : parent + '/')
                }}>↑</button>
              <span className={css.browsePath} title={listing.path}>{listing.path}</span>
              {(selectedPath === remotePath || suggestionQuery(remotePath).prefix === '') && <button type="button" className={css.linkButton} disabled={locked}
                onClick={() => { setSelectedPath(listing.path); setRemotePath(listing.path); setBrowseOpen(false) }}>{tt('workspace.useDirectory')}</button>}
            </div>}
            {browseBusy && <p className={css.pickerMessage} role="status">{tt('workspace.loadingDirectories')}</p>}
            {browseError && <div role="alert"><p className={css.formError}>{browseError}</p>
              {/authenticat|password|ssh-agent|private key/i.test(browseError) && <p className={css.hint}>{tt('form.authenticationFailureHint')}</p>}
            </div>}
            {listing && !browseBusy && <div className={css.browseList} role="group" aria-label={tt('workspace.directories')}>
              {listing.directories.map(name => <button key={name} type="button" data-directory-choice=""
                className={css.pickerRow} disabled={locked} onClick={() => { setSelectedPath(null); setRemotePath(childPath(listing.path, name) + '/') }}>▸ &nbsp;{name}</button>)}
              {listing.directories.length === 0 && <p className={css.pickerMessage}>{tt('workspace.noDirectories')}</p>}
              {listing.truncated && <p className={css.pickerMessage}>{tt('workspace.moreDirectories')}</p>}
            </div>}
          </div>}
        </>}
        {error != null && <RemoteErrorNotice error={error} />}
        {pending && progress && <div className={css.remoteWorkspaceFeedback} role="status">
          <div className={css.remoteWorkspaceTarget}>{alias} · {remotePath.trim()}</div>
          <p>{progress}</p><p className={css.hint}>{tt('remote.backgroundHelp')}</p>
        </div>}
        <div className={css.modalFooter}>
          <button type="button" className={css.ghostButton} disabled={locked && !connecting} onClick={connecting ? background : onCancel}>{tt(connecting ? 'remote.background' : 'form.cancel')}</button>
          {mode === 'ssh' && <button ref={connectButton} type="button" className={css.primaryButton} disabled={locked || !alias || !remotePath.trim()}
            onClick={() => { void action(async active => {
              setBrowseOpen(false)
              const options = { signal: lifetime.current?.signal }
              const workspace = await connectRemoteWorkspace(alias, remotePath.trim(), (message, operation) => {
                if (active()) { setProgress(message); setConnecting(!['ready', 'failed'].includes(operation.phase)) }
              }, options)
              if (active()) {
                await openRemoteWorkspace(workspace, undefined, options)
                if (active()) onCancel()
              }
            }) }}>{locked ? tt('workspace.connecting') : tt('workspace.connectAdd')}</button>}
        </div>
      </div>
    </div>
    {addingHost && <HostFormDialog api={api} onClose={() => setAddingHost(false)} onSaved={host => {
      setHosts(previous => [...previous.filter(item => item.alias !== host.alias), host]); setAlias(host.alias); setRemotePath('~'); setSelectedPath(null); setAddingHost(false)
    }} />}
    {editingHost && <HostFormDialog api={api} editing={editingHost} onClose={() => setEditingHost(null)} onSaved={host => {
      setHosts(previous => previous.map(item => item.alias === host.alias ? host : item)); setEditingHost(null); setBrowseError(null); setError(null); setBrowseOpen(false)
    }} />}
    {importing && <ImportHostsDialog api={api} onClose={() => setImporting(false)} onImported={() => {
      setImporting(false)
      void action(async active => {
        const value = await api.listHosts()
        if (active()) { setHosts(value); setAlias(previous => value.some(host => host.alias === previous) ? previous : '') }
      })
    }} />}
  </>, document.body)
}
