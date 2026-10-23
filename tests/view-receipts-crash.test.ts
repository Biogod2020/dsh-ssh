import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { ViewReceiptStore } from '../src/remote/view-receipts.ts'
const cleanups:string[]=[]
afterEach(async()=>{for(const path of cleanups.splice(0))await rm(path,{recursive:true,force:true})})
it.each(['save','clear'])('retains the durable %s boundary across a real SIGKILL',async mode=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-view-receipt-crash-'));cleanups.push(root)
  const hostId='a'.repeat(24),input={observationId:randomUUID(),startedAt:100,endedAt:200,transport:'http' as const,category:'session' as const}
  await writeFile(join(root,'input.json'),JSON.stringify({hostId,input}),{mode:0o600})
  const nonce=randomUUID(),child=spawn(process.execPath,['--experimental-transform-types',fileURLToPath(new URL('./helpers/view-receipt-child.mjs',import.meta.url)),root,nonce,mode],{env:{HOME:root,PATH:process.env.PATH},stdio:['ignore','pipe','pipe']})
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()))
  try{
    await new Promise<void>((resolve,reject)=>{
      const deadline=setTimeout(()=>reject(Error('Generated receipt writer did not reach its boundary')),8000);let stdout=''
      child.once('error',reject);child.once('exit',()=>{clearTimeout(deadline);reject(Error('Generated receipt writer exited before its boundary'))})
      child.stdout!.on('data',bytes=>{stdout+=bytes;if(stdout.includes((mode==='clear'?'CLEARED:':'SAVED:')+nonce)){clearTimeout(deadline);resolve()}})
    })
    expect(child.kill('SIGKILL')).toBe(true);await exited
    const restored=new ViewReceiptStore(join(root,'receipts'))
    expect((await restored.list(hostId)).entries).toHaveLength(mode==='clear'?0:1)
    if(mode==='clear')expect(await restored.save(hostId,input)).toMatchObject({status:'dismissed'})
    await restored.close()
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited}
},12000)
