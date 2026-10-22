# npm 自动发布配置

工作流为 `.github/workflows/publish.yml`。普通分支手动运行只做验收；推送与 package.json 版本完全一致的 `v<version>` 标签才会发布。

流程先运行 typecheck、完整测试、构建、归档检查，以及 DSH alpha.4 / rc.2 的隔离安装。发布任务下载同一次构建的归档，校验 SHA-256 后使用 npm OIDC 发布，不重新打包，也不保存 npm 写入 Token。

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

正常发版直接使用上述工作流，不再执行 `npm trust`、`npm stage publish` 或 `npm stage approve`，也不再要求维护者逐版完成 2FA。增改账号或信任关系仍遵循 npm 本身的身份验证要求。发布前更新 `package.json` 与 README 中的版本，提交后推送对应 `v<version>` 标签，并核对三个任务的最终结果；手动运行 main 分支只做验收。

旧的 .27 暂存版本保留，不再复用这个版本号。首次自动发行是 .28，SSH 实现与当时本机已验收的 .27 相同；本机 Desktop 的 .27 验收包并不表示已安装 .28。


## 上一发行状态（2026-10-21）

该次发行后，npm 与国内镜像的 latest 均为 `0.3.24-jay.34`。对应 [发行流水线](https://github.com/Biogod2020/dsh-ssh/actions/runs/39698581172) 的三个任务全部通过；完整测试为 69 个文件、619 项。最终归档在 DSH `0.2.0-rc.2`、`0.2.1-alpha.4` 和 `0.2.1-rc.2` 中通过安装验收，两个源按包名安装也通过。macOS 另外完成官方源 → 0.2.1-rc.2、镜像 → alpha.4 的隔离安装。

npm 可能在接受并签名后继续处理新版本，暂时不向公开索引提供该版本。镜像同步因此在官方归档可读且完整性正确后发起，元数据读取使用 `t` 与 `cache=0` 刷新参数；仍必须下载实际 CDN 文件并校验 SHA-512，不以同步成功回执替代文件核对。

日常发版继续推送匹配版本标签，由已有 OIDC 权限发布；不重复绑定信任关系，不执行 stage 审批，也不重新提交已经被 npm 接收的发行。

本次发行额外要求安装包通过真实 SSH 断线故障注入：失效转发只失败本连接，宿主与独立隧道仍正常，不建立新 SSH 或重放请求。

## 当前发行状态（2026-10-22）

`0.3.24-jay.35` 已由 [匹配版本标签的流水线](https://github.com/Biogod2020/dsh-ssh/actions/runs/39747401517) 通过现有 OIDC 权限直接发布，verify、publish、verify-installation 全部成功，无逐版 2FA 或 stage 审批。npm 与国内镜像的 latest 均为该版本，并提供签名 provenance。

73 个测试文件、645 项测试，以及 typecheck、build 和产物检查通过。最终归档在 DSH `0.2.0-rc.2`、`0.2.1-alpha.4`、`0.2.1-rc.2` 中验收通过；官方源 → alpha.4、镜像 → 两个 rc.2 的按包名安装也通过，覆盖已有磁盘历史、选择清理和提醒。macOS 另完成官方源 → `0.2.1-rc.2` 的隔离安装。

发布包为 1,214,288 字节，SHA-256 `21befec6f1e0dd20cb4cf8b0eda5ba06c3e26aad7b544d52e14f11b2ff2b89d0`。官方源与实际镜像 CDN 文件的 SHA-512 均与 CI 测试归档一致；[GitHub Release](https://github.com/Biogod2020/dsh-ssh/releases/tag/v0.3.24-jay.35) 附带同一归档和 SHA-256 文件。本次发布未改动日常 Desktop 安装、配置或会话。
