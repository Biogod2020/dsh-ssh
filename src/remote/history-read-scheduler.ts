export interface HistoryReadLane { key:string; hostId:string; foreground:boolean }
interface Read { lane:HistoryReadLane; start():void; reject(error:Error):void }

/** Read-only history batches: two globally, one per Host. A new foreground
 * selection overtakes queued backfill; every fourth grant admits the oldest
 * eligible batch so continuous interaction cannot starve saved history. */
export class HistoryReadScheduler {
  private active=0
  private hosts=new Set<string>()
  private waiting:Read[]=[]
  private grants=0
  run<T>(lane:HistoryReadLane,fn:()=>Promise<T>):Promise<T>{
    return new Promise<T>((resolve,reject)=>{
      const read:Read={lane,reject,start:()=>{
        this.active++;this.hosts.add(lane.hostId);this.grants++
        void Promise.resolve().then(fn).then(resolve,reject).finally(()=>{
          this.active--;this.hosts.delete(lane.hostId);this.drain()
        })
      }}
      this.waiting.push(read);this.drain()
    })
  }
  cancel(key:string):void{
    const cancelled=this.waiting.filter(read=>read.lane.key===key)
    this.waiting=this.waiting.filter(read=>read.lane.key!==key)
    for(const read of cancelled)read.reject(new Error('Local history copy was cleared before this read was dispatched'))
  }
  private drain():void{
    while(this.active<2){
      const eligible=(read:Read)=>!this.hosts.has(read.lane.hostId)
      let next=this.grants%4!==3?this.waiting.findIndex(read=>eligible(read)&&read.lane.foreground):-1
      if(next<0)next=this.waiting.findIndex(eligible)
      if(next<0)return
      this.waiting.splice(next,1)[0]!.start()
    }
  }
}
