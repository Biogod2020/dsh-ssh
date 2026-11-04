/** Real current-user Task Scheduler acceptance; uses only generated files. */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { configureUpdateService } from '../src/update-service.ts'
assert.equal(process.platform, 'win32')
const root = await mkdtemp(join(tmpdir(), "dsh 更新程序's task & "))
const configFile = join(root, 'config.json'), worker = join(root, "worker's 测试.cjs"), marker = join(root, 'ran.json')
const id = 'ai.biogod.dsh-ssh-update.' + createHash('sha256').update(configFile).digest('hex').slice(0,16)
const config = { enabled: true, profile: root, executable: process.execPath, executableArgs: [], packageManager: { command: process.execPath, args: [], env: {} } }
const ps = code => promisify(execFile)('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop'; " + code,'utf16le').toString('base64')], { windowsHide: true, timeout: 30000 })
try {
  await writeFile(configFile, '{}')
  await writeFile(worker, `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({node:process.env.ELECTRON_RUN_AS_NODE,args:process.argv.slice(2)}))`)
  await configureUpdateService(configFile, worker, config, true)
  const { stdout } = await ps(`$t=Get-ScheduledTask -TaskName '${id}'; @{runLevel=[string]$t.Principal.RunLevel; logon=[string]$t.Principal.LogonType; triggers=$t.Triggers.Count} | ConvertTo-Json -Compress; Start-ScheduledTask -TaskName '${id}'`)
  const task = JSON.parse(stdout.trim()); assert.equal(task.runLevel, 'Limited'); assert.equal(task.logon, 'Interactive'); assert.equal(task.triggers, 2)
  const deadline = Date.now()+45000
  let result
  while(Date.now()<deadline) { try { result=JSON.parse(await readFile(marker,'utf8')); break } catch {} await new Promise(r=>setTimeout(r,250)) }
  assert.deepEqual(result, { node:'1',args:['--config',configFile] })
  await configureUpdateService(configFile,worker,config,false)
  const gone=await ps(`@(Get-ScheduledTask -TaskName '${id}' -ErrorAction SilentlyContinue).Count`)
  assert.equal(gone.stdout.trim(),'0')
  console.log('Windows current-user task: registered without elevation, executed quoted paths, preserved Node mode, and removed on opt-out')
} finally { await configureUpdateService(configFile,worker,config,false).catch(()=>{}); await rm(root,{recursive:true,force:true}) }
