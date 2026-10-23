import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ViewReceiptStore } from '../../src/remote/view-receipts.ts'
const [root,nonce,mode]=process.argv.slice(2),store=new ViewReceiptStore(join(root,'receipts'))
const {hostId,input}=JSON.parse(await readFile(join(root,'input.json'),'utf8'))
if(mode==='clear'){
  await store.save(hostId,input)
  const create=store.create.bind(store)
  store.create=async(...args)=>{
    await create(...args)
    if(args[1].endsWith('.cleared')){console.log('CLEARED:'+nonce);await new Promise(()=>{})}
  }
  await store.dismiss(hostId,input.observationId)
}else{
  await store.save(hostId,input);console.log('SAVED:'+nonce)
}
setInterval(()=>{},1000)
