# 远端文字草稿：落盘与原生接入

状态：实施中，未发布或替换日常安装。

原生隔离夹具已复现：两条远端会话往返切换保留不同草稿；退出再打开应用后，网关从 `127.0.0.1:55095` 变成 `127.0.0.1:62580`，原 `Remote third fixture` 的未发送测试文字没有恢复。原生编辑器按浏览器来源保存草稿，来源变化需要独立的本机副本。

## 已写出的候选

- `LocalDraftStore` 按 Host + Session 单独保存文字，目录 0700、文件 0600，原子替换和目录 fsync。空草稿保留 revision，旧请求不能绕过用户清空；操作身份用于确认丢失回执，保存不是执行队列。
- 单写入租约与每次读取文件后的 revision 比较。活跃写入者不被接管；确认退出的 PID 可在恢复 guard 内接管。恢复 guard 自身中断时保留只读并要求核查，不承诺所有故障点都能自动解锁。
- 网关的 `GET/PUT /__dsh_remote/draft?sessionId=...` 仅在已认证、同源会话中使用，Host 由网关固定，忽略请求伪造的 Host。不会转发到远端。读取可在 SSH 断开时完成；写冲突 409，未确认写入 507。
- 首次 HTML 在原生编辑器启动前注入该会话保存的文字，只触及已核对的 `dsh.conversation.<sessionId>` 格式；已有浏览器草稿不被覆盖。JSON 脚本转义、归属核对和并发根页请求已有检查。
- `createDraftReplica` 管理读取、350 ms 合并保存、revision、失去回执后只读核查和冲突。旧读取不能覆盖期间新输入，发送模型/命令不在它的 API 内。它已接到原生 `conversation.input.dock` 的候选模块；真实桌面重启验收仍待 Mac 解锁。

9 项存储、3 项网关、3 项启动注入、10 项副本状态与 4 项输入槽检查通过。当前完整集合 85 个文件 / 758 项通过，typecheck、build 和产物检查通过；这些结果不替代实际桌面验收。

## 已接入的候选

1. 独立、页面拥有的 Client 模块注册 `conversation.input.dock`。通过公开的 `conversation.input.for(sessions.scope(sessionId))` 获取该会话的 Input face，只订阅 `state` 和调用 `setDraft`。直接订阅并在释放前重读最新快照，避免 React 尚未渲染的发送/清空动作被保存成旧文字。不访问私有 InputHub，不扫描 cookies、认证或模型设置。模块由本机网关注入，不安装到远端、不重启远端 DSH。
2. 模块工厂通过公开 loader 的 `require('react')` 使用 React。网关序列化时把经过测试的 `createDraftReplica`、`seedDraft` 作为函数参数传入，避免 `toString()` 留下构建器改名的外部闭包引用。新 `/__dsh_remote/draft-client.js`、manifest entry 与 batch 仅在已认证的嵌入视图中提供。
3. 已保存、待保存、保存失败和两份草稿冲突各自显示状态。冲突时展示本机已保存文字供复制，只有用户明确选择“用当前输入替换已保存草稿”才覆盖旧 revision。当前页面文字在覆盖确认前不被宣传为已落盘。引用/附件的浏览器对象不能恢复，提醒重新选择；用户处理前提醒继续保留。
4. 同主机切换、跨主机、切本机、显式关闭和视图回收前等待合并保存。保存失败保留视图和输入，不把未确认内容当作已保存，不自动重发写请求。再次打开当前会话可返回处理问题。新的导航意图仅取消旧的本机读取/观察，不取消远端任务，不重放模型或工具动作。迟到结果不能改变后续选中目标；卸载后的侧栏回调不能打开旧目标。
5. 网关来源变化后首次会话由 HTML seed 恢复。后续冷会话在导航前读取本机草稿并 seed 对应键；只保留最近四条启动 seed 的内存副本，磁盘草稿不设期限。已有浏览器键包括空文字均不隐式覆盖。异步导航桥由 Desktop 真正等待，避免 `Boolean(Promise)` 把拒绝的导航误判为成功。

## 尚需真实桌面验收

后台真实 Web 客户端现已通过保存后换端口恢复、空草稿不复活、两会话独立、不同逻辑 Host 下同 Session id 隔离。已实际操作官方编辑器并核对磁盘，见[截图与范围](web-draft-and-downgrade-acceptance-2026-10-22.md)。它补足真实浏览器输入槽证据，以下桌面嵌入、菜单及退出流程仍需原生验收。

- 实际原生输入槽与公开 DI 是否按已核对的版本契约工作；确认保存后退出重启、端口变化后恢复文字；清空后再重启不得复活。
- 两个主机同 Session id、两条真实 UI 生成草稿、快速切换与晚回包、保存失败时离开被阻止。本机设置和正式会话均不得改变。
- guest 显示时菜单的鼠标/自动化命中不稳定另行保留，不能因单元测试通过就称原生全部通过。
- 应用强退或断电前尚未确认的末尾输入不保证落盘。正式安装更新前仍需保护旧浏览器中的未发送草稿；候选模块开始工作前的内容不能假设已经存在新存储中。

## 已验证的版本依据

官方 `@deepseek-ai/dsh-client-ui-conversation@0.2.1-rc.2` tarball 的公开 InputActions 包含 `setDraft(string)`、`persistDraft()`；InputState 包含 draft、draftRev、phase、occurrences 和 attachmentIds。真实 Desktop 包内声明 `conversation.input.dock` 为 Session scope；ConversationController 的公开 `input.for` 返回对应作用域的 SessionInput，其 `state` 提供 getSnapshot/subscribe。纯文字导入会移除引用 chip，因此恢复提醒必须明确。

Gemini 已实际审阅独立存储。未采纳将接管改成无条件 rename 的建议，它可能覆盖竞争胜出的活跃 owner；三方竞争回归验证仅一方成功。未采纳“POSIX 只读目录不能 fsync”和“operationId 相同的只读返回会覆写清空”两项不成立的推断，分别保留实际平台检查与精确旧操作重发回归。guard 中断需核查属于明确限制，已单独验证可读副本保留。

Gemini 已实际审核中英文提示。采用冲突提示明确替换方向、先复制所需旧文字的建议；未采用“最新修改未保存”的确定性说法，丢失回执也可能发生在落盘之后，因此显示“无法确认最新修改已保存到本机”。附件确认不要求用户虚称已经重新选择：用户也可以决定不再使用原附件。

真实安装归档的后台验收通过：[原始结果](benchmarks/2026-10-22/draft-controller-restart-macos.json)。由实际网关返回的序列化 Client 在隔离 JS 上下文注册成功；控制器分别停止 0、3、30、300 秒并重启后，新网关来源读回相同文字与 revision，HTML 在原生编辑器启动前包含该文字；清空后迟到旧写入返回 409，原远端 PID 不变。未调用模型。该检查明确标记 `nativeEditorVerified: false`，不将模块注册和 HTML 种子当作真实输入槽已通过。

另补真实 SIGKILL 验收：子进程完成草稿写入并发出确认后被强制终止；新存储读回相同文字与 revision，确认旧持有者已退出后接管写入，迟到旧 revision 仍被拒绝。该专项随后进入完整集合，本地重新执行 85 文件 / 758 项全部通过；Linux `cfe7cc7` 的完整 CI 仍对应新增该用例前的 757 项。
