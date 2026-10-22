import { createServer, type Server } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { remoteRoutes } from '../src/remote/routes.ts'

let server:Server|undefined
afterEach(async()=>{await new Promise<void>(resolve=>server?server.close(()=>resolve()):resolve());server=undefined})
async function fixture(denied?:401|403){
  const record={type:'event',event:{seq:7,type:'tool/result',data:{output:'complete original fixture'}}}
  const manager={historyCopy:vi.fn(async()=>({records:[record]})),cachedHistory:vi.fn(async()=>({records:[record]})),historyEvent:vi.fn(async()=>record),auditHistory:vi.fn(async()=>({fileBytes:123,files:2,byKey:{}})),finishHistoryClear:vi.fn(async()=>{})}
  const route=remoteRoutes(manager as never,()=>denied)[0]!
  server=createServer((req,res)=>{void route.handler(req,res)})
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve))
  return{manager,record,url:`http://127.0.0.1:${(server.address() as {port:number}).port}/api/dsh-ssh/remote/history`}
}

it('routes bounded windows with their identity, keeping full reads explicit',async()=>{
  const f=await fixture(),key='a'.repeat(64)
  expect((await fetch(f.url+'/read?key='+key+'&limit=200&beforeSeq=7')).status).toBe(200)
  expect(f.manager.historyCopy).toHaveBeenCalledExactlyOnceWith(key,{limit:200,beforeSeq:7})
  await fetch(f.url+'/read?id=project&sessionId=chat&limit=10')
  expect(f.manager.cachedHistory).toHaveBeenCalledExactlyOnceWith('project','chat',{limit:10})
  await fetch(f.url+'/read?key='+key)
  expect(f.manager.historyCopy).toHaveBeenLastCalledWith(key,undefined)
  for(const query of ['limit=0','limit=501','limit=1&beforeSeq=-1','limit=2.5','beforeSeq=3','limit=1&beforeSeq=9007199254740992']){
    expect((await fetch(f.url+'/read?key='+key+'&'+query)).status).toBe(400)
  }
  expect(f.manager.historyCopy).toHaveBeenCalledTimes(2)
})

it('downloads the complete event only after authenticated same-origin access',async()=>{
  const f=await fixture(),key='a'.repeat(64)
  const response=await fetch(f.url+'/event?key='+key+'&seq=7')
  expect(response.status).toBe(200);expect(await response.json()).toEqual(f.record)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('content-disposition')).toBe('attachment; filename="history-event-7.json"')
  expect(f.manager.historyEvent).toHaveBeenCalledExactlyOnceWith(key,7)
  for(const seq of ['','-1','1.1','NaN','9007199254740992'])expect((await fetch(f.url+'/event?key='+key+'&seq='+seq)).status).toBe(400)
  expect((await fetch(f.url+'/event?key='+key+'&seq=7',{headers:{'sec-fetch-site':'cross-site'}})).status).toBe(403)
  expect((await fetch(f.url+'/event?key='+key+'&seq=7',{headers:{origin:'https://foreign.example'}})).status).toBe(403)
  expect(f.manager.historyEvent).toHaveBeenCalledOnce()
})

it.each([401,403] as const)('does not read local history when official auth denies access (%s)',async denied=>{
  const f=await fixture(denied)
  for(const path of ['/read?key=fixture&limit=200','/event?key=fixture&seq=0','/audit'])expect((await fetch(f.url+path)).status).toBe(denied)
  expect(f.manager.historyCopy).not.toHaveBeenCalled();expect(f.manager.historyEvent).not.toHaveBeenCalled();expect(f.manager.auditHistory).not.toHaveBeenCalled()
  expect((await fetch(f.url+'/finish-clear',{method:'POST',body:JSON.stringify({selection:[]})})).status).toBe(denied)
  expect(f.manager.finishHistoryClear).not.toHaveBeenCalled()
})
it('observes only local file inventory through the authenticated route',async()=>{
  const f=await fixture(),response=await fetch(f.url+'/audit')
  expect(response.status).toBe(200);expect((await response.json()).storage.fileBytes).toBe(123)
  expect(f.manager.auditHistory).toHaveBeenCalledOnce();expect(f.manager.historyCopy).not.toHaveBeenCalled()
})
it('validates reviewed cleanup identities and generations before dispatch',async()=>{
  const f=await fixture(),key='a'.repeat(64)
  expect((await fetch(f.url+'/finish-clear',{method:'POST',body:JSON.stringify({selection:[{key,generation:2}]})})).status).toBe(200)
  expect(f.manager.finishHistoryClear).toHaveBeenCalledExactlyOnceWith([{key,generation:2}])
  for(const selection of [[{key:'../outside',generation:2}],[{key,generation:-1}],[{key,generation:1.5}],[{key}]]){
    expect((await fetch(f.url+'/finish-clear',{method:'POST',body:JSON.stringify({selection})})).status).toBe(400)
  }
  expect(f.manager.finishHistoryClear).toHaveBeenCalledOnce()
})
