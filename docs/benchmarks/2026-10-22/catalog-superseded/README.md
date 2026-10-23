# 目录变化与同步重叠的修复记录

本机 Node 24.16.0 / macOS。生成的私有 Home、密钥及消息，无真实模型请求。所有安装检查使用同一个归档，源码逐文件核对；原始失败 CI 记录未隐藏。

`runtime-*.json` 是三个实际 DSH 版本的大目录与实时归档/恢复检查，`downgrade.json` 是实际旧 `.39` 的离线导出读取，`provenance.json` 记录源文件比对和范围。`history-acceptance.json` 是完整的 0、3、30、300 秒控制器离线恢复；`soak-calibration.json` 是同一包的 30 秒校准，两者已通过。CI 状态另在[修复说明](../../../catalog-refresh-race-2026-10-22.md)中列明，未将未完成检查记作通过。

复现命令使用同仓库的 `scripts/catalog-runtime-smoke.mjs`、`scripts/history-downgrade-smoke.mjs` 和冻结的 `scripts/history-delta-smoke.mjs --outages --soak-seconds=30`。需要绝对的 CLI/归档路径和新的私有报告路径。30 秒只用于校准，不是 24 小时稳定性结果，也不是原生界面验收。
