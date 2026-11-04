import { createHash } from 'node:crypto'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { UpdateConfig } from './update-types.ts'

const run = promisify(execFile)
const xml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const psQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'"
const powershell = (code: string) => ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from('$ErrorActionPreference = \'Stop\'; ' + code, 'utf16le').toString('base64')]
const unitArg = (text: string) => '"' + text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$') + '"'

/** A per-user scheduler keeps the helper available if DSH later refuses the old plugin. */
export function updateServicePlan(configFile: string, worker: string, config: UpdateConfig,
  platform = process.platform, home = homedir(), uid = process.getuid?.()): { files: Record<string, string>; enable: string[][]; disable: string[][] } {
  const id = 'ai.biogod.dsh-ssh-update.' + createHash('sha256').update(configFile).digest('hex').slice(0, 16)
  const args = [config.executable, ...config.executableArgs, worker, '--config', configFile]
  if (args.some(value => /[\r\n\0]/.test(value))) throw new Error('Unsupported updater executable or configuration path')
  if (platform === 'darwin' && uid !== undefined) {
    const path = join(home, 'Library/LaunchAgents', id + '.plist')
    const domain = `gui/${uid}`
    return {
      files: { [path]: `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${id}</string><key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array><key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict><key>RunAtLoad</key><true/><key>StartInterval</key><integer>21600</integer><key>ProcessType</key><string>Background</string></dict></plist>\n` },
      enable: [['launchctl', 'bootstrap', domain, path]], disable: [['launchctl', 'bootout', `${domain}/${id}`]],
    }
  }
  if (platform === 'linux') {
    const folder = join(home, '.config/systemd/user')
    return {
      files: {
        [join(folder, id + '.service')]: `[Unit]\nDescription=DSH SSH plugin updater\n[Service]\nType=oneshot\nEnvironment=ELECTRON_RUN_AS_NODE=1\nExecStart=${args.map(unitArg).join(' ')}\nTimeoutStartSec=infinity\n`,
        [join(folder, id + '.timer')]: `[Unit]\nDescription=Check DSH SSH plugin updates\n[Timer]\nOnBootSec=2min\nOnUnitInactiveSec=6h\nUnit=${id}.service\n[Install]\nWantedBy=timers.target\n`,
      },
      enable: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', id + '.timer']],
      disable: [['systemctl', '--user', 'stop', id + '.timer'], ['systemctl', '--user', 'disable', id + '.timer'], ['systemctl', '--user', 'stop', id + '.service']],
    }
  }
  if (platform === 'win32') {
    const launcher = join(dirname(configFile), 'scheduled-update.ps1')
    const task = psQuote(id)
    const register = `$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; `
      + `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${psQuote('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + launcher + '"')}; `
      + `$login = New-ScheduledTaskTrigger -AtLogOn -User $user; `
      + `$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 6); `
      + `$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited; `
      + `$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable; `
      + `Register-ScheduledTask -TaskName ${task} -Action $action -Trigger @($login, $repeat) -Principal $principal -Settings $settings -Force | Out-Null`
    return { files: { [launcher]: "\uFEFF$ErrorActionPreference = 'Stop'\n$env:ELECTRON_RUN_AS_NODE = '1'\n& " + args.map(psQuote).join(' ') + '\nexit $LASTEXITCODE\n' },
      enable: [powershell(register)],
      disable: [powershell(`Get-ScheduledTask -TaskName ${task} -ErrorAction SilentlyContinue | Stop-ScheduledTask; Get-ScheduledTask -TaskName ${task} -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false`)] }
  }
  throw new Error('The automatic updater requires macOS launchd, Linux user systemd or Windows Task Scheduler')
}

export async function configureUpdateService(configFile: string, worker: string, config: UpdateConfig, enabled: boolean): Promise<void> {
  const plan = updateServicePlan(configFile, worker, config)
  if (!enabled) for (const path of Object.keys(plan.files)) await rm(path, { force: true })
  for (const args of plan.disable) { try { await run(args[0]!,  args.slice(1), { timeout: 30000, windowsHide: true }) } catch { /* Not loaded yet. */ } }
  if (enabled) {
    for (const [path, content] of Object.entries(plan.files)) {
      await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
      await writeFile(path, content, { mode: 0o600 })
    }
    try { for (const args of plan.enable) await run(args[0]!,  args.slice(1), { timeout: 30000, windowsHide: true }) }
    catch (error) {
      for (const args of plan.disable) { try { await run(args[0]!,  args.slice(1), { timeout: 30000, windowsHide: true }) } catch {} }
      for (const path of Object.keys(plan.files)) await rm(path, { force: true })
      throw error
    }
  } else {
    if (process.platform === 'linux') await run('systemctl', ['--user', 'daemon-reload'], { timeout: 30000, windowsHide: true }).catch(() => {})
  }
}
