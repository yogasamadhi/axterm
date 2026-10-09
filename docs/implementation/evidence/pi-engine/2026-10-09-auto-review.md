# 工作模式命令自动审核与连续执行

ADR-030 的 Runtime 适配已实现；本记录不关闭 Feature/Phase、三平台或正式发行验收。
保留开始实施前的 ownership journal、STATUS 和来源台账未提交修改。

## 实现范围

工作模式的聊天/诊断使用 Pi 原生 `runAgentLoop`，每轮一个 `workspace_exec`，
只回调 Runtime Application Service。严格观察白名单直接通过；其他操作使用当前
模型的独立无工具请求审核，明确授权的有限可逆修改可自动执行。危险、敏感或
不可可靠解释的操作等待原人工审批；明确安全拒绝终止任务，不能改写后继续尝试。
聊天、解释、生成命令和 MCP 保留原权限范围。

固定复制 pi-auto-review 0.26.0 的三个纯模块和 MIT 许可，提交为
`6eb4d9668f6d23fb6793029d5d145b8ae0fcd0ad`。来源清单绑定 SHA-256，
仅由私有 Pi 引擎编译；Pi 1.0.3、SDK、Bun 锁和插件架构均未升级。
许可证、通知、组件/许可清单和 SPDX 已同步；人工来源/语言签收保持 pending。

每任务 50 条尝试、30 分钟实际运行；人工等待暂停计时，人工批准 10 分钟，
自动批准 60 秒且仅消费一次。最多 4 个工作任务、同一终端一个。单命令仍为
30 秒/128 KiB，模型结果 16 KiB；审核估算输入 8,192 tokens、输出 1,024 tokens，
最多 30 秒且零重试。审核异常和完整证据超预算转人工，不截断命令后自动批准。
根取消信号覆盖凭据、审核、模型和执行请求；等待器、预算和目标监测器有确定性清理。

SQLite migration 42 保存审核、步骤与实际批准来源。决定绑定目录、终端/连接、
Runtime generation、策略与有效期。SSH 另外记录实际 hostname/port/username 和
连接执行代次；同一连接 ID 重连也使原决定失效。ToolCall SSE 经 Contract 校验，
用量标明 execution/review，卡片显示理由和自动批准，安全命令没有确认按钮。
审批接口等待当前命令完成，不提前结束整个 Pi 任务；重启不恢复执行或重放批准。

## 验证记录

- 集中 AI/Pi/审核/预算/迁移/真实 SSH 回归 81 项通过；连同 SSH 同 ID 代次用例共新增 45 项，含三条安全命令、
  授权修改、危险等待/批准/继续、有效安全拒绝、非零退出诊断、51 次拒绝、
  4 任务容量、取消审核/执行/凭据请求、审批过期、目标关闭和旧 generation 拒绝。
- SSH 真实协议/进程夹具：Windows 使用显式 `AXTERM_TEST_POSIX_SHELL=C:\Program Files\Git\bin\sh.exe`，
  SSH server 通过真实 Git POSIX shell 执行远端目录中的命令；真实 host-key 确认、
  三个观察命令和普通写入自动执行，删除等待审批并继续到最终回复，未写入本地元数据目录。
  这不是 Windows OpenSSH 服务或 Linux/Mac 原生发行验收。
- SQLite v41 升级：旧调用的风险/hash/参数保留，不生成虚假的 review/step/approvalSource。
- Level 1 架构：424 modules / 1,504 dependencies；Contract：264 operations。
  Pi/审核来源哈希、许可/组件/SPDX、本地化、源码卫生和构建检查通过。
- Electron source 与隔离 Windows 目录包：连续四步自动执行，删除只有一个单次确认，
  批准后第五步和最终回复完成；独立 user-data、cwd 和目录快照、无确认按钮的安全卡片、
  Vault canary 脱敏、落库批准来源均核对。包测试 PATH 仅含 System32，不依赖系统 Pi CLI。

全量门禁的已有 Windows 失败、最终计数和包身份在 STATUS 中记录。
最终 `bun run check` 返回 1：279 文件中 254 通过、13 失败、12 条件跳过；
1,392 tests 通过、30 失败、71 跳过。新增流程没有失败，保留已有 Windows 门禁问题。
桌面及最终目录包 2/2 通过（17.1s）；最终 `app.asar` SHA-256 为
`1c4e384db0eb4bca6777848365524149c8282a138d37a2230ef1a31b65868841`。
日志保留在忽略目录 `out/auto-review-check-completed.log`，
UI 流程在 `tests/e2e/ai-auto-review.spec.ts`，真实 SSH 在
`tests/integration/ai-auto-review-ssh.test.ts`。生成的 OpenAPI 保留为
`out/auto-review-openapi.json`，避免把生成物带入独立源码快照。

## 尚未完成的验收

2026-10-09 自动审核策略 v2 补修：有限 PowerShell 语法在实际 CMD 下允许可验证
的查询与普通相对单文件字面写入进入自动决策；保留编码、动态/复合载荷、设备名、
敏感/越界路径的人工风险底线。写入至少 medium 且需真实用户授权，完整原命令
仍进入独立审核；字面源文件内容不会被误当作执行指令。Runtime 的 CMD 外层引号
与 verbatim argv 已按真实进程验证，审核事实同步。预算使用固定 Pi 估算与保守
UTF-8 上界，避免把 token 误算成字节，但不截断输入后自动批准。
新增 12 项回归，审核/上下文/Pi 三文件 58 项通过；实际 Windows PowerShell 进程
查询、写文件、后续查询三步均自动执行且文件落盘。Electron source 两项流程
2/2 通过（38.9s），自动步骤包含 PowerShell，删除才人工确认；固定 Pi 未升级。
新目录包两项流程 2/2 通过（7.8s），PATH 仅 Windows System32 和内置
WindowsPowerShell；新包/未签名安装程序为 `release/auto-review-v2-20261009/`。
包级 SPDX 和安装包 hash manifest 校验通过，包身份记录在 STATUS。
最终 v2 `bun run check`：lint/typecheck 通过；253 文件、1,403 tests 通过，
13 文件、30 tests 失败，13 文件、72 tests 跳过。失败仍为现有 Windows 问题；
日志为 `out/auto-review-v2-check.log`，不标记全量或未运行平台验收通过。

2026-10-09 审批交互补修：等待审批通过 Portal 展示命令确认弹窗，直接显示完整
命令、绑定的本地/SSH 目标、目录快照、风险理由及到期时间；底部保留拒绝与单次
运行按钮。关闭弹窗只隐藏提示，不批准或拒绝，固定提醒可再次打开；等待审批的
工具卡片不能折叠。复用已有 Modal 的焦点约束与恢复，默认焦点放在拒绝按钮，
异步决定期间禁用按钮且通过同步锁防重复提交；错误留在弹窗内。状态 SSE 同步
刷新审批与调用，避免仅等待轮询。Runtime 决定接口、权限、目标绑定均未改变。
Electron source 两项流程通过：四步自动执行期间无弹窗，危险步骤弹窗立即可见；
核对命令/目录、Escape 后提醒、卡片强制展开、再打开与 Tab 操作，分别批准后继续
并完成任务、拒绝后停止且保留文件。截图为 `out/ai-approval-desktop-*.png`。
既有 `ai-workspace.spec.ts` 单项复跑在审批之前的标签单行布局断言失败（`[1,3,1]`
而非 `[1,1]`），未删断言；不能把该旧流程记为通过。
新 Windows 目录包两项相同流程 2/2 通过（8.1s），包及未签名 NSIS 位于
`release/approval-ui-20261009/`；包测试以隔离目录与仅 System32 PATH 运行。
`app.asar` SHA-256 为 `2ca30bdb55ea43dcf4d27f06f10f90c4b4d17816cd65887334bda45f914c1971`；
安装程序 SHA-256 为 `b573130fa56e3bde74bf367d2a0fa40cc2e2dc7a9d2dbbac0c487c5568ab2546`。
包级 SPDX、安装包 hash manifest 校验通过；NSIS 安装/升级本轮未测试。
补修后 `bun run check` 返回 1：lint/typecheck 通过；253 文件、1,391 tests 通过，
13 文件、30 tests 失败，13 文件、72 tests 跳过；现有 Windows 问题保留，
日志为 `out/ai-approval-ui-check.log`。

已有 Windows 全量门禁仍失败：symlink EPERM、POSIX 命令/Unix socket、路径与
文件权限断言、ownership 容量超时等；不能标记全量检查通过。不删测试，不放松架构门禁。
Mac/Linux 本轮未运行；未进行 NSIS 安装/升级、签名、公证、公开发布或正式签收。
