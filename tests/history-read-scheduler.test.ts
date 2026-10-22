import { expect,it,vi } from 'vitest'
import { HistoryReadScheduler } from '../src/remote/history-read-scheduler.ts'
const flush=async()=>{for(let n=0;n<15;n++)await Promise.resolve()}
function fixture(){
  const scheduler=new HistoryReadScheduler(),starts:string[]=[],finish=new Map<string,()=>void>(),jobs:Promise<void>[]=[]
  let active=0,maximum=0
  const add=(key:string,hostId=key,foreground=false)=>{
    const lane={key,hostId,foreground}
    const job=scheduler.run(lane,async()=>{starts.push(key);maximum=Math.max(maximum,++active);await new Promise<void>(resolve=>finish.set(key,()=>{finish.delete(key);active--;resolve()}))})
    jobs.push(job);return{job,lane}
  }
  const drain=async()=>{for(let n=0;n<20;n++){await flush();for(const done of finish.values())done()}await Promise.all(jobs)}
  return{scheduler,starts,finish,add,drain,maximum:()=>maximum}
}
it('limits both total reads and each Host, allowing another Host past a blocked one',async()=>{
  const f=fixture();f.add('one','host');f.add('two','host');f.add('other','other');await flush()
  expect(f.starts).toEqual(['one','other']);expect(f.maximum()).toBe(2)
  f.finish.get('one')!();await flush();expect(f.starts).toEqual(['one','other','two']);await f.drain()
})
it('promotes an already queued foreground selection without dispatching a second copy',async()=>{
  const f=fixture();f.add('one');f.add('two');f.add('old');const focus=f.add('focus');focus.lane.foreground=true
  await flush();f.finish.get('one')!();await flush()
  expect(f.starts).toEqual(['one','two','focus']);await f.drain()
  expect(f.starts.filter(x=>x==='focus')).toHaveLength(1)
})
it('gives old history a bounded opportunity even when foreground reads keep arriving',async()=>{
  const f=fixture();f.add('one');f.add('two');f.add('old');f.add('focus',undefined,true);f.add('more-focus',undefined,true)
  await flush();f.finish.get('one')!();await flush();f.finish.get('two')!();await flush()
  expect(f.starts.slice(0,4)).toEqual(['one','two','focus','old']);await f.drain()
})
it('cancels only queued reads for the cleared copy and never replays the active read',async()=>{
  const scheduler=new HistoryReadScheduler();let release!:()=>void
  const active=vi.fn(()=>new Promise<void>(resolve=>{release=resolve})),queued=vi.fn(async()=>{}),other=vi.fn(async()=>{})
  const first=scheduler.run({key:'first',hostId:'host',foreground:false},active)
  const pending=scheduler.run({key:'clear',hostId:'host',foreground:false},queued)
  const rejected=expect(pending).rejects.toThrow('cleared before')
  const surviving=scheduler.run({key:'other',hostId:'host',foreground:false},other)
  await flush();scheduler.cancel('clear');await rejected;release();await Promise.all([first,surviving])
  expect(active).toHaveBeenCalledOnce();expect(queued).not.toHaveBeenCalled();expect(other).toHaveBeenCalledOnce()
})
