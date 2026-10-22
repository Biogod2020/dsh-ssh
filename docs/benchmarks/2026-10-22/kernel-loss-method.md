# 200 ms / 2 Mbit/s / 1% 丢包验收

状态：测试夹具已实现，实际 CI 结果待核对。不能把已有用户态延迟/限速报告当作丢包结果。

`scripts/kernel-loss-history-benchmark.mjs` 只允许临时 GitHub-hosted Linux runner。它启动同一真实 SSH/DSH 基准，等候测试代理报告生成的监听端口，在首次 SSH 握手前只对这个 TCP 流设置内核 netem；其他 DSH HTTP、代理到 sshd 的链路与 runner 流量不进入这两条延迟队列。脚本拒绝替换已有 loopback qdisc，自建规则在结束时移除并核对恢复。

两个方向分别设置 100 ms 延迟、2 Mbit/s 和独立随机 1% 丢包。Loopback 的大 MSS 由仅匹配该端口的 SYN 规则限制到 1460 字节，测试期间关闭并恢复 loopback TSO/GSO/GRO，避免把大块聚合 skb 当成普通 WAN 包。记录实际队列统计，两个方向必须有包，必须观察到实际内核丢弃；配置 1% 不代表有限样本中恰好丢弃 1%。SSH 通过 TCP 重传恢复字节，不在 JavaScript 里删除或破坏 SSH 流。

关闭卸载是此独占临时 runner 的整个 loopback 接口条件，也会改变其他夹具流的分段与 CPU 工作量；其他流没有被注入延迟、限速或丢包，不表示其性能完全不受影响。基线与候选采用相同条件，结果仍需与普通网络报告分开解释。夹具显式绑定 `127.0.0.1`，不使用可能解析到 IPv6 的 `localhost`。

每个冻结基线/候选各跑 100 次本机读窗、100 次无变化校验、30 次单条新增和 30 次承载恢复。新增事件在测量前各写一次，不因错误重发。沿用原有超时、信任检查和旧段不重写断言。正常网络的五秒后台恢复门槛仍用于 RTT ≤80 ms；本组较差网络报告实际 p50/p95 和失败，不声称使用相同恢复时限。

应用字节计数仍是 TCP socket 交付的 SSH 密文载荷，排除 IP/TCP 头部和内核重传；netem 包/丢弃数另列，不与应用字节混为物理线速。它仍是同一内核的 loopback TCP，受 TCP Small Queues 和内核调度影响，不能等同物理 WAN 或原生界面点击延迟。

方法依据：[netem 的损失模型、限速与 TCP Small Queues 限制](https://man7.org/linux/man-pages/man8/tc-netem.8.html)、[PRIO 分类与默认映射](https://man7.org/linux/man-pages/man8/tc-prio.8.html)、[Linux 分段与接收卸载](https://www.kernel.org/doc/html/latest/networking/segmentation-offloads.html)。结果由 `kernel-loss-history-measurements` CI artifact 保存，核对后再归档。
