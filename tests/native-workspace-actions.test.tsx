// @vitest-environment jsdom
import { act,createElement,useState } from 'react'
import { createRoot,type Root } from 'react-dom/client'
import { afterEach,expect,it,vi } from 'vitest'
import { NativeWorkspaces } from '../src/client/native-workspaces.tsx'
import { remoteNavigation,remoteSessionKey } from '../src/client/remote-navigation.ts'
import { registerRemotePresentation,selectRemoteView } from '../src/client/remote-presentation.ts'

// Unit boundary: verify our Host routing and owner close callback here. Native
// keyboard/style behavior is checked in the real Desktop acceptance fixture.
vi.mock('@deepseek-ai/dsh-client-ui-primitives',async()=>{
  const {createElement}=await import('react')
  const icon=()=>createElement('svg')
  return{MenuItemButton:({children,disabled,onSelect}:any)=>createElement('button',{type:'button',role:'menuitem',disabled,onClick:onSelect},children),
    IconArchiveOutlineRegular:icon,IconUnarchiveOutlineRegular:icon,IconPinFillRegular:icon,IconPinOutlineRegular:icon,
    Button:({children,...props}:any)=>createElement('button',props,children),Modal:({children,footer}:any)=>createElement('div',{role:'dialog'},children,footer)}
})

let root:Root|undefined,release:(()=>void)|undefined,unbind:(()=>void)|undefined
afterEach(()=>{act(()=>root?.unmount());root=undefined;release?.();release=undefined;unbind?.();unbind=undefined;remoteNavigation.clear();selectRemoteView();vi.restoreAllMocks();vi.unstubAllGlobals();document.body.replaceChildren()})
function NativeMenuOwner(props:any){
  const [open,setOpen]=useState(false)
  return <><button onClick={()=>setOpen(value=>!value)}>Session actions</button>{open&&<div role="menu">
    {props.renderSlot('sidebar.workspaces.session.menu.item',{sessionId:props.fixtureSessionKey},{hookContext:[open,setOpen]})}
  </div>}{props.renderSlot('sidebar.workspaces.session.row.action',{sessionId:props.fixtureSessionKey})}<button onClick={()=>props.open('local-fixture')}>Open local fixture</button><button onClick={()=>props.open(props.fixtureSessionKey)}>Open remote fixture</button></>
}
async function fixture(ok=true){
  document.documentElement.lang='en';(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
  vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}})
  const first={id:'first',hostId:'a'.repeat(24),workspaceId:'project',alias:'first',remotePath:'/generated',title:'First'}
  const second={...first,id:'second',hostId:'b'.repeat(24),alias:'second',title:'Second'}
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({workspaceId:'project',stale:false,sessions:[{sessionId:'same',title:'Saved',running:false,blank:false,updatedAt:1}]})})))
  remoteNavigation.update([first,second]);await remoteNavigation.refresh(first);await remoteNavigation.refresh(second)
  const settings=vi.fn(async()=>ok),local=vi.fn()
  release=registerRemotePresentation({resume:()=>false,open:async()=>{},settings})
  const parent=document.createElement('div');document.body.append(parent);root=createRoot(parent)
  await act(async()=>{root!.render(createElement(NativeWorkspaces,{
    original:NativeMenuOwner,fixtureSessionKey:remoteSessionKey(second,'same'),
    useSessions:(select:any)=>select({ids:[],byId:{}}),useWorkspaces:(select:any)=>select({items:[]}),
    usePanelInfo:(select:any)=>select({activePanelId:null}),useSessionStatus:(select:any)=>select(new Map()),
    renderSlot:local,open:local,startSession:local,requestSessionRename:local,
  }))})
  await act(async()=>{document.querySelector<HTMLButtonElement>('button')!.click()})
  return{settings,local,second}
}
it('routes equal Session ids through the menu to their owning Host only and closes the owning menu',async()=>{
  const f=await fixture()
  const buttons=[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  expect(buttons.some(button=>button.textContent==='Close remote view')).toBe(true)
  expect(buttons[1]?.textContent).toBe('Model settings on this host')
  await act(async()=>{buttons[1]!.click()})
  expect(f.settings).toHaveBeenCalledExactlyOnceWith(f.second);expect(f.local).not.toHaveBeenCalled()
  expect(document.querySelector('[role="menu"]')).toBeNull()
})
it('keeps a failed settings entry understandable without falling back to local settings',async()=>{
  const f=await fixture(false)
  await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(row=>row.textContent==='Model settings on this host')!.click()})
  expect(f.settings).toHaveBeenCalledExactlyOnceWith(f.second)
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('host')
  expect(f.local).not.toHaveBeenCalled()
})
it('clears the previous error when the menu is reopened',async()=>{
  await fixture(false)
  await act(async()=>{document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]!.click()})
  expect(document.querySelector('[role="alert"]')).not.toBeNull()
  await act(async()=>{document.querySelector<HTMLButtonElement>('button')!.click()})
  await act(async()=>{document.querySelector<HTMLButtonElement>('button')!.click()})
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  expect(document.querySelector('[role="alert"]')).toBeNull()
})
it('does not close a newly opened menu when the previous opening finishes late',async()=>{
  const f=await fixture()
  let finish!:(value:boolean)=>void
  f.settings.mockImplementationOnce(()=>new Promise<boolean>(resolve=>{finish=resolve}))
  await act(async()=>{document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]!.click()})
  expect(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]!.disabled).toBe(true)
  await act(async()=>{document.querySelector<HTMLButtonElement>('button')!.click()})
  await act(async()=>{document.querySelector<HTMLButtonElement>('button')!.click()})
  await act(async()=>{finish(true)})
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  expect(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]!.disabled).toBe(false)
  expect(f.settings).toHaveBeenCalledTimes(1)
})
it('keeps the current view when local navigation cannot confirm its remote draft save',async()=>{
  const f=await fixture();release?.()
  release=registerRemotePresentation({resume:()=>false,open:async()=>{},beforeLeave:async()=>{throw Object.assign(new Error('Generated unsaved'),{name:'DraftSaveError'})}})
  await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Open local fixture')!.click()})
  expect(f.local).not.toHaveBeenCalled()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('draft')
})
it('lets a newer remote choice supersede an older local click waiting on a save',async()=>{
  const f=await fixture();release?.()
  let finish!:()=>void
  release=registerRemotePresentation({resume:()=>false,open:async()=>{},beforeLeave:()=>new Promise<void>(resolve=>{finish=resolve})})
  const opened=vi.fn();unbind=remoteNavigation.bind(opened)
  await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Open local fixture')!.click()})
  await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Open remote fixture')!.click()})
  await act(async()=>{finish()})
  expect(f.local).not.toHaveBeenCalled();expect(opened).toHaveBeenCalledExactlyOnceWith(f.second,'same',false)
})
it('does not dispatch an old local callback after its sidebar unmounts',async()=>{
  const f=await fixture();release?.()
  let finish!:()=>void
  release=registerRemotePresentation({resume:()=>false,open:async()=>{},beforeLeave:()=>new Promise<void>(resolve=>{finish=resolve})})
  await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Open local fixture')!.click()})
  await act(async()=>{root!.unmount()});root=undefined
  await act(async()=>{finish()})
  expect(f.local).not.toHaveBeenCalled()
})
it('keeps a blocked close in the owning menu and explains the unsaved draft',async()=>{
  const f=await fixture();release?.()
  const close=vi.fn(async()=>{throw Object.assign(new Error('Generated unsaved'),{name:'DraftSaveError'})})
  release=registerRemotePresentation({resume:()=>false,open:async()=>{},close})
  await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button=>button.textContent==='Close remote view')!.click()})
  expect(close).toHaveBeenCalledExactlyOnceWith(f.second)
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('draft')
})

it('routes the visible pin button to the owning Host once without opening its conversation',async()=>{
  const f=await fixture(),requests=vi.mocked(fetch);requests.mockClear()
  requests.mockImplementation(async(_url,options)=>({ok:true,json:async()=>options?.method==='POST'?{ok:true}:{workspaceId:'project',stale:false,sessions:[{sessionId:'same',title:'Saved',running:false,blank:false,updatedAt:1,pinned:true}]}}) as Response)
  await act(async()=>{document.querySelector<HTMLButtonElement>('[aria-label="Pin session"]')!.click()})
  const writes=requests.mock.calls.filter(([,options])=>options?.method==='POST')
  expect(writes).toHaveLength(1);expect(JSON.parse(String(writes[0]![1]!.body))).toEqual({id:f.second.id,expectedHostId:f.second.hostId,sessionId:'same',action:'pin'})
  expect(f.local).not.toHaveBeenCalled();expect(f.settings).not.toHaveBeenCalled()
  expect(document.querySelector('[aria-label="Unpin session"]')).not.toBeNull()
})
it('renames from the owning remote dialog without sending a synthetic id to the local Host',async()=>{
  const f=await fixture(),requests=vi.mocked(fetch);requests.mockClear()
  requests.mockImplementation(async(_url,options)=>({ok:true,json:async()=>options?.method==='POST'?{ok:true}:{workspaceId:'project',stale:false,sessions:[{sessionId:'same',title:'Saved',running:false,blank:false,updatedAt:1}]}}) as Response)
  await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button=>button.textContent==='Rename session')!.click()})
  const input=document.querySelector<HTMLInputElement>('[aria-label="Session name"]')!
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'New remote title');input.dispatchEvent(new Event('input',{bubbles:true}))})
  await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button=>button.textContent==='Save')!.click()})
  const writes=requests.mock.calls.filter(([,options])=>options?.method==='POST')
  expect(writes).toHaveLength(1);expect(JSON.parse(String(writes[0]![1]!.body))).toMatchObject({id:f.second.id,sessionId:'same',action:'rename',title:'New remote title'})
  expect(f.local).not.toHaveBeenCalled();expect(document.querySelector('[role="dialog"]')).toBeNull()
})
