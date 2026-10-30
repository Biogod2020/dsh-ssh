import { expect, it, vi } from 'vitest'
import { RemoteWorkspaces } from '../src/remote/manager.ts'

const hostId='a'.repeat(24)
function fixture() {
  const rpc=vi.fn(async (_method:string,_args:object):Promise<any>=>({sessionId:'child'}))
  const check=vi.fn(), runtime={gateway:{rpc}}
  const manager=Object.create(RemoteWorkspaces.prototype) as any
  manager.withCatalog=async(_runtime:unknown,read:(catalog:unknown)=>unknown)=>read({workspaces:{items:[{workspaceId:'project',sessionIds:['source']}]}})
  manager.connectedWorkspace=async()=>({item:{hostId,workspaceId:'project'},runtime,check})
  manager.invalidateCatalog=vi.fn()
  return {manager,rpc,check}
}
it.each([undefined,'','  ','x'.repeat(1024),'x'.repeat(1021)+'(9)'])('creates a valid unnamed or boundary-title fork without an invalid follow-up rename (%s)',async title=>{
  const {manager,rpc}=fixture()
  expect(await manager.sessionAction('project','source','fork',title,false,hostId)).toEqual({sessionId:'child'})
  expect(rpc).toHaveBeenCalledExactlyOnceWith('session/fork',{request:{sessionId:'source'}})
})
it.each([['Title','Title (1)'],['Title (9)','Title (10)'],['标题（9）','标题（10）']])('matches native title increments after one confirmed child (%s)',async(title,next)=>{
  const {manager,rpc}=fixture()
  expect(await manager.sessionAction('project','source','fork',title,false,hostId)).toEqual({sessionId:'child'})
  expect(rpc.mock.calls.map(call=>call[0])).toEqual(['session/fork','session/rename'])
  expect(rpc.mock.calls[1]![1]).toEqual({request:{sessionId:'child',title:next}})
})
it('returns the confirmed child with a title warning after a lost rename reply, without forking again',async()=>{
  const {manager,rpc}=fixture();rpc.mockImplementation(async method=>{if(method==='session/rename')throw Error('Lost title reply');return {sessionId:'child'}})
  expect(await manager.sessionAction('project','source','fork','Title',false,hostId)).toEqual({sessionId:'child',titleUnconfirmed:true})
  expect(rpc.mock.calls.map(call=>call[0])).toEqual(['session/fork','session/rename'])
})
it('does not rename a created child after the owning Host changes',async()=>{
  const {manager,rpc,check}=fixture();let owned=true
  rpc.mockImplementation(async()=>{owned=false;return {sessionId:'child'}})
  check.mockImplementation(()=>{if(!owned)throw Error('Host changed')})
  await expect(manager.sessionAction('project','source','fork','Title',false,hostId)).rejects.toThrow('Host changed')
  expect(rpc).toHaveBeenCalledTimes(1)
})
