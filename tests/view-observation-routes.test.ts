import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteGateway } from '../src/remote/gateway.ts'
import { ViewReceiptStore } from '../src/remote/view-receipts.ts'
import { remoteRoutes } from '../src/remote/routes.ts'

const cleanup:Array<()=>Promise<void>>=[]
afterEach(async()=>{vi.restoreAllMocks();for(const dispose of cleanup.splice(0).reverse())await dispose()})
const host='a'.repeat(24),other='b'.repeat(24),record=()=>({observationId:randomUUID(),startedAt:100,endedAt:120,transport:'http',category:'session'})
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'dsh-observation-routes-')),store=new ViewReceiptStore(join(root,'observations'))
  let forwarded=0
  const upstream=createServer((req,res)=>{if(req.url?.startsWith('/?token=')){res.writeHead(303,{'Set-Cookie':'fixture=only'});res.end();return}forwarded++;res.writeHead(503);res.end()})
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));const port=(upstream.address() as {port:number}).port,gateways:RemoteGateway[]=[]
  const create=async(owner:string,embedded=true)=>{
    const gateway=new RemoteGateway(port,{protocol:1,pid:process.pid,port,url:`http://127.0.0.1:${port}/?token=fixture-only`,root,directory:root,userHome:root,version:'0.2.1-rc.2'},'fixture','http://127.0.0.1:1/',owner,'fixture',undefined,store)
    gateways.push(gateway);await gateway.start();const launch=new URL(gateway.launch('same'));if(embedded)launch.searchParams.set('dsh-remote-view','desktop')
    const auth=await fetch(launch,{redirect:'manual'}),headers={Cookie:auth.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '),Origin:gateway.origin,'content-type':'application/json'}
    return{gateway,headers,url:gateway.origin+'/__dsh_remote/observations',save:(records:object[])=>fetch(gateway.origin+'/__dsh_remote/observations',{method:'PUT',headers,body:JSON.stringify({records})})}
  }
  const manager={viewObservationHosts:async(after:string)=>{const page=await store.hosts(after);return{hosts:page.items.map(hostId=>({hostId,alias:'Generated'})),next:page.next}},viewObservations:(owner:string,after:string)=>store.list(owner,after),dismissViewObservation:(owner:string,id:string)=>store.dismiss(owner,id)}
  const routes=remoteRoutes(manager as any,req=>req.headers['x-fixture-auth']==='yes'?undefined:401)
  const server=createServer((req,res)=>{void routes[0]!.handler!(req,res)})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const local=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/dsh-ssh/remote/view-observations`
  cleanup.push(async()=>{for(const g of gateways)g.dispose();server.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise<void>(resolve=>server.close(()=>resolve())),new Promise<void>(resolve=>upstream.close(()=>resolve()))]);await store.close();await rm(root,{recursive:true,force:true})})
  return{create,store,local,forwarded:()=>forwarded}
}
it('binds identical observation ids to authenticated embedded Host owners and never forwards metadata',async()=>{
  const f=await fixture(),a=await f.create(host),b=await f.create(other),value=record()
  expect((await fetch(a.url,{method:'PUT',body:JSON.stringify({records:[value]})})).status).toBe(401)
  expect((await fetch(a.url,{method:'PUT',headers:{...a.headers,Origin:'https://untrusted.invalid'},body:JSON.stringify({records:[value]})})).status).toBe(401)
  expect((await a.save([value])).status).toBe(200)
  expect((await f.store.list(other)).entries).toEqual([])
  expect((await b.save([value])).status).toBe(200)
  expect((await f.store.list(host)).entries[0]?.hostId).toBe(host)
  expect((await f.store.list(other)).entries[0]?.hostId).toBe(other)
  const standalone=await f.create(host,false);expect((await standalone.save([record()])).status).toBe(403)
  expect(f.forwarded()).toBe(0)
})
it('validates batches before saving and returns a fixed storage error without private fields',async()=>{
  const f=await fixture(),a=await f.create(host),value=record()
  const bad=await a.save([value,{...record(),apiKey:'generated-private-key'}])
  expect(bad.status).toBe(507);expect(JSON.stringify(await bad.json())).not.toContain('generated-private-key')
  expect((await f.store.list(host)).entries).toEqual([])
  vi.spyOn(f.store,'saveMany').mockRejectedValueOnce(new Error('/private/fixture/path'))
  const failed=await a.save([value]);expect(failed.status).toBe(507);expect(JSON.stringify(await failed.json())).not.toContain('/private/')
  expect(f.forwarded()).toBe(0)
})
it('reads and dismisses while remote service requests are unavailable, then fences a late metadata save',async()=>{
  const f=await fixture(),a=await f.create(host),value=record();await a.save([value])
  expect((await fetch(f.local+'/hosts')).status).toBe(401)
  const headers={'x-fixture-auth':'yes','content-type':'application/json'}
  expect((await (await fetch(f.local+'/hosts',{headers})).json()).hosts).toEqual([{hostId:host,alias:'Generated'}])
  expect((await (await fetch(f.local+'?hostId='+host,{headers})).json()).entries).toHaveLength(1)
  const dismissed=await fetch(f.local+'/dismiss',{method:'POST',headers,body:JSON.stringify({hostId:host,observationId:value.observationId})});expect(dismissed.status).toBe(200)
  const late=await a.save([value]);expect((await late.json()).receipts[0]?.status).toBe('dismissed')
  expect((await (await fetch(f.local+'?hostId='+host,{headers})).json()).entries).toEqual([])
  expect(f.forwarded()).toBe(0)
})
