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
  return{MenuItemButton:({children,disabled,onSelect}:any)=>createElement('button',{type:'button',role:'menuitem',disabled,onClick:onSelect},children)}
})

let root:Root|undefined,release:(()=>void)|undefined
afterEach(()=>{act(()=>root?.unmount());root=undefined;release?.();release=undefined;remoteNavigation.clear();selectRemoteView();vi.unstubAllGlobals();document.body.replaceChildren()})
function NativeMenuOwner(props:any){
  const [open,setOpen]=useState(false)
  return <><button onClick={()=>setOpen(value=>!value)}>Session actions</button>{open&&<div role="menu">
    {props.renderSlot('sidebar.workspaces.session.menu.item',{sessionId:props.fixtureSessionKey},{hookContext:[open,setOpen]})}
  </div>}</>
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
  expect(buttons).toHaveLength(3)
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
