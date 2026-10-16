# DSH SSH Ops

为 DeepSeek Harness（DSH）提供独立的 SSH 运维面板和完整远端工作区。

支持主机管理、多终端、SFTP 传输、端口转发、集群执行，以及六个 Agent 工具。SSH 工作区会在远端运行完整 DSH，使会话、插件、文件、终端和后台任务位于同一台机器；本机通过经过认证的 SSH 网关访问远端界面。

本项目从 [dsh-web 的 SSH 模块](https://github.com/zhu1090093659/dsh-web/tree/v0.3.24/packages/dsh-ssh) 独立派生，保留 Apache-2.0 许可。它是第三方插件，与 DeepSeek 官方的底层 SSH 提供方不是同一个包。来源与改动见 [docs/upstream.md](docs/upstream.md)。

## 安装

当前版本：**0.3.24-jay.29**。

在 DSH 左侧打开 **插件 → 添加插件**，在「包名或地址」填入：

```text
@biogod/dsh-ssh@0.3.24-jay.29
```

选择 **npm 官方源** 或 **中国大陆镜像源**，点击 **安装 → 立即启用**。若提示需要重启，在空闲时重启 DSH，侧栏会出现 **SSH**。安装和启用以界面实际结果为准。

**桌面版 rc.2 从 .25 升到 .26 后，请完全退出 DSH 再重新打开。** 同一进程卸载、重装插件时，界面可能已经更新，但后端仍缓存旧模块；仅刷新页面或停用再启用不足以确认更新。先保存正在编辑的内容，退出会断开本机持有的 SSH 终端；主机配置和已记住的密码继续保留。

也可以在终端执行：

```sh
dsh plugin --profile web add @biogod/dsh-ssh@0.3.24-jay.29
```

**从旧版迁移：**若已安装 `@jay-local/dsh-ssh-ops`，在插件页先卸载旧包，再安装本包，避免两个包同时提供相同服务。卸载不删除主机配置和已保存的工作区记录。重启本机 DSH 会结束它持有的 SSH 运维终端；远端工作区的 DSH 服务和数据继续保留。

发布包包含构建产物和 ssh2 的必需纯 JavaScript 依赖，无需本地编译原生模块或放开构建脚本。安装仍需下载其余运行依赖。国内镜像提供 npm 包，不会镜像 GitHub 仓库或 Release。

GitHub 默认分支保存源码，不包含 `lib/` 构建产物。历史 [GitHub Release](https://github.com/Biogod2020/dsh-ssh/releases/tag/v0.3.24-jay.25) 保留旧包名的预构建 `.tgz`，可作为备用安装方式。

## 兼容版本

| DSH | 状态 |
| --- | --- |
| `0.2.1-alpha.4` | 当前适配版本 |
| `0.2.0-rc.2` | 保留兼容 |
| `0.1.7-alpha.1`、`0.1.6-alpha.2` | 保留已验收的旧版路径 |

本机 Node.js 要求 `^22.19.0` 或 `>=24.0.0`。完整远端工作区支持 Linux / macOS 的 x64、arm64；Windows 远端不在自动安装范围内。其他 DSH 版本需要重新验收，插件不使用宽泛版本范围声称兼容。

## 使用

- **SSH 面板**：添加主机或导入 `~/.ssh/config`，使用 Hosts、Terminal、Transfer、Tunnels 和 Cluster 页签。
- **多终端**：同一主机或不同主机可各开独立 shell。切换到其他原生页面后返回，保留原终端、队列和草稿。网页刷新可重新附着本机 DSH 保存的 shell；本机进程退出后不能恢复该 shell。
- **远端工作区**：选择 **Add workspace → SSH workspace**，选择主机和远端目录，然后 **Connect and add**。首次连接会显示检查、安装和启动进度，也可留在后台准备。
- **Agent 工具**：`ssh_list`、`ssh_exec`、`ssh_upload`、`ssh_download`、`ssh_tunnel`、`ssh_cluster` 只操作用户已经配置的主机。

首次连接前，必须通过可信渠道核对目标及跳板机指纹，并由 OpenSSH 建立 known_hosts 信任。本插件不会自动接受新密钥或覆盖变化的密钥。

### 密钥、回退密码与记住密码

若 Terminal 可以免密码登录，请在主机的 **Edit → Key** 中使用相同的私钥路径，或选择 **SSH Agent**。免密码登录不表示服务器的账号密码也能登录。插件不会自动读取 Terminal 已解锁的 macOS 钥匙串；加密私钥可填写密钥口令或通过 SSH Agent 使用。

Key 和 SSH Agent 下均可填写 **回退密码（可选）**，先尝试所选密钥或 Agent，再尝试密码。勾选 **记住密码** 后，下次启动仍可使用；不勾选则只保留在当前 DSH 进程中，停用插件或退出 DSH 后清除。已有保存的密码继续保留，编辑时留空不覆盖；**清除密码** 后保存即可移除。密码不返回浏览器或 Agent 的主机列表。

**Add workspace → SSH workspace → 认证 / 回退密码** 可直接修改所选主机，再手动点击 **Connect and add**。修改认证不会重放上次的连接或远端操作。测试连接不代填验证码；终端可显示额外的交互认证提示。

新远端环境按需安装固定的 Node `24.16.0` 和 DSH `0.2.1-alpha.4`，下载校验及 CLI 检查通过后才启用。已有兼容安装和活动服务会继续复用。无需 sudo，不修改 shell 启动文件或全局 npm 安装。远端模型与插件需在远端独立配置，本机凭据和旧会话不会自动复制。

## 安全与行为边界

- 目标和每层跳板机均严格校验 known_hosts；未知、变化或吊销的密钥拒绝连接。
- HTTP / WebSocket 使用 DSH 官方认证，并保留 loopback 和同源检查；本地转发只监听 `127.0.0.1`。
- 已派发命令、传输、聊天和插件操作不会自动重放。中断结果可能未确认，停止等待不保证远端程序已经退出。
- 不包含匿名安装统计。主机配置沿用用户私有文件的权限保护；如保存密码或密钥口令，它们以明文存储。优先使用密钥或 ssh-agent。
- Agent 执行输出按原文返回，可能含远端敏感信息。上传与下载以 DSH 宿主权限访问本机路径，不受本地 Bash 沙箱限制。
- `ProxyCommand` 以宿主权限执行，只应配置可信命令。导入器不是完整的 OpenSSH 配置解释器，导入后应检查地址、认证及跳板。
- 不提供跨主机合并会话档案、断电后的 PTY 持久恢复、目录下载或传输断点续传。

架构及恢复语义见 [docs/remote-runtime.md](docs/remote-runtime.md)，验收范围见 [docs/verification.md](docs/verification.md)。

## 开发与本地构建

使用 Node 24 和仓库声明的 pnpm `11.20.0`。真实 SSH 测试需要可启动的本地 OpenSSH sshd，测试只使用临时主机密钥、账号环境和独立信任文件。

```sh
git clone https://github.com/Biogod2020/dsh-ssh.git
cd dsh-ssh
pnpm install --frozen-lockfile --ignore-scripts
pnpm release:local
```

`release:local` 在临时源码副本中执行 typecheck、测试、构建和产物检查，生成 `.tgz` 与 `.sha256`，不会替换原目录的 `lib/`。ssh2 的必需依赖会以纯 JavaScript 形式打包。

需要直接链接源码时，先构建，再安装目录：

```sh
pnpm verify
dsh plugin --profile web add "link:$(pwd)"
```

已链接客户端的构建可能触发 DSH 热更新并重置页面状态，因此日常使用推荐安装 npm 发布包。不要用开发中的热更新代替最终构建验收。

## 卸载

```sh
dsh plugin --profile web remove @biogod/dsh-ssh
```

卸载会断开本机插件持有的连接和网关，不删除远端 DSH 服务、远端数据或原有会话。

Apache-2.0，详见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
