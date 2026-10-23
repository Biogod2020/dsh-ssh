import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { watchCatalogPulse } from '../src/remote/catalog-pulse.ts'
afterEach(()=>vi.useRealTimers())
function fixture(){
  vi.useFakeTimers();const socket=Object.assign(new EventEmitter(),{ping:vi.fn()}),failed=vi.fn()
  const stop=watchCatalogPulse(socket as unknown as WebSocket,failed)
  return{socket,failed,stop}
}
it('keeps an idle read-only feed alive when protocol pongs arrive and removes all observation on release',()=>{
  const f=fixture()
  for(let n=0;n<4;n++){vi.advanceTimersByTime(30000);f.socket.emit('pong')}
  expect(f.socket.ping).toHaveBeenCalledTimes(4);expect(f.failed).not.toHaveBeenCalled()
  f.stop();vi.advanceTimersByTime(120000)
  expect(f.socket.ping).toHaveBeenCalledTimes(4);expect(f.socket.listenerCount('pong')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})
it('reports a silent feed once after its bounded pong deadline instead of treating HTTP health as proof',()=>{
  const f=fixture();vi.advanceTimersByTime(39999)
  expect(f.socket.ping).toHaveBeenCalledOnce();expect(f.failed).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1);expect(f.failed).toHaveBeenCalledOnce()
  expect(f.failed.mock.calls[0]![0]).toMatchObject({code:'stream-timeout'})
  vi.advanceTimersByTime(120000);expect(f.failed).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0)
})
it('fails and releases a read-only observer when sending a ping throws',()=>{
  const f=fixture();f.socket.ping.mockImplementation(()=>{throw new Error('socket failed')})
  vi.advanceTimersByTime(30000);expect(f.failed).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0)
})
