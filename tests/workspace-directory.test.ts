import { expect, it } from 'vitest'
import { WorkspaceDirectoryProjection } from '../src/remote/workspace-directory.ts'
const baseline=(items:unknown[]=[])=>({type:'baseline',value:{items,archivedSessionIds:[]}})
it('retains deletion tombstones across replacement frames and keeps old snapshots detached',()=>{
  const p=new WorkspaceDirectoryProjection(),first=p.accept(baseline([{workspaceId:'one',sessionIds:['a']}]))!
  p.accept({type:'remove',workspaceId:'one'})
  expect(p.accept({type:'upsert',workspace:{workspaceId:'one',sessionIds:['stale']}})).toBeUndefined()
  expect(p.accept({type:'replace',value:{items:[{workspaceId:'one',sessionIds:['stale']},{workspaceId:'two',sessionIds:['b']}],archivedSessionIds:['a']}})).toEqual({items:[{workspaceId:'two',sessionIds:['b']}],archivedSessionIds:['a']})
  expect(first).toEqual({items:[{workspaceId:'one',sessionIds:['a']}],archivedSessionIds:[]})
})
it('requires a generation baseline and refuses ambiguous rows and unknown increments',()=>{
  for(const frame of [{type:'remove',workspaceId:'one'},{type:'replace',value:{items:[],archivedSessionIds:[]}}])expect(()=>new WorkspaceDirectoryProjection().accept(frame)).toThrow('incompatible')
  const p=new WorkspaceDirectoryProjection();p.accept(baseline())
  expect(()=>p.accept(baseline())).toThrow('incompatible')
  expect(()=>p.accept({type:'future-delta'})).toThrow('incompatible')
  expect(()=>new WorkspaceDirectoryProjection().accept(baseline([{workspaceId:'one',sessionIds:[]},{workspaceId:'one',sessionIds:[]}]))).toThrow('incompatible')
  expect(()=>p.accept({type:'upsert',workspace:{workspaceId:'one',sessionIds:['same','same']}})).toThrow('incompatible')
})
it('enforces an aggregate retained budget even when individual increments are within the frame limit',()=>{
  const p=new WorkspaceDirectoryProjection();p.accept(baseline())
  const sessionIds=Array.from({length:5000},(_,n)=>n.toString().padStart(250,'x'))
  let accepted=0
  expect(()=>{for(let n=0;n<10;n++){p.accept({type:'upsert',workspace:{workspaceId:'project-'+n,sessionIds}});accepted++}}).toThrow('8 MiB')
  expect(accepted).toBeGreaterThan(0);expect(accepted).toBeLessThan(10)
  expect(p.snapshot()!.items).toHaveLength(accepted)
})
it('does not invalidate Session membership for unchanged rows, project order or pins',()=>{
  const p=new WorkspaceDirectoryProjection();p.accept(baseline([{workspaceId:'one',sessionIds:['a']}]))
  expect(p.accept({type:'upsert',workspace:{workspaceId:'one',sessionIds:['a'],title:'Changed project title'}})).toBeUndefined()
  expect(p.accept({type:'order',workspaceIds:['one']})).toBeUndefined()
  expect(p.accept({type:'pinned',pinnedSessionIds:['a']})).toBeUndefined()
  expect(p.accept({type:'archived',archivedSessionIds:['a']})).toMatchObject({archivedSessionIds:['a']})
})
