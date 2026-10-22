# SSH 插件验收记录

验收日期：2026-10-15（America/Los_Angeles）。

## 0.3.24-jay.26：认证与密码保存

- npm 已发布，`latest` 指向该版本；官方源和国内镜像的归档 SHA-256 均为 `8238e7731350f469171424c5e684eca2323a62f627006c009a367e84ba386f56`。
- 按 npm 包名从官方源安装到 DSH alpha.4、从国内镜像安装到 DSH rc.2，均通过隔离运行验收。
- 2026-10-16 实际 macOS 桌面版 rc.2 通过插件页从国内镜像安装并启用 `.26`，组件状态为 Running；原主机配置字节未变，其他插件依赖保持不变。
- 补充升级检查：rc.2 在同一进程中 remove/install/enable 均报告 applied，但仍运行 .25 的后端，PATCH 回退密码时报 `auth.keyPath is required for key auth`。隔离环境完全重启后，新能力字段出现，同一 PATCH 返回 200 并保留私钥路径。安装版本和组件 Running 状态不能单独证明后端已换新；.25 → .26 的桌面迁移需要完全重启。
- 61 个测试文件 / 576 项测试、typecheck、build、产物检查通过。
- 生成的 loopback SSH 身份验证覆盖密钥优先、拒绝或无法读取密钥后的密码回退、不可用 Agent 回退、未知主机密钥拒绝、单次派发后连接断开不重放。
- 键盘交互覆盖空 PAM 提示、账号密码和一次性密码分离。不会把保存的账号密码填入标识为 OTP / verification / one-time password 的提示。
- 存储检查覆盖仅内存、记住密码、取消记住、清除、凭据不返回主机列表、切换账号或地址时不沿用内存密码；私有配置保持 0600。
- DSH `0.2.0-rc.2`、`0.2.1-alpha.4` 均在新建私有 HOME 中安装最终 tarball，通过 HTTP / WebSocket 认证、同源检查、原生设置和插件启停验收。
- 浏览器使用生成的 loopback SSH 测试主机，验证保存回退密码后测试连接成功。工作区新增认证编辑入口，并在打开子弹窗时移动焦点和隐藏父弹窗的辅助功能节点。
- 未为这些测试调用模型 API；生产服务器的密码与 OTP 组合仍由服务器策略决定。

## 0.3.24-jay.25：npm 分发验收

- 公开包名为 `@biogod/dsh-ssh@0.3.24-jay.25`，`latest` 指向该版本。原 GitHub Release 与标签保持不变。
- 本次重新执行 typecheck、58 个测试文件 / 543 项测试、构建和产物检查，全部通过；修复测试用 sshd 日志流过早关闭导致的 write-after-end 时序问题。
- npm 官方源与中国大陆镜像的版本和归档完整性一致。发行归档 SHA-256：`5188d48a8119d2b38778bb25bfb0078ba2f0d5b4b7e1d371b2599da84b6ea355`。
- DSH `0.2.1-alpha.4`（npm 官方源）与 `0.2.0-rc.2`（显式国内镜像源）均在全新独立 HOME 中按包名安装并通过 runtime smoke、原生设置和启停检查。
- 实际 alpha.4 Web 插件页填写公开包名、选择中国大陆镜像，完成安装和启用，侧栏出现 SSH，面板正常打开。另通过同一运行实例的 HTTP / WebSocket 认证、同源限制、主机管理和失败连接检查。
- 旧包卸载后安装公开包的隔离迁移检查通过：主机配置字节保持一致，新运行实例能读出原主机，未派发 SSH 连接。
- 未修改日常 DSH profile，未使用真实主机、凭据或模型请求。

## 既有功能验收

- typecheck、58 个测试文件 / 543 项测试、构建和产物检查通过。
- DSH `0.2.0-rc.2` 与 `0.2.1-alpha.4` 的全新私有 HOME 实际安装通过，覆盖 HTTP / WebSocket 认证、同源限制、客户端清单、主机管理、失败连接、原生设置和开关。
- alpha.4 的本地链接替换为预构建 tarball 通过，无需先卸载或放开原生构建脚本。
- 5 项真实 loopback SSH + alpha.4 远端运行时集成通过，覆盖直接文件操作插件、工作区 / 会话 / 终端 RPC、事件流、隧道恢复、daemon 不重启、已派发准备不重放及主机身份冻结。
- 实际 alpha.4 浏览器检查了原生 SSH 入口、展开与折叠侧栏、终端经 Plugins 页面往返后保持同一 shell。定向测试还覆盖草稿保留和运行中集群观察不取消、不重发。
- 一次性真实 SSH 环境完成 Node 和固定 DSH 的冷安装、下载校验、依赖安装、启动及经过认证的远端完整界面打开。
- 安装包仅携带 ssh2 的必需纯 JS 依赖，不携带可选 `.node` 模块；包路径和依赖闭包均检查。测试使用生成的 SSH 密钥和私有信任文件。

既有 jsdom canvas 和部分 SDK 缺失 sourcemap 的诊断不影响上述通过结果；没有将它们宣称为已修复。

本轮没有重新全面验收生产 PAM / OTP、多 GiB 压力、所有终端协议、Windows 或 Linux 冷安装，也没有调用模型 API。历史支持不等于本轮在所有平台重跑。真实用户配置与日常进程不用于测试。

复验方式见 README 和 `scripts/compatibility-smoke.mjs`、`scripts/remote-browser-smoke.ts`。服务日志可能含临时认证信息，不应上传或分享。


## 2026-10-16 — jay.27: explicit SSH host selection

- Import now previews local `~/.ssh/config` candidates with every checkbox initially empty. Only selected aliases are saved; existing hosts are preserved. GET preview is read-only and excludes credentials, key paths and ProxyCommand text; POST rejects a missing selection. No key checks, proxy commands or SSH connections run during preview.
- Add workspace starts with an empty host choice. Selecting a host, editing the path, saving authentication and importing hosts do not browse or connect. The Browse button explicitly requests remote directories; changing host/path closes browsing and discards stale results. Connect and add remains an explicit action.
- Release snapshot passed typecheck, all 61 suites / 582 tests, build and artifact checks. Verified prebuilt archive SHA-256: `b975f1201963d80e02e3b18881fbc05c9483ddf5fbb695ef202b59ebfe497664`. Isolated runtimes passed on DSH 0.2.0-rc.2 and 0.2.1-alpha.4.
- Isolated browser acceptance used generated loopback SSH identities. Importing only `dev-two` saved only that candidate; opening, importing and choosing it produced zero SSH connections and zero commands. Explicit Browse produced exactly one connection and zero commands. UI screenshot and private evidence: `/Users/jay/scratch/dsh-ssh-selection-release-20261016/`.
- Desktop rc.2 installed the verified .27 tarball through the plugin GUI and was fully quit/reopened. Other plugin dependencies and the private host store were preserved. npm .27 is staged pending the account holder's publication authentication; registry/mirror acceptance will be recorded after approval.


### Automatic publisher bootstrap

GitHub Actions preflight run `38876888021` passed all 61 suites / 582 tests, artifact checks and both DSH runtime acceptances on Ubuntu. The package owner completed the one-time GitHub trusted publisher binding for `Biogod2020/dsh-ssh`, `publish.yml`, with direct publish permission. Tagged run `38877111308` authenticated and signed npm provenance, then npm rejected .27 with E409 because a previously staged version reserves that version number. That pending stage is left unchanged. The same SSH behavior is released as .28 to validate direct OIDC publication without another maintainer approval.


### jay.28 automatic release verified

- Tagged workflow [38877659704](https://github.com/Biogod2020/dsh-ssh/actions/runs/38877659704) completed successfully: full verification, direct OIDC npm publication, and registry/mirror installation acceptance. No per-release maintainer approval was used. npm provenance is present.
- Published archive: 1,119,367 bytes; SHA-256 `be6b267eaf3d41aba7d71282c78b8ae12ac2a2d4d1dabb16605fab7ed8bad0ca`. npm and the actual `cdn.npmmirror.com` archive both matched the tested archive's SHA-512.
- macOS independently installed `@biogod/dsh-ssh@0.3.24-jay.28` by package name from npm into DSH 0.2.1-alpha.4, and from the mainland mirror into DSH 0.2.0-rc.2; authenticated runtime and native settings/enable checks passed.
- Daily Desktop already runs the .27 acceptance package with the same SSH implementation. It was not replaced again after the machine locked; .28 is the formal npm release. Existing host configuration remains byte-identical to the pre-update backup.


## 2026-10-16 — jay.29: remote workspaces inside Desktop

- Replaced Desktop top-level loopback navigation with the shipped `dshDesktop.browser` guest lease interface. The parent stays on `dsh-app://app/`; Return to local retains the owned guest and its draft, and reopening reuses that guest. Closing a view confirms draft loss and leaves remote services running. No automatic external-browser fallback is used. Browser deployments retain in-tab navigation.
- Gateway tickets, Strict/HttpOnly cookies, SSH host-key verification and no-replay rules remain in force. The embedded view mode only hides duplicate local/recovery links; it does not grant authentication. Desktop guests have no local Node/preload/Host privileges, and native page downloads follow the Desktop browser restriction. Local SSH transfer tools remain available.
- Typecheck, all 62 suites / 588 tests, build and artifact checks passed. Real-SSH tests verified the embedded ticket still requires authentication and retains Strict cookies.
- Actual Desktop rc.2 acceptance used a separate HOME/DSH_HOME, a private port and a generated loopback SSH identity; no user SSH host or model credential was used. The remote DSH rendered in the same application window. Returning to local and reopening preserved the exact unsent fixture draft and gateway origin. Evidence: `/Users/jay/scratch/dsh-ssh-desktop-release-20261016/native-verification.json` and `in-app-workspace.png`.


### jay.29 deployment and publication

Daily Desktop rc.2 installed the verified .29 local archive through its plugin GUI, enabled it and was fully quit/reopened. Both installed client/backend files matched the verified archive; the SSH host store remained byte-identical and 0600, and other plugin dependencies were preserved. User workspaces and model configuration were retained; no real SSH target was used for acceptance.

The OIDC [release workflow](https://github.com/Biogod2020/dsh-ssh/actions/runs/38886410320) completed all three jobs successfully. The published CI archive (1,131,337 bytes) and its actual mainland mirror CDN download matched the tested SHA-512. Official/mirror package-name installation passed in isolated DSH alpha.4/rc.2 runtimes. The registry check now reads the canonical package document to avoid stale negative caches on newly published version URLs.


## 2026-10-21 — jay.33: native unified project and session navigation

- Local and remote projects/conversations now share the native sidebar. Presentation-only synthetic IDs never enter local Controllers; local callbacks remain intact and remote actions route to their recorded Host. New Session follows the visible project. Legacy local SSH history remains readable and guarded.
- One isolated Desktop guest is retained per Host. Session switching uses the public remote navigation service, preserving per-session drafts without replacing the document. The first server-manifest synchronization cannot remove the page-local navigation bridge. Embedded views hide the duplicate sidebar and toolbar; the local blank draft remains addressable.
- The SSH workspace host picker supports bounded search, keyboard selection and successful-connection recency. Search, selection and cached session display do not connect SSH. Disconnected catalog entries remain explicitly stale; prompt/command/session creation is never replayed.
- The public release source passed typecheck, all 68 suites / 615 tests, build and archive checks on macOS with DSH 0.2.1-rc.2 as the real-SSH fixture runtime. Runtime source matches the locally installed, native-UI-verified jay.32-local.1 candidate byte-for-byte. Its isolated Desktop acceptance covered local/remote session and draft round trips, New Session routing, remote Files ownership, and alpha.4 navigation after the first manifest sync. No model request was used.
- The existing local installation retained 360 protected data/configuration files byte-for-byte; only the two expected Desktop dependency files changed. Production SSH hosts were not used as test targets.
- The release workflow also requires exact-archive acceptance on DSH 0.2.0-rc.2, 0.2.1-alpha.4 and 0.2.1-rc.2, an additional alpha.4 real-SSH test, then npm/mirror integrity and by-name installation checks. Publication results are recorded after these gates complete.
- Remote model relay and local-Agent/remote-executor modes remain documented design options, not enabled features. Independent remote DSH processes continue after local gateway/controller shutdown subject to the remote process and network environment.

The jay.32 tagged run stopped before npm publication: its additional alpha.4 test assumed the root DSH version determined the terminal protocol. A clean alpha.4 installation can resolve a newer terminal-controller dependency with the duplex attach endpoint. The integration fixture now negotiates only the read-only attachment, falling back on explicit endpoint absence, before sending exactly one terminal write. This changes test compatibility, not the generic production gateway. The failed jay.32 tag is retained; jay.33 is the next release candidate.


### jay.33 registry and macOS installation acceptance

- GitHub Actions OIDC accepted the release and signed npm provenance. npm processing delayed public visibility; the official registry and the actual mainland mirror CDN subsequently served the same tested archive: 1,177,983 bytes, SHA-256 `01f3ee02bad6682213ba2663f47cbe30b1f371c3ff0a28b9a5e454693058d030`.
- macOS independently installed `@biogod/dsh-ssh@0.3.24-jay.33` by package name from npm into DSH 0.2.1-rc.2 and from the mirror into DSH 0.2.1-alpha.4. Both authenticated runtime, native settings and enable/disable checks passed in isolated homes. The daily Desktop configuration and sessions were not changed for publication.
- The mirror initially cached the previous package index. The verifier now waits for the official archive before requesting synchronization and uses the mirror-supported cache refresh parameters. A delayed-publication fixture verified that synchronization never precedes official archive acceptance, and the corrected verifier checked the actual npm and `cdn.npmmirror.com` downloads. This only changes future release checks; the published runtime sources are unchanged.

The [tagged release workflow](https://github.com/Biogod2020/dsh-ssh/actions/runs/39607583854) completed all three jobs successfully: verify, publish and verify-installation. The exact archive and the three by-name installation acceptances passed on Ubuntu without another publication or a workflow rerun. Both registries advertise jay.33 as latest and expose the signed provenance.


## 2026-10-21 — jay.34: contain disconnected SSH forwarding failures

The installed jay.32-local.1 archive and the public jay.33 archive allow ssh2 forwardOut to throw from the local TCP accept callback after SSH disconnects. The exception escapes the plugin and terminates the DSH host. A separate process reproduced the same Not connected crash without connecting a production host. The isolated installed-archive fault fixture also reproduced it with jay.33 after a real SSH disconnect.

The tunnel now handles local socket errors before opening a channel, contains synchronous forwardOut errors, and releases channels returned after their local socket has closed. Failures only close the affected pair; the listener, other connections and remote processes keep their existing ownership. No reconnect or request replay is added. Four child-process regressions cover public/workspace stale connections, early socket errors with a late channel, and asynchronous rejection. The original code fails three of the four checks; the corrected code passes all four and the existing engine/tunnel tests.

The release workflow now installs the exact archive into an isolated DSH process, disconnects one generated SSH fixture, sends three requests to the stale forward, and requires the DSH HTTP API and an independent tunnel to remain healthy. It also requires no new SSH connection, no dispatched command and no model request.

Local release verification passed all 69 suites / 619 tests, typecheck, build and artifact checks. The exact jay.34 archive passed DSH 0.2.1-rc.2 isolated compatibility and the installed-archive SSH-disconnect test: the process and independent tunnel remained available after three rejected forwards, with no reconnect, command or model request. The archive installed into the daily Desktop profile matched both tested client/backend bundles byte-for-byte; 6,006 protected files remained byte-identical and only the two expected dependency files changed. The article plugin and all other dependency declarations were preserved.
