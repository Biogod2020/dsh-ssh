import { createServer,connect,type Server,type Socket } from 'node:net'
import { performance } from 'node:perf_hooks'
import { randomBytes,createHash } from 'node:crypto'
import { afterEach,expect,it,vi } from 'vitest'
import { ShapedTcpLink } from './helpers/shaped-tcp.ts'
const links:ShapedTcpLink[]=[],servers:Server[]=[],sockets:Socket[]=[]
afterEach(async()=>{for(const socket of sockets.splice(0))socket.destroy();for(const link of links.splice(0))await link.close();for(const server of servers.splice(0))await new Promise<void>(r=>server.close(()=>r()))})
async function fixture(rtt:number,mbit:number){
  const server=createServer(socket=>{sockets.push(socket);socket.on('error',()=>{});socket.pipe(socket)})
  servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  const link=await ShapedTcpLink.start((server.address() as {port:number}).port,rtt,mbit);links.push(link)
  return link
}
async function echo(link:ShapedTcpLink,data:Buffer){
  const socket=connect({host:'127.0.0.1',port:link.port});sockets.push(socket);socket.setNoDelay(true)
  const response=new Promise<Buffer>((resolve,reject)=>{
    const chunks:Buffer[]=[];let size=0
    socket.on('error',reject);socket.on('data',chunk=>{const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);chunks.push(bytes);size+=bytes.length;if(size===data.length)resolve(Buffer.concat(chunks))})
  })
  await new Promise<void>(r=>socket.once('connect',r));const start=performance.now();socket.write(data)
  const result=await response;return{result,milliseconds:performance.now()-start,socket}
}
it('injects a calibrated round trip without changing any byte',async()=>{
  const link=await fixture(40,1000),data=randomBytes(31),value=await echo(link,data)
  expect(value.result).toEqual(data);expect(value.milliseconds).toBeGreaterThanOrEqual(35)
  expect(link.snapshot()).toEqual({sent:31,received:31,connections:1})
})
it('limits bandwidth while preserving binary order and reports all TCP payload bytes',async()=>{
  const link=await fixture(20,8),data=randomBytes(256*1024),value=await echo(link,data)
  expect(value.result).toEqual(data);expect(value.milliseconds).toBeGreaterThanOrEqual(250)
  expect(link.snapshot()).toEqual({sent:data.length,received:data.length,connections:1})
})
it('can cut existing connections without reconnecting or replaying queued bytes',async()=>{
  const link=await fixture(100,1),socket=connect({host:'127.0.0.1',port:link.port});sockets.push(socket)
  socket.on('error',()=>{});await new Promise<void>(r=>socket.once('connect',r))
  const closed=new Promise<void>(r=>socket.once('close',()=>r()))
  socket.write(randomBytes(64000))
  await vi.waitFor(()=>expect(link.snapshot().sent).toBeGreaterThan(0),{interval:5})
  link.disconnect();await closed
  expect(link.snapshot().connections).toBe(1)
  const snapshot=link.snapshot();await new Promise(r=>setTimeout(r,120));expect(link.snapshot()).toEqual(snapshot)
})

it('preserves queued byte order and half-close through many overlapping high-bandwidth chunks',async()=>{
  const link=await fixture(40,1000),data=randomBytes(4*1024*1024)
  const socket=connect({host:'127.0.0.1',port:link.port});sockets.push(socket);socket.setNoDelay(true)
  const complete=new Promise<Buffer>((resolve,reject)=>{const chunks:Buffer[]=[];socket.on('data',chunk=>chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)));socket.on('end',()=>resolve(Buffer.concat(chunks)));socket.on('error',reject)})
  await new Promise<void>(r=>socket.once('connect',r));socket.end(data)
  const received=await complete,hash=(buffer:Buffer)=>createHash('sha256').update(buffer).digest('hex')
  expect(received.length).toBe(data.length);expect(hash(received)).toBe(hash(data))
  expect(link.snapshot()).toEqual({sent:data.length,received:data.length,connections:1})
})
