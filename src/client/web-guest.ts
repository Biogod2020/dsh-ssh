/** Isolated cross-origin Web view, controlled through a fixed command list. */
export function createWebGuest() {
  const frame = document.createElement('iframe')
  frame.referrerPolicy = 'no-referrer'
  let origin = '', disposed = false
  const pending = new Map<string,{resolve(value:unknown):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>()
  const receive = (event:MessageEvent) => {
    if (event.source !== frame.contentWindow || event.origin !== origin || event.data?.type !== 'dsh-ssh-reply') return
    const request = pending.get(event.data.id)
    if (!request) return
    clearTimeout(request.timer); pending.delete(event.data.id)
    if (event.data.error) request.reject(new Error('Remote view control failed')); else request.resolve(event.data.value)
  }
  window.addEventListener('message',receive)
  return Object.assign(frame, {
    control<T>(method:string,args:unknown[] = []):Promise<T> {
      if (disposed || !origin || !frame.contentWindow) return Promise.reject(new Error('Remote view is unavailable'))
      return new Promise((resolve,reject) => {
        const id = crypto.randomUUID(), timer = setTimeout(()=>{pending.delete(id);reject(new Error('Remote view control timed out'))},5000)
        pending.set(id,{resolve: value=>resolve(value as T),reject,timer})
        frame.contentWindow!.postMessage({type:'dsh-ssh-control',id,method,args},origin)
      })
    },
    loadURL(url:string):Promise<void> {
      origin = new URL(url).origin
      return new Promise((resolve,reject)=>{
        frame.onload = ()=>resolve(); frame.onerror = ()=>reject(new Error('Remote view could not load')); frame.src = url
      })
    },
    disposeControl() {
      disposed = true; window.removeEventListener('message',receive)
      for (const request of pending.values()) {clearTimeout(request.timer);request.reject(new Error('Remote view was released'))}
      pending.clear()
    },
  })
}
