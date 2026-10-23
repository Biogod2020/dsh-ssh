# npm 自动发布配置

工作流为 `.github/workflows/publish.yml`。普通分支手动运行只做验收；推送与 package.json 版本完全一致的 `v<version>` 标签才会发布。

流程先运行 typecheck、完整测试、构建、归档检查，以及 DSH alpha.4 / 两个 rc.2 的隔离安装，并检查安装包的增量磁盘历史、离线阅读、控制器重启、旧版数据回退和 SSH 断线隔离。`verify` 通过后，发布任务下载同一次构建的归档，校验 SHA-256 后使用 npm OIDC 发布，不重新打包，也不保存 npm 写入 Token。内置浏览器中的真实 Web 功能操作按[核心验收清单](core-release-acceptance-2026-10-23.md)完成。

按用户 2026-10-23 的要求，默认与版本标签使用 `core-e2e`。开发分支可手动选 `all` 追加大目录、SDK 契约、存储和网络基准、长离线及观察器校准；`kernel-only` 只复核内核丢包夹具。专项工具和原始失败记录保留，不再要求每版重复所有压力检查或等待 24 小时。它们的结果与核心实际使用分开报告。

发布后自动请求国内镜像同步，核对 npm 和镜像实际下载文件的 SHA-512，再从两个源按包名安装进隔离 DSH 验收。镜像迟迟未同步或安装失败时，流水线报告失败，不能视为完整发行成功。发布任务之外的检查任务均没有 npm OIDC 发布权限。

首次启用时，在 npm 的 `@biogod/dsh-ssh` 包设置中新增 GitHub Actions Trusted Publisher：

| 配置 | 值 |
| --- | --- |
| Organization or user | `Biogod2020` |
| Repository | `dsh-ssh` |
| Workflow filename | `publish.yml` |
| Environment name | 留空 |
| Allowed actions | 允许 `npm publish`；不需要额外允许 `npm dist-tag` |

首次授予发布权限需要账号验证。只允许 `npm stage publish` 仍会要求维护者逐次 2FA 审批；要免除日常发版的手动验证，必须允许这个指定工作流直接 `npm publish`。账号登录、修改发布权限等操作仍可能要求验证。

也可以用已登录的 npm 命令行完成一次绑定，无需在网页手动填写：

```sh
npm exec --yes --package=npm@11.15.0 -- npm trust github @biogod/dsh-ssh --repo=Biogod2020/dsh-ssh --file=publish.yml --allow-publish --yes --registry=https://registry.npmjs.org
```

这条命令只授权上述仓库、工作流发布这个包；首次需要账号本人完成 npm 验证。绑定后由维护者推送版本标签，后续发布不再运行 `stage approve`。不要启用仅暂存权限，否则依然会逐次要求审批。

工作流文件准备好不代表 npm 的信任关系已经启用。完成 npm 配置后，应在两天内用一个尚未发布的版本验证首次 OIDC 发布；发布成功才算完成配置。

官方说明：[Trusted publishing](https://docs.npmjs.com/trusted-publishers/)、[Staged publishing](https://docs.npmjs.com/staged-publishing/)。


## 首次启用验收（2026-10-16）

已完成账号首次绑定，并由版本标签 `v0.3.24-jay.28` 验证自动发布成功：[完整流水线](https://github.com/Biogod2020/dsh-ssh/actions/runs/38877659704)。三个任务 `verify`、`publish`、`verify-installation` 全部成功；npm 与国内镜像 CDN 的 SHA-512 一致，两个 DSH 版本按包名安装验收通过。macOS 上也从官方源及镜像完成了隔离安装。

正常发版直接使用上述工作流，不再执行 `npm trust`、`npm stage publish` 或 `npm stage approve`，也不再要求维护者逐版完成 2FA。增改账号或信任关系仍遵循 npm 本身的身份验证要求。发布前更新 `package.json` 与 README 中的版本，提交后推送对应 `v<version>` 标签，并核对 verify、publish、verify-installation 的最终结果；手动运行分支只做验收。

旧的 .27 暂存版本保留，不再复用这个版本号。首次自动发行是 .28，SSH 实现与当时本机已验收的 .27 相同；本机 Desktop 的 .27 验收包并不表示已安装 .28。


## 上一发行状态（2026-10-21）

该次发行后，npm 与国内镜像的 latest 均为 `0.3.24-jay.34`。对应 [发行流水线](https://github.com/Biogod2020/dsh-ssh/actions/runs/39698581172) 的三个任务全部通过；完整测试为 69 个文件、619 项。最终归档在 DSH `0.2.0-rc.2`、`0.2.1-alpha.4` 和 `0.2.1-rc.2` 中通过安装验收，两个源按包名安装也通过。macOS 另外完成官方源 → 0.2.1-rc.2、镜像 → alpha.4 的隔离安装。

npm 可能在接受并签名后继续处理新版本，暂时不向公开索引提供该版本。镜像同步因此在官方归档可读且完整性正确后发起，元数据读取使用 `t` 与 `cache=0` 刷新参数；仍必须下载实际 CDN 文件并校验 SHA-512，不以同步成功回执替代文件核对。

日常发版继续推送匹配版本标签，由已有 OIDC 权限发布；不重复绑定信任关系，不执行 stage 审批，也不重新提交已经被 npm 接收的发行。

本次发行额外要求安装包通过真实 SSH 断线故障注入：失效转发只失败本连接，宿主与独立隧道仍正常，不建立新 SSH 或重放请求。

## 上一发行状态（2026-10-22，jay.35）

`0.3.24-jay.35` 已由 [匹配版本标签的流水线](https://github.com/Biogod2020/dsh-ssh/actions/runs/39747401517) 通过现有 OIDC 权限直接发布，verify、publish、verify-installation 全部成功，无逐版 2FA 或 stage 审批。npm 与国内镜像的 latest 均为该版本，并提供签名 provenance。

73 个测试文件、645 项测试，以及 typecheck、build 和产物检查通过。最终归档在 DSH `0.2.0-rc.2`、`0.2.1-alpha.4`、`0.2.1-rc.2` 中验收通过；官方源 → alpha.4、镜像 → 两个 rc.2 的按包名安装也通过，覆盖已有磁盘历史、选择清理和提醒。macOS 另完成官方源 → `0.2.1-rc.2` 的隔离安装。

发布包为 1,214,288 字节，SHA-256 `21befec6f1e0dd20cb4cf8b0eda5ba06c3e26aad7b544d52e14f11b2ff2b89d0`。官方源与实际镜像 CDN 文件的 SHA-512 均与 CI 测试归档一致；[GitHub Release](https://github.com/Biogod2020/dsh-ssh/releases/tag/v0.3.24-jay.35) 附带同一归档和 SHA-256 文件。本次发布未改动日常 Desktop 安装、配置或会话。

## 当前发行状态（2026-10-22，jay.37）

`0.3.24-jay.37` 的 [发行流水线](https://github.com/Biogod2020/dsh-ssh/actions/runs/39772494386) 三个任务全部成功：73 个文件、658 项测试、typecheck、build、产物检查、三个 DSH 版本的最终归档验收、真实 SSH 验收，以及官方源/国内镜像的实际文件完整性和按包名安装。现有 OIDC 权限直接发布，无 stage 审批或逐版 2FA。

两个源的 latest 均为 jay.37。公开包为 1,218,370 字节，SHA-256 `4b782e2d078d7461c7bdc301f7241d9343a024fc80aca9146d2d2979112bf788`；[GitHub Release](https://github.com/Biogod2020/dsh-ssh/releases/tag/v0.3.24-jay.37) 的归档、官方源及真实镜像 CDN 内容均与 CI 产物一致。macOS 另完成从 npm 按包名安装到 DSH 0.2.1-rc.2 的隔离验收。本机日常 Desktop 也已更新为正式 npm 版本，前后端与 CI 字节相同，其他插件、模型配置和会话保留。

npm 在签名接收后延迟公开新版本，期间其[官方状态页](https://status.npmjs.org/)报告 publish/install/view 性能异常。本次保留实际下载与安装检查，等待源可用后通过，没有重复发布同一版本或放宽验收。

## 2026-10-22 — jay.39 增量历史发行

[发行流水线](https://github.com/Biogod2020/dsh-ssh/actions/runs/39780902969) 的 verify、OIDC publish、verify-installation 全部通过。74 个文件、672 项测试、三个 DSH 版本的最终归档、编译后插件的真实 SSH 增量同步、断线注入及官方源/镜像源按包名安装均通过。官方源、实际镜像 CDN 与 GitHub Release 的文件均与 CI 归档一致：1,223,681 字节，SHA-256 `0aa53cabb1714fbdee68946efa7394b9efabc079c1017de07ce0a5646c26b1ec`。macOS 另完成官方源 → DSH 0.2.1-rc.2 的隔离安装并核对前后端字节。

jay.38 的首次 CI 因旧终端连续性测试的定时器竞态失败，未执行 npm 发布。保留该标签和失败日志，以新的不可变 jay.39 标签修正测试并完成所有门槛；没有移动旧标签、放宽断言或重放发布。

本机日常 Desktop 已通过 npm 官方源安装精确版本 `.39`，安装的前后端与 CI 归档字节一致。5,958 个原有数据/配置文件和其他插件保留；恢复原远端运行中会话并验证本地/远端切换，远端服务未重启。磁盘历史原有 1,431 条事件全部保留，并补齐 436 条新增事件。

## 开发候选的性能基线读取

新测量固定读取 jay.39 的不可变提交与 Git blob，通过 GitHub API 下载并校验对象哈希。读取有明确超时，不在性能步骤执行无期限的额外 Git fetch。原始测量 JSON 由工作流保存；失败或超时的任务不算全量验收通过。


## 2026-10-23 — jay.40 核心发行

[发行流水线 39948729558](https://github.com/Biogod2020/dsh-ssh/actions/runs/39948729558) 的 verify、OIDC publish 和 verify-installation 全部成功。完整 934 项、类型/构建/产物、三个运行时、磁盘历史补差/重启/回退及真实 SSH 断线通过；按本次核心交付范围，较慢压力专项留作手动按需运行。

[GitHub Release](https://github.com/Biogod2020/dsh-ssh/releases/tag/v0.3.24-jay.40)、npm 与实际国内镜像 CDN 均匹配 CI 文件：1,353,208 字节，SHA256 `e2e61a18de143ab26f0d52994084be1c83513e59ed5f02070a8360df67ac6cba`。macOS 另完成官方源按包名安装到 DSH 0.2.1-rc.2 的隔离验收。

本轮真实 `dsh web` 交互涵盖本地/远端草稿切换、消息/代码复制、置顶/重命名/归档/恢复、远端模型表单、重启后未连接 SSH 读取磁盘历史，以及新端口上的实际编辑器草稿恢复。没有操作 Desktop App、发起新模型请求或启用自动视图回收。[截图及准确安装包来源](benchmarks/2026-10-23/dshweb-core/README.md)。


## 2026-10-23 — jay.41 闲置视图与重复请求优化

[发行流程 39966172605](https://github.com/Biogod2020/dsh-ssh/actions/runs/39966172605) 的 verify、OIDC publish、verify-installation 全部成功，947 项、三个运行时归档验收、历史补差/重启/回退、SSH 断线及两个源按包名安装通过。npm 与实际镜像 CDN 文件一致：1,369,537 字节，SHA-256 `a4c11489e0f2abe31a532bf378c1c71a6599d843e6da694c6d495a24ee5c4ae1`。macOS 另完成 npm 按包名隔离安装。

本轮按要求在内置浏览器实际操作 `dsh web`，验证释放视图、草稿恢复、原终端保护、自动回收、即时重命名与重启后离线历史；没有操作 Desktop App。[真实截图、精确来源和 Gemini 复核决定](idle-views-and-requests-2026-10-23.md)。

本机日常 Desktop 已按包名安装 `.41`，前后端与 CI 归档字节一致；新备份及安装后哈希核对确认 4,580 个配置/数据文件、42 个应用数据文件与其他 3 个插件保留。没有操作或启动 Desktop App，实际界面验收使用内置浏览器中的 `dsh web`。
