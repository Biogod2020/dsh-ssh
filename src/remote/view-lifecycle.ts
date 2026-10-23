/** Serialized page-owned control. Never evaluates code received by a frame. */
export function viewLifecycle(parentOrigin: string): void {
  const target = window as any
  let held: { token:string; operation:string; gateway:string } | undefined
  let preparing = false
  let generation=0
  let reason=''
  const gateway = async (action:string, token?:string) => {
    const response = await fetch('/__dsh_remote/release', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({action,token}), signal:AbortSignal.timeout(3000) })
    return response.json()
  }
  const safe = () => {
    const state = target.__dshSshView?.inspection(), drafts = state?.drafts
    return target.__dshSshVisible!==true && state?.sidebar?.terminals === 0 && state.sidebar.tabs === 0 && drafts && drafts.pendingUnmountSaves === 0 && drafts.failedUnmountSaves === 0
      && drafts.sessions.every((row:any) => row.status === 'saved' && row.persisted && row.inputPhase === 'plain' && !row.hasReferences && !row.hasAttachments)
  }
  const cancel = async () => {
    ++generation
    const old = held; held = undefined
    if (old) { await gateway('thaw',old.gateway).catch(()=>{});target.__dshSshOperations?.thaw(old.operation) }
  }
  const api = {
    async prepare() {
      if (held || preparing || !target.__dshSshDrafts || !target.__dshSshOperations?.freeze) return null
      preparing = true
      const owner=generation
      let serverToken:string|undefined, operation:string|undefined
      try {
        target.__dshSshView?.cancelNavigation()
        reason='draft-or-resource'
        if (!await target.__dshSshDrafts.flush() || !safe()) return null
        if(owner!==generation)return null
        reason='gateway-busy'
        const response = await gateway('freeze')
        if (!response?.ok || typeof response.token !== 'string') {reason=response?.reason??reason;return null}
        serverToken = response.token
        if(owner!==generation)return null
        reason='client-operation'
        operation = await target.__dshSshOperations.freeze()
        if (!operation || !safe()) {reason=target.__dshSshOperations.releaseBlock??reason;return null}
        if(owner!==generation)return null
        reason=''
        const token = crypto.randomUUID(); held = {token,operation,gateway:serverToken!}
        return {token}
      } catch { return null }
      finally {
        preparing = false
        if (!held) {
          if (serverToken) await gateway('thaw',serverToken).catch(()=>{})
          if (operation) target.__dshSshOperations.thaw(operation)
        }
      }
    },
    async commit(token:string) {
      const old = held
      if (!old || old.token !== token || !safe()) return false
      const checked = await gateway('check',old.gateway)
      if(held!==old||checked?.ok!==true||!safe()||!target.__dshSshOperations.commit(old.operation))return false
      held=undefined;return true
    },
    cancel,
    async command(method:string, args:unknown[] = []) {
      switch(method) {
        case 'ready': return !!target.__dshSshView && !!document.querySelector('#root [class*=centerCol]')
        case 'state': return target.__dshSshView?.state()
        case 'inspect': return target.__dshSshView?.inspection()
        case 'flush': target.__dshSshView?.cancelNavigation(); return target.__dshSshDrafts ? target.__dshSshDrafts.flush() : false
        case 'recovery': return !!target.__dshSshDrafts?.openRecovery?.()
        case 'settings': return !!target.__dshSshView?.settings?.()
        case 'select': return target.__dshSshView?.select(...args)
        case 'open': return target.__dshSshView?.open(...args)
        case 'prepareRelease': return api.prepare()
        case 'releaseReason': return reason
        case 'commitRelease': return api.commit(String(args[0]))
        case 'cancelRelease': await cancel(); return true
        case 'visible': {
          const visible = args[0] === true
          if (target.__dshSshVisible !== visible) { target.__dshSshVisible = visible; window.dispatchEvent(new Event('dsh-ssh-visibility')) }
          return true
        }
        default: throw new Error('Unsupported view control')
      }
    },
  }
  target.__dshSshRelease = api
  window.addEventListener('message', event => {
    if (window.parent === window || event.source !== window.parent || event.origin !== parentOrigin) return
    const request = event.data
    if (request?.type !== 'dsh-ssh-control' || typeof request.id !== 'string' || request.id.length > 128 || typeof request.method !== 'string'
      || !Array.isArray(request.args) || request.args.length > 2) return
    void api.command(request.method,request.args).then(value => {
      window.parent.postMessage({type:'dsh-ssh-reply',id:request.id,value},parentOrigin)
    }, () => window.parent.postMessage({type:'dsh-ssh-reply',id:request.id,error:'View control could not finish'},parentOrigin))
  })
}
