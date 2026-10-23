import {it,expect} from 'vitest'
import {createServer,type ServerResponse} from 'node:http'
import {RemoteGateway} from '../src/remote/gateway.ts'

it('reclaims a view with the real HMR SSE shape while protecting dispatched HTTP and rejecting new writes during freeze',async()=>{
  const responses=new Set<ServerResponse>();let promptCount=0,started!:()=>void,finish!:()=>void
  const observed=new Promise<void>(resolve=>{started=resolve})
  const upstream=createServer(async(req,res)=>{
    responses.add(res);res.once('close',()=>responses.delete(res))
    if(req.url?.includes('?token=')){res.writeHead(303,{'set-cookie':'upstream=fixture; Path=/'});res.end();return}
    if(req.url==='/plugins/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': connected\n\n');return}
    const chunks=[];for await(const chunk of req)chunks.push(chunk)
    const body=JSON.parse(Buffer.concat(chunks).toString()||'{}')
    if(req.url==='/api/session/prompt'){promptCount++;finish=()=>res.end('{}');started();return}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({rpcId:body.rpcId,result:{ok:true,value:{items:[]}}}))
  })
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve))
  const port=(upstream.address() as {port:number}).port
  const gateway=new RemoteGateway(port,{url:`http://127.0.0.1:${port}/?token=fixture`} as any,'generated','http://localhost:8765/','a'.repeat(24),'b'.repeat(64))
  const eventStream=new AbortController()
  try{
    await gateway.start();const launch=new URL(gateway.launch());launch.searchParams.set('dsh-remote-view','desktop')
    const auth=await fetch(launch,{redirect:'manual'});await auth.body?.cancel()
    const headers={Cookie:auth.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '),Origin:gateway.origin,'content-type':'application/json'}
    const control=async(action:string,token?:string)=>{const r=await fetch(gateway.origin+'/__dsh_remote/release',{method:'POST',headers,body:JSON.stringify({action,token})});return {status:r.status,...await r.json()}}
    const sse=await fetch(gateway.origin+'/plugins/events',{headers,signal:eventStream.signal});expect(sse.status).toBe(200)
    const held=await control('freeze');expect(held.ok).toBe(true)
    const denied=await fetch(gateway.origin+'/api/session/prompt',{method:'POST',headers,body:'{}'});expect(denied.status).toBe(409);await denied.body?.cancel();expect(promptCount).toBe(0)
    await control('thaw',held.token)
    const prompt=fetch(gateway.origin+'/api/session/prompt',{method:'POST',headers,body:'{}'});await observed
    expect(await control('freeze')).toMatchObject({status:409,reason:'pending-http'});expect(promptCount).toBe(1)
    finish();await (await prompt).text();expect((await control('freeze')).ok).toBe(true)
  }finally{
    eventStream.abort();gateway.dispose();for(const res of responses)res.destroy();upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()))
  }
})
