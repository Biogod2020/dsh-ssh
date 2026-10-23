// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mountViewObservations } from '../src/client/view-observations.ts'
import { remoteNavigation } from '../src/client/remote-navigation.ts'
const host='a'.repeat(24),other='b'.repeat(24),third='c'.repeat(24)
const record=(owner:string,id='11111111-1111-4111-8111-111111111111')=>({version:1,hostId:owner,outcome:'unconfirmed',observationId:id,startedAt:100,endedAt:200,transport:'http',category:'session'})
let mounted:ReturnType<typeof mountViewObservations>|undefined
beforeEach(()=>{document.documentElement.lang='en';Object.assign(HTMLDialogElement.prototype,{showModal(this:HTMLDialogElement){this.setAttribute('open','')},close(this:HTMLDialogElement){this.removeAttribute('open');this.dispatchEvent(new Event('close'))}})})
afterEach(()=>{mounted?.dispose();mounted=undefined;remoteNavigation.clear();vi.unstubAllGlobals();vi.restoreAllMocks();document.body.replaceChildren()})
const reply=(value:object)=>({ok:true,json:async()=>value}) as Response
function button(label:string){return [...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===label)!}
function mount(){const parent=document.createElement('div');document.body.append(parent);mounted=mountViewObservations(parent);mounted.update(true);return button('Unconfirmed operations')}
it('adds no background fetch and reads/dismisses local notices without dispatching remote operations',async()=>{
  let entries=[record(host)]
  const fetch=vi.fn(async(url:unknown,options?:RequestInit)=>{
    if(String(url).endsWith('/hosts'))return reply({hosts:[{hostId:host,alias:'Generated A'}]})
    if(String(url).endsWith('/dismiss')){entries=[];return reply({ok:true})}
    return reply({entries})
  });vi.stubGlobal('fetch',fetch)
  const launch=mount();expect(fetch).not.toHaveBeenCalled();launch.click()
  await vi.waitFor(()=>expect(button('Generated A')).toBeDefined());button('Generated A').click()
  await vi.waitFor(()=>expect(document.querySelector('[data-observation-id]')).not.toBeNull())
  button('Dismiss this notice').click();button('Dismiss this notice').click()
  await vi.waitFor(()=>expect(document.querySelector('[data-observation-id]')).toBeNull())
  expect(fetch.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1)
  expect(fetch.mock.calls.every(([url])=>String(url).startsWith('/api/dsh-ssh/remote/view-observations'))).toBe(true)
})
it('does not let a late Host page replace the newly selected Host',async()=>{
  let finish!:(value:Response)=>void
  vi.stubGlobal('fetch',vi.fn(async(url:unknown)=>{
    if(String(url).endsWith('/hosts'))return reply({hosts:[{hostId:host,alias:'Generated A'},{hostId:other,alias:'Generated B'}]})
    if(String(url).includes(host))return new Promise<Response>(resolve=>{finish=resolve})
    return reply({entries:[record(other,'22222222-2222-4222-8222-222222222222')]})
  }))
  mount().click();await vi.waitFor(()=>expect(button('Generated A')).toBeDefined());button('Generated A').click();button('Generated B').click()
  await vi.waitFor(()=>expect(document.querySelector('[data-observation-id]')?.getAttribute('data-observation-id')).toContain('22222222'))
  finish(reply({entries:[record(host)]}));await Promise.resolve();await Promise.resolve()
  expect(document.querySelector('h3')?.textContent).toBe('Generated B')
  expect(document.querySelector('[data-observation-id]')?.getAttribute('data-observation-id')).toContain('22222222')
})
it('aborts a closed reader and ignores its late result after another reader opens',async()=>{
  let finish!:(value:Response)=>void,signal:AbortSignal|undefined
  const fetch=vi.fn(async(url:unknown,options?:RequestInit)=>{
    if(String(url).endsWith('/hosts'))return reply({hosts:[{hostId:host,alias:'Generated A'}]})
    signal=options?.signal??undefined;return new Promise<Response>(resolve=>{finish=resolve})
  });vi.stubGlobal('fetch',fetch)
  const launch=mount();launch.click();await vi.waitFor(()=>expect(button('Generated A')).toBeDefined());button('Generated A').click()
  button('Close').click();expect(signal?.aborted).toBe(true);expect(document.activeElement).toBe(launch)
  launch.click();await vi.waitFor(()=>expect(document.querySelector('dialog[open]')).not.toBeNull())
  finish(reply({entries:[record(host)]}));await Promise.resolve();await Promise.resolve()
  expect(document.querySelector('[data-observation-id]')).toBeNull()
})
it('pages Host choices forward and back to their exact prior starting cursors',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url:unknown)=>String(url).includes('after='+other)?reply({hosts:[{hostId:third,alias:'Generated C'}]}):String(url).includes('after='+host)?reply({hosts:[{hostId:other,alias:'Generated B'}],next:other}):reply({hosts:[{hostId:host,alias:'Generated A'}],next:host})))
  mount().click();await vi.waitFor(()=>expect(button('Generated A')).toBeDefined());button('Next hosts').click()
  await vi.waitFor(()=>expect(button('Generated B')).toBeDefined());button('Next hosts').click()
  await vi.waitFor(()=>expect(button('Generated C')).toBeDefined());button('Previous hosts').click()
  await vi.waitFor(()=>expect(button('Generated B')).toBeDefined());button('Previous hosts').click()
  await vi.waitFor(()=>expect(button('Generated A')).toBeDefined())
})
it('refuses mismatched Host metadata instead of offering its dismissal in another Host',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url:unknown)=>String(url).endsWith('/hosts')?reply({hosts:[{hostId:host,alias:'Generated A'}]}):reply({entries:[record(other)]})))
  mount().click();await vi.waitFor(()=>expect(button('Generated A')).toBeDefined());button('Generated A').click()
  await vi.waitFor(()=>expect(document.querySelector('[role="status"]')?.textContent).toContain('preserved'))
  expect(button('Dismiss this notice')).toBeUndefined()
})
it('keeps the previous Host cursor when a backward read fails, so retry does not skip a page',async()=>{
  let failBack=false
  vi.stubGlobal('fetch',vi.fn(async(url:unknown)=>{
    if(String(url).includes('after='+other))return reply({hosts:[{hostId:third,alias:'Generated C'}]})
    if(String(url).includes('after='+host)){
      if(failBack){failBack=false;throw Error('Generated local read failure')}
      return reply({hosts:[{hostId:other,alias:'Generated B'}],next:other})
    }
    return reply({hosts:[{hostId:host,alias:'Generated A'}],next:host})
  }))
  mount().click();await vi.waitFor(()=>expect(button('Generated A')).toBeDefined());button('Next hosts').click()
  await vi.waitFor(()=>expect(button('Generated B')).toBeDefined());button('Next hosts').click()
  await vi.waitFor(()=>expect(button('Generated C')).toBeDefined());failBack=true;button('Previous hosts').click()
  await vi.waitFor(()=>expect(document.querySelector('[role="status"]')?.textContent).toContain('preserved'))
  button('Previous hosts').click();await vi.waitFor(()=>expect(button('Generated B')).toBeDefined())
})
it('retains the notice pager after a failed read and commits its cursor only after success',async()=>{
  const first='a'.repeat(64),second='b'.repeat(64)
  let failBack=false
  vi.stubGlobal('fetch',vi.fn(async(url:unknown)=>{
    if(String(url).endsWith('/hosts'))return reply({hosts:[{hostId:host,alias:'Generated A'}]})
    if(String(url).includes('after='+second))return reply({entries:[record(host,'33333333-3333-4333-8333-333333333333')]})
    if(String(url).includes('after='+first)){
      if(failBack){failBack=false;throw Error('Generated local read failure')}
      return reply({entries:[record(host,'22222222-2222-4222-8222-222222222222')],next:second})
    }
    return reply({entries:[record(host)],next:first})
  }))
  mount().click();await vi.waitFor(()=>expect(button('Generated A')).toBeDefined());button('Generated A').click()
  await vi.waitFor(()=>expect(button('Next notices')).toBeDefined());button('Next notices').click()
  await vi.waitFor(()=>expect(document.querySelector('[data-observation-id]')?.getAttribute('data-observation-id')).toContain('22222222'))
  button('Next notices').click();await vi.waitFor(()=>expect(document.querySelector('[data-observation-id]')?.getAttribute('data-observation-id')).toContain('33333333'))
  failBack=true;button('Previous notices').click()
  await vi.waitFor(()=>expect(document.querySelector('[role="status"]')?.textContent).toContain('preserved'))
  expect(button('Previous notices').disabled).toBe(false);button('Previous notices').click()
  await vi.waitFor(()=>expect(document.querySelector('[data-observation-id]')?.getAttribute('data-observation-id')).toContain('22222222'))
  button('Previous notices').click();await vi.waitFor(()=>expect(document.querySelector('[data-observation-id]')?.getAttribute('data-observation-id')).toContain('11111111'))
})
