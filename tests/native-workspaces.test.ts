// @vitest-environment jsdom
import { expect, it,vi } from 'vitest'
// This file tests the data projection; the browser supplies this platform UI.
vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({MenuItemButton:()=>null}))
import { combineNavigation } from '../src/client/native-workspaces.tsx'
import { remoteSessionKey, remoteWorkspaceKey, resolveRemoteNavigation } from '../src/client/remote-navigation.ts'

it('keeps the local Host immutable while projecting same-id sessions from separate Hosts into native folder rows', () => {
  const local = { ids: ['same'], byId: { same: { id: 'same', displayTitle: 'Local', running: false, blank: false, updatedAt: 1, retainedBy: { mainView: 1 } } } }
  const workspaces = { items: [{ workspaceId: 'same', path: '/local', title: 'Local', sessionIds: ['same'] }] }
  const a = { id: 'one', hostId: 'a'.repeat(24), alias: 'a', title: 'Remote A', remotePath: '/a', workspaceId: 'same' }
  const b = { ...a, id: 'two', hostId: 'b'.repeat(24), alias: 'b', title: 'Remote B' }
  const remote = { workspaces: [a, b], native: true, catalogs: new Map([a, b].map(workspace => [workspace.id, { workspaceId: workspace.workspaceId, stale: false,
    sessions: [{ sessionId: 'same', title: workspace.title, running: true, blank: true, updatedAt: 2 }] }])) }
  const before = JSON.stringify({ local, workspaces })
  const combined = combineNavigation(local, workspaces, remote, { workspaceId: b.id, sessionId: 'same' })
  expect(JSON.stringify({ local, workspaces })).toBe(before)
  expect(new Set(combined.list.ids).size).toBe(3)
  expect(combined.workspaces.items.map(item => item.workspaceId)).toEqual(['same', remoteWorkspaceKey(a), remoteWorkspaceKey(b)])
  expect(combined.list.byId.same!.retainedBy.mainView).toBe(0)
  expect(combined.list.byId[remoteSessionKey(b, 'same')]!.retainedBy.mainView).toBe(1)
  expect(combined.list.byId[remoteSessionKey(a, 'same')]!.blank).toBe(false) // Host blanks must remain visible, not look like local reusable blanks.
  expect(resolveRemoteNavigation(remoteSessionKey(b, 'same'), remote)).toEqual({ workspace: b, sessionId: 'same' })
})

it('retains legacy history and gives an unread remote project an explicit navigation row without creating a Session', () => {
  const workspace = { id: 'one', hostId: 'a'.repeat(24), alias: 'a', title: 'Remote A', remotePath: '/a', workspaceId: 'same' }
  const legacy = { workspaceId: 'history', title: 'jay [SSH:macbook]', path: '/private/ssh-workspaces/identity', sessionIds: ['old'] }
  const remote = { native: true, workspaces: [workspace], catalogs: new Map() }
  const combined = combineNavigation({ ids: [], byId: {} }, { items: [legacy] }, remote)
  expect(combined.workspaces.items[0]!.title).toContain('本机历史')
  expect(legacy.title).toBe('jay [SSH:macbook]')
  expect(combined.workspaces.items[0]!.sessionIds).toEqual(['old'])
  expect(combined.list.ids).toEqual([remoteSessionKey(workspace)])
  expect(combined.list.byId[remoteSessionKey(workspace)]!.title).toContain('加载')
})

it('keeps the parked local blank Session addressable when the remote view owns the highlight', () => {
  const local = { ids: ['draft'], byId: { draft: { id: 'draft', displayTitle: 'Local draft', blank: true, running: false, updatedAt: 1, retainedBy: { mainView: 1 } } } }
  const combined = combineNavigation(local, { items: [] }, { native: true, workspaces: [], catalogs: new Map() }, { workspaceId: 'remote', sessionId: 'other' })
  expect(combined.list.byId.draft!.blank).toBe(false)
  expect(combined.list.byId.draft!.retainedBy.mainView).toBe(0)
  expect(local.byId.draft.blank).toBe(true)
  expect(local.byId.draft.retainedBy.mainView).toBe(1)
})

it('shortens only the matching generated remote suffix without changing host identity or stored titles', () => {
  const a = { id: 'a', hostId: 'a'.repeat(24), alias: 'macbook', title: 'file-search [SSH:macbook]', remotePath: '/a', workspaceId: 'same' }
  const b = { ...a, id: 'b', hostId: 'b'.repeat(24), alias: 'headcw', title: 'file-search [SSH:headcw]' }
  const local = { workspaceId: 'local', path: '/local', title: a.title, sessionIds: [] }
  const before = JSON.stringify({ a, b, local })
  const remote = { native: true, workspaces: [a, b], catalogs: new Map() }
  const combined = combineNavigation({ ids: [], byId: {} }, { items: [local] }, remote)
  expect(combined.workspaces.items.map(item => item.title)).toEqual([a.title, 'file-search', 'file-search'])
  expect(combined.workspaces.items.map(item => item.workspaceId)).toEqual(['local', remoteWorkspaceKey(a), remoteWorkspaceKey(b)])
  expect(resolveRemoteNavigation(remoteWorkspaceKey(b), remote)?.workspace).toBe(b)
  expect(JSON.stringify({ a, b, local })).toBe(before)
})
it('projects remote pin and archive flags into native filters without changing local ids',()=>{
  const workspace={id:'one',hostId:'a'.repeat(24),alias:'a',title:'Remote',remotePath:'/a',workspaceId:'project'}
  const entry={sessionId:'same',title:'Remote',running:false,blank:false,updatedAt:1,pinned:true}
  const remote={native:true,workspaces:[workspace],catalogs:new Map([[workspace.id,{workspaceId:'project',stale:false,sessions:[entry],archivedSessions:[{...entry,sessionId:'archived',pinned:false}]}]])}
  const original={items:[],pinnedSessionIds:['local'],archivedSessionIds:['local-old']}
  const combined=combineNavigation({ids:[],byId:{}},original,remote)
  expect(combined.workspaces.pinnedSessionIds).toEqual(['local',remoteSessionKey(workspace,'same')])
  expect(combined.workspaces.archivedSessionIds).toEqual(['local-old',remoteSessionKey(workspace,'archived')])
  expect(resolveRemoteNavigation(remoteSessionKey(workspace,'archived'),remote)?.sessionId).toBe('archived')
  expect(original.pinnedSessionIds).toEqual(['local'])
})
