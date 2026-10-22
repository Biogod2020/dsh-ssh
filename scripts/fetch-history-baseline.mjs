import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'

// An immutable public source object, not a moving branch or registry tag.
const commit='d9ee27964b44ff0b5c57b6baefd3c4b315ee6cb9',blob='611cca74e2acb04d0f0cf5a69833a1f43fd63b74'
const path='src/remote/history-cache.ts',destination=process.argv[2]
assert(destination,'usage: fetch-history-baseline.mjs DESTINATION_TS')
let failure
for(let attempt=0;attempt<3;attempt++){
  try{
    const response=await fetch(`https://api.github.com/repos/Biogod2020/dsh-ssh/contents/${path}?ref=${commit}`,{
      headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(process.env.GITHUB_TOKEN?{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`}:{})},
      redirect:'error',signal:AbortSignal.timeout(30000),
    })
    assert(response.ok,`Frozen source request failed (${response.status})`)
    const file=await response.json();assert(file.type==='file'&&file.path===path&&file.sha===blob&&file.encoding==='base64'&&file.size<=256*1024)
    const bytes=Buffer.from(file.content,'base64');assert.equal(bytes.length,file.size)
    assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),blob,'Frozen baseline object hash mismatch')
    await writeFile(resolve(destination),bytes,{mode:0o600})
    console.log(JSON.stringify({verified:true,commit,blob,bytes:bytes.length}));process.exit(0)
  }catch(error){failure=error;if(attempt<2)await new Promise(r=>setTimeout(r,1000*(attempt+1)))}
}
throw failure
