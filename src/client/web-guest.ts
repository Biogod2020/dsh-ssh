import { tt } from './panel/helpers.ts'

/** Isolated cross-origin Web view, controlled through a fixed command list. */
export function createWebGuest() {
  const frame = document.createElement('iframe')
  frame.referrerPolicy = 'no-referrer'
  let origin = '', disposed = false
  let navigation: { finish(error?: Error): void; timer?: ReturnType<typeof setTimeout> } | undefined
  const pending = new Map<string,{resolve(value:unknown):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>()
  const receive = (event:MessageEvent) => {
    if (event.source !== frame.contentWindow || event.origin !== origin || event.data?.type !== 'dsh-ssh-reply') return
    const request = pending.get(event.data.id)
    if (!request) return
    clearTimeout(request.timer); pending.delete(event.data.id)
    if (event.data.error) {
      request.reject(event.data.errorCode === 'boot/assets-failed'
        ? Object.assign(new Error(tt('remote.bootAssetsFailed')), { name: 'RemoteBootAssetError' })
        : new Error('Remote view control failed'))
    } else request.resolve(event.data.value)
  }
  window.addEventListener('message',receive)
  const control = <T>(method:string,args:unknown[] = [],timeoutMs = 5000):Promise<T> => {
      if (disposed || !origin || !frame.contentWindow) return Promise.reject(new Error('Remote view is unavailable'))
      return new Promise((resolve,reject) => {
        const id = crypto.randomUUID(), timer = setTimeout(()=>{pending.delete(id);reject(new Error('Remote view control timed out'))},timeoutMs)
        pending.set(id,{resolve: value=>resolve(value as T),reject,timer})
        frame.contentWindow!.postMessage({type:'dsh-ssh-control',id,method,args},origin)
      })
    }
  return Object.assign(frame, {
    control,
    loadURL(url:string):Promise<void> {
      navigation?.finish(new Error('Remote navigation was superseded'))
      origin = new URL(url).origin
      return new Promise((resolve,reject)=>{
        const owner = { timer: undefined as ReturnType<typeof setTimeout> | undefined, finish(error?: Error) {
          if (navigation !== owner) return
          navigation = undefined; clearTimeout(owner.timer); frame.onload = frame.onerror = null
          if (error) reject(error); else resolve()
        } }
        navigation = owner
        const probe = async () => {
          try { if (await control<boolean>('ready', [], 500)) { owner.finish(); return } }
          catch (error) { if (error instanceof Error && error.name === 'RemoteBootAssetError') { owner.finish(error); return } }
          if (!disposed && navigation === owner) owner.timer = setTimeout(probe, 250)
        }
        frame.onload = ()=>owner.finish(); frame.onerror = ()=>owner.finish(new Error('Remote view could not load'))
        frame.src = url
        // App readiness does not wait for a slow image, font or other resource
        // to finish the iframe's window.load event. This probe never submits
        // an Agent action or reloads an already usable document.
        owner.timer = setTimeout(probe, 0)
      })
    },
    disposeControl() {
      disposed = true; window.removeEventListener('message',receive)
      navigation?.finish(new Error('Remote view was released'))
      for (const request of pending.values()) {clearTimeout(request.timer);request.reject(new Error('Remote view was released'))}
      pending.clear()
    },
  })
}
