/**
 * dsh-ssh — host half. Mounts the SSH engine (persistent ssh2 connection
 * pool, exec / PTY shell / SFTP / tunnels / cluster), the /api/dsh-ssh route
 * family plus the terminal WebSocket upgrade, the agent tools (ssh_list,
 * ssh_exec, ssh_upload, ssh_download, ssh_tunnel, ssh_cluster), and a
 * system-prompt announcement. The browser half (./client) renders the host
 * manager and web terminal. Everything rides official NPM SDK packages —
 * no dsh source changes.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { Config, LegacyConfig, configValues } from './settings.ts'
export { Config } from './settings.ts'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { SshEngine } from './engine.ts'
import { makeRoutes } from './routes.ts'
import { HostStore } from './store.ts'
import { sshClusterTool, sshDownloadTool, sshExecTool, sshListTool, sshTunnelTool, sshUploadTool } from './tools.ts'
import { mountOnce } from './mount-once.ts'
import { SshWorkspaces, installWorkspaceTools } from './workspaces.ts'
import type { SshRoutesDeps } from './routes.ts'
import { readFileSync } from 'node:fs'
import { RemoteWorkspaces } from './remote/manager.ts'
import { remoteRoutes } from './remote/routes.ts'

/** Stable cordis plugin name. */
export const name = 'ssh-ops'

/** Services required before the SSH surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt', 'connection']

/**
 * Settings namespace of the SSH capability — the section the web settings
 * surface edits. Spelled here rather than imported: the browser half spells
 * the same value and must not depend on a Host package.
 */
export const SSH_SETTINGS_NAMESPACE = 'dsh-ssh' as SettingsNamespace

/** Optional APIs served by older DSH settings providers before schema-derived forms. */
interface LegacySettings {
  installSection?(owner: Context, namespace: SettingsNamespace, schema: typeof LegacyConfig,
    base: ReturnType<typeof configValues>, hooks: { setSource(source: () => Config): void; onChange(): void }): unknown
  register?(namespace: SettingsNamespace, schema: typeof LegacyConfig,
    options: { base: ReturnType<typeof configValues> }): { get?(): Config; watch?(listener: () => void): unknown }
}

/** Plugin config, validated by the same-named schemastery schema. */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 150

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const SSH_GUIDANCE = '本机安装独立维护的 SSH Ops 插件（侧边栏 SSH）。ssh_list 列出已配置主机，ssh_exec 执行远程命令，ssh_upload/ssh_download 传输文件，ssh_tunnel 创建本地隧道，ssh_cluster 对显式筛选的主机执行命令。只使用用户已配置或导入的别名，不得臆造主机。所有目标和跳板机必须通过本机 OpenSSH known_hosts 校验；未知、变更或吊销的密钥拒绝连接，不得自动接受。断线或超时不会自动重放命令，远端结果可能未知，应先核实副作用，不得擅自重试。SSH 操作会消耗真实远端资源，写入、部署、删除和传输前确认用户意图。输出原样返回，可能含秘密；本地文件传输不受 bash 沙箱保护。推荐 ssh-agent 或密钥认证；若用户选择保存密码或密钥口令，将明文保存在 DSH_HOME 下权限 0600 的主机文件。通过 Add workspace 创建的 SSH 工作区使用远端完整 DSH 服务，会话、插件、文件和终端属于远端主机。首次连接自动检测并按需安装兼容运行环境。模型与插件在各自的 DSH 环境配置。旧本地 SSH 会话保留为历史；从 SSH workspaces 列表打开对应远端工作区继续工作。'

/**
 * Mount the SSH engine, routes, tools, and announcement.
 * @param ctx - host plugin context carrying webServer/tools/systemPrompt.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export const apply = mountOnce('@biogod/dsh-ssh', applyImpl)

function applyImpl(ctx: Context, config?: Config): void {
  // The live source the surfaces read: the settings section once the web
  // settings surface is served, the composition entry otherwise.
  let current: () => Config = () => config ?? {}

  const store = new HostStore()
  const engine = new SshEngine(store)
  const workspaces = new SshWorkspaces(engine)
  const remoteWorkspaces = new RemoteWorkspaces(engine, {
    installer: readFileSync(new URL('../assets/remote-install.sh', import.meta.url), 'utf8'),
    bootstrap: readFileSync(new URL('../assets/remote-bootstrap.mjs', import.meta.url), 'utf8'),
    returnUrl: () => `http://127.0.0.1:${ctx.webServer.port}/`,
    legacy: () => workspaces.list(),
  })
  installWorkspaceTools(ctx, workspaces, () => configValues(current()).enabled, true)
  ctx.effect(() => () => { remoteWorkspaces.dispose(); engine.dispose() }, 'dsh-ssh: engine')

  const resolve = () => configValues(current())

  // The /api/dsh-ssh route family + terminal upgrade.
  const { routes, upgrade, terminals } = makeRoutes({ store, engine, workspaces,
    legacyReadOnly: true,
    workspaceRegistry: () => ctx.get('workspaceRegistry') as ReturnType<NonNullable<SshRoutesDeps['workspaceRegistry']>>,
    requestRejection: (req) => (ctx.get('connection') as HostConnectionHandle).requestRejection(req),
  })
  ctx.effect(() => () => terminals.dispose(), 'dsh-ssh: terminals')
  routes.push(...remoteRoutes(remoteWorkspaces, req => (ctx.get('connection') as HostConnectionHandle).requestRejection(req)))
  let disposeRoutes: (() => void) | undefined

  // Agent tools + their prompt sections.
  const tools = [
    sshListTool(engine),
    sshExecTool(engine),
    sshUploadTool(engine),
    sshDownloadTool(engine),
    sshTunnelTool(engine),
    sshClusterTool(engine),
  ]
  let disposeTools: (() => void) | undefined

  // System-prompt announcement.
  let disposeSection: (() => void) | undefined

  // Register (or drop) every surface to match the current source. Each group
  // is kept under one disposer: re-registering first tears the old one down
  // so duplicate-name registrations never throw.
  const sync = (): void => {
    const value = resolve()
    remoteWorkspaces.setEnabled(value.enabled ?? true)
    terminals.setEnabled(value.enabled ?? true)
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (disposeRoutes !== undefined) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    if (disposeTools !== undefined) {
      disposeTools()
      disposeTools = undefined
    }
    if (!value.enabled) return
    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-ssh',
        order: SECTION_ORDER,
        text: SSH_GUIDANCE,
      })
    }
    disposeRoutes = ctx.effect(
      () => {
        const disposers = routes.map(route => ctx.webServer.register(route))
        const upgradeDisposer = ctx.webServer.registerUpgrade(upgrade)
        return () => {
          for (const dispose of disposers) dispose()
          upgradeDisposer()
        }
      },
      'dsh-ssh: routes',
    )
    disposeTools = ctx.effect(
      () => {
        const disposers = tools.map(tool => ctx.tools.register(tool))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-ssh: tools',
    )
  }

  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.get('settings') as LegacySettings | undefined
    try {
      if (typeof settings?.installSection === 'function') {
        settings.installSection(ctx, SSH_SETTINGS_NAMESPACE, LegacyConfig, configValues(config), {
          setSource: (source) => {
            current = source
            sync()
          },
          onChange: sync,
        })
      } else if (typeof settings?.register === 'function') {
        const scope = settings.register(SSH_SETTINGS_NAMESPACE, LegacyConfig, { base: configValues(config) })
        current = () => scope?.get?.() ?? (config ?? {})
        scope?.watch?.(() => { sync() })
      }
    } catch {
      // Defensive fallback against settings registration differences
    }
  })

  ctx.on('loader/volatile-update', () => { sync() })

  // Initial registration from the composition entry (covers deployments with
  // no settings service, whose installSection never fires its hooks).
  sync()
}
