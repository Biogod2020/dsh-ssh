# 视图采样基础的验证记录

三个 `runtime-*.json` 来自实际 DSH 安装与生成的 loopback SSH：读取编译后的导航贡献脚本，在**模拟 Client 服务和合成堆数值**下核对输出；序列化的草稿 Replica 也在模拟 Hooks 中实际初始化并消费种子。真实 React 挂载/卸载另由单测覆盖。`serializedInspectionInMockClient`、`mockHeapValueNotActualMeasurement` 明确标记此范围。它不能证明真实浏览器内存、原生视图或安全自动释放。

`downgrade.json` 验证实际旧 `.39` 读取 603 条导出事件；`provenance.json` 记录归档、源文件比对、检查数量和未实现项。没有用户会话正文或模型请求。

复现：`scripts/catalog-runtime-smoke.mjs` 调用 `scripts/verify-view-inspection.mjs`，使用绝对 CLI、归档和新的私有报告路径。三个受审 DSH 版本分别执行。React 生命周期覆盖位于 `tests/draft-client-lifecycle.test.tsx`；整体范围见[说明](../../../view-inspection-2026-10-22.md)。
