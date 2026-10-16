# 0.3.24-jay.25 验收范围

验收日期：2026-10-15（America/Los_Angeles）。

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
