# 项目目录订阅的安装验收记录

本机 macOS / Node 24.16.0；真实 loopback SSH，生成的私有 Home、密钥、目录和会话元数据，无模型请求。三个运行时使用同一候选归档，源码与打包来源逐文件比对。尚未发行或替换日常安装。

- `runtime-rc20.json`、`runtime-alpha4.json`、`runtime-rc21.json`：实际 SDK 的大目录读取、101 次列表读取共用一个项目订阅、远端直连归档/恢复推送、请求 43 秒静默等待的实际 monotonic/wall 时间、原 PID 与夹具脚本哈希。
- `downgrade.json`：同一包的实际离线导出及已发布旧 `.39` 消费者读取。
- `provenance.json`：归档哈希、源文件逐字节比对、平台与验证范围。

`liveFeedWait*` 是测试观察等待时间，不是连接或切换耗时。目录行数与响应大小是实际 SDK 输出；不同版本格式不同，因此没有假定同样生成行数必然达到同样字节阈值。这里不比较公网延迟或原生渲染性能。

复现时使用支持版本的绝对 CLI 路径、已打包归档和新的私有报告路径：

```sh
node --experimental-transform-types scripts/catalog-runtime-smoke.mjs ABSOLUTE_DSH ABSOLUTE_ARCHIVE NEW_PRIVATE_REPORT
node --experimental-transform-types scripts/history-downgrade-smoke.mjs ABSOLUTE_ARCHIVE NEW_REPORT ABSOLUTE_DSH ABSOLUTE_FROZEN_JAY39_ARCHIVE
```

夹具要求本机可运行 `sshd`，安装只发生在一次性 Home。它只使用公开 Session/Title/Workspace API，不执行 Agent。测试服务、已确认身份的远端进程及生成的 SSH 服务会在结束时清理；失败不记作通过。原生桌面与长期稳定性另行验收。
