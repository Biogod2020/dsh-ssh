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
