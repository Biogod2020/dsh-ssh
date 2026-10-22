import { createServer, connect, type Socket, type Server } from 'node:net'
import { performance } from 'node:perf_hooks'

/** A loopback-only test link. Adds half the requested RTT in each direction
 * and serializes bytes at a per-direction bandwidth. It never drops bytes:
 * TCP packet loss requires kernel network injection, not corrupting SSH. */
export class ShapedTcpLink {
  readonly port:number
  private sockets=new Set<Socket>()
  private stops=new Set<()=>void>()
  private totals={sent:0,received:0,connections:0}
  private constructor(private server:Server,port:number){this.port=port}
  static async start(targetPort:number,rttMs=0,mbitPerSecond=1000):Promise<ShapedTcpLink>{
    if(!Number.isInteger(targetPort)||targetPort<1||targetPort>65535||!Number.isFinite(rttMs)||rttMs<0
      ||!Number.isFinite(mbitPerSecond)||mbitPerSecond<=0)throw new Error('Invalid generated network condition')
    let link!:ShapedTcpLink
    const server=createServer({allowHalfOpen:true},source=>{
      const target=connect({host:'127.0.0.1',port:targetPort,allowHalfOpen:true})
      link.totals.connections++;source.setNoDelay(true);target.setNoDelay(true)
      link.sockets.add(source);link.sockets.add(target)
      const close=()=>{source.destroy();target.destroy()}
      source.on('error',close);target.on('error',close)
      source.once('close',()=>{link.sockets.delete(source);if(!source.readableEnded)target.destroy()})
      target.once('close',()=>{link.sockets.delete(target);if(!target.readableEnded)source.destroy()})
      link.relay(source,target,rttMs/2,mbitPerSecond,'sent')
      link.relay(target,source,rttMs/2,mbitPerSecond,'received')
    })
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve()})})
    link=new ShapedTcpLink(server,(server.address() as {port:number}).port);return link
  }
  snapshot(){return{...this.totals}}
  private relay(source:Socket,target:Socket,latency:number,mbit:number,direction:'sent'|'received'):void{
    let available=0,queued=0,blocked=false,stopped=false
    let timer:ReturnType<typeof setTimeout>|undefined
    const pending:Array<{at:number;apply():void}>=[]
    const resume=()=>{if(!stopped&&!blocked&&queued<1024*1024)source.resume()}
    const pump=()=>{
      timer=undefined
      while(!stopped&&!blocked&&pending.length){
        if(pending[0]!.at>performance.now()){
          timer=setTimeout(pump,Math.max(1,Math.ceil(pending[0]!.at-performance.now())));return
        }
        pending.shift()!.apply()
      }
    }
    const schedule=(at:number,fn:()=>void)=>{
      // One FIFO timer prevents sub-millisecond timer rounding from putting a
      // later SSH byte chunk ahead of an earlier one under high throughput.
      pending.push({at,apply:fn});if(!timer&&!blocked)pump()
    }
    const stop=()=>{stopped=true;clearTimeout(timer);pending.length=0;this.stops.delete(stop)}
    this.stops.add(stop);source.once('close',()=>{if(!source.readableEnded)stop()})
    source.on('data',(data:Buffer)=>{
      this.totals[direction]+=data.length;queued+=data.length
      if(queued>=2*1024*1024)source.pause()
      available=Math.max(performance.now()+latency,available)+data.length*8/(mbit*1000)
      schedule(available,()=>{
        queued-=data.length
        if(!target.destroyed&&!target.write(data)){
          blocked=true;source.pause();target.once('drain',()=>{blocked=false;resume();if(!timer)pump()})
        }
        resume()
      })
    })
    source.once('end',()=>schedule(Math.max(performance.now()+latency,available)+1,()=>{target.end();stop()}))
  }
  disconnect():void{for(const stop of [...this.stops])stop();for(const socket of this.sockets)socket.destroy()}
  async close():Promise<void>{this.disconnect();await new Promise<void>(resolve=>this.server.close(()=>resolve()))}
}
