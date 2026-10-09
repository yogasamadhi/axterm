# Axterm 本地优化目标执行计划

Updated: 2026-10-03
Status: `completed`；OP-01～OP-09 本地验收、新候选安装/功能/性能/OpenSSH/清理及最终完整门禁全部通过。
Scope: 不要求所有者填写 Token、API Key、Apple ID 或真实服务器凭据的本地工程优化。

本计划承接所有者要求的当前项目分析、同类产品与 GitHub 项目调研，以及无需手动提供
凭据即可开展的优化工作。它是新领取的本地优化路线；2026-09-26 商业脱钩三项完成线
及其证据继续有效。正式商业发行仍按 [ADR-022](../adr/ADR-022-commercial-release-mac-acceptance.md)
和 [最小商业发行清单](MINIMUM_COMMERCIAL_RELEASE.md) 另行领取。

当前操作与恢复见 [LOCAL_OPTIMIZATION_USAGE](LOCAL_OPTIMIZATION_USAGE.md)，构建与独立安装要求见 [PACKAGING](PACKAGING.md)。

## 1. 目标与边界

目标：在保留 Level 1 架构、安全边界及现有工作流的前提下，完成九个工作包，交付
可用的命令面板、稳定的终端消费链路、具有真实字节证据的 SFTP 操作、清晰的设置与
AI 上下文交互，以及由同一源码生成并验证的未签名 macOS 本地候选。

必须先完整阅读 [MASTER_SPEC](../architecture/MASTER_SPEC.md)、[STATUS](STATUS.md)、
[ADR-016](../adr/ADR-016-independent-open-source-product.md)、
[ADR-022](../adr/ADR-022-commercial-release-mac-acceptance.md)、
[商业化清理计划](COMMERCIALIZATION_CLEANUP_PLAN.md) 和最小商业发行清单；数据目录遵循
[ADR-023](../adr/ADR-023-clean-local-source-root-and-data-profile.md)。历史能力只按对应
Roadmap/Matrix 行查证，不重新领取旧 parity 队列。

本轮执行约束：

- Core Runtime 继续由独立 `utilityProcess` 承载，并保留独立 Node Headless 入口；
  不引入 Plugin Kernel、Extension Host 或 Electron Business IPC。
- Renderer 通过 Contract/Client 使用 REST、fetch-based SSE 和 Binary WS；不导入
  Node、Electron、SQLite、Drizzle、SSH/PTY 实现或 Model Provider SDK。
- Runtime generation、鉴权、Host Key 确认、File Grant 和 application-local Host
  Credential Vault 边界保持有效。测试凭据由夹具生成，不能写入产品配置、日志或证据。
- Terminal bytes 不进入 React/Zustand；大文件使用 streaming；所有资源有明确上限与
  cleanup。任何架构级变化先写 ADR，再实现 Contract、Application interface 和 Adapter。
- AI 继续使用 bounded + redacted context；生成命令默认不执行；审批绑定目标、参数、
  精确摘要和有效期，取消、重启或参数变化不能复用旧审批。不持久化隐藏推理。
- 保留工作树中已有修改及其行为，不重置、覆盖或以替换测试来获得通过。来源台账可以
  按文件摘要重新生成，但不得填写没有可归属人工证据的权利或审查签收。
- 未经另行领取，不发布网站、公开制品、远程仓库或更新源，不配置真实账号；不探测或
  使用系统 Keychain、Credential Manager、Keyring、Secret Service 或 `safeStorage`。

## 2. 已核实的起点

以下是 2026-10-03 对当前工作树的分析基线，不代表九个工作包已经完成：

| 项目            | 已核实事实                                                                                                   | 对计划的影响                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| 源码            | `main`，HEAD `483c38d`，版本 `0.10.0`；无 Git remote；分析起点已有 12 个修改文件                             | HEAD 不能单独标识当前产品源码，执行前记录 dirty diff 摘要           |
| 总检查          | `AXTERM_E2E_HIDDEN_WINDOW=1 bun run check` 返回 1                                                            | OP-01 首先恢复完整门禁，后续不得沿用旧的全绿结论                    |
| 单元/集成       | 244 个文件通过、5 个跳过；1,221 项测试通过、38 项跳过                                                        | 保留有效测试；跳过项逐项解释，不计入通过数                          |
| 架构与 Contract | 363 个模块、1,295 条依赖通过 Level 1 / Zero Business IPC；260 个 operation 无漂移                            | 所有新增能力继续走现有业务边界                                      |
| 视觉/无障碍     | 20 通过、1 失败；日文设置页 1280×800 差异 10,373 像素，比例约 0.02，超过 0.01；定向复跑同样失败              | 修复实际布局或证明自有设计变更，不能直接刷新快照或调宽阈值          |
| 标签交互        | 关闭与新增按钮位置的定向桌面测试通过                                                                         | 后续布局调整保留 tablist 外的关闭按钮、悬停锚定和固定标签语义       |
| SFTP            | 下载写入已授权本地目录的 Runtime 回归存在；新增远端下载/多选 OpenSSH 旅程未运行；Widget 旅程的远端列表未加载 | 补齐真实远端列表和双向字节证据，不能用连接成功代替下载成功          |
| Docker          | CLI 已安装；本机 Docker daemon 在分析时未运行                                                                | 本地 SSH/SFTP server 可先承担真实协议测试，OpenSSH 旅程另记 pending |
| AI              | 已有 loopback HTTP Provider/流式响应夹具                                                                     | 可验证三类协议、审批、取消及恢复；不能宣称真实云模型质量已验证      |
| 打包            | 既有未签名 Mac 工程证据属于此前源码候选                                                                      | 优化后的候选必须重新构建、留摘要并验证，不能复用旧包作为新功能证据  |

分析时的临时日志为 `/tmp/axterm-analysis-check-20261003.log`、
`/tmp/axterm-analysis-language-e2e-20261003.log` 和
`/tmp/axterm-analysis-tab-e2e-20261003.log`。它们不是可长期依赖的发行证据。
执行 OP-01 时应将必要的摘要保存到本轮证据目录，并记录生成时间、OS/架构、源码
状态、命令和退出码。截图与 trace 保存在源码目录外的本轮制品目录，文档记录位置和
摘要；不得把 trace.zip、视频或其他被 snapshot gate 排除的测试制品加入公开源码。
Playwright 下一次运行可能覆盖 `test-results/`。

文档交付后的完整复核日志为 `/tmp/axterm-plan-check-20261003.log`：同样 1,221 项
单元/集成通过、38 项跳过，视觉/无障碍为 19 通过、2 失败。除上述日文差异，还出现
`visual.spec.ts:797` 设置重试后的 checkbox 状态断言失败；该用例单独复跑 1 项通过
（`/tmp/axterm-plan-recovery-e2e-20261003.log`），但完整门禁没有恢复，不能仅凭定向
通过认定原因或关闭问题。OP-01 应检查其完整套件执行与重试状态语义。失败截图和
trace 已保存在 `/tmp/axterm-plan-check-evidence-20261003-4livlzj7/`，均为本机临时证据。

## 3. 外部调研与可借鉴点

调研日期为 2026-10-03。以下参考产品流程和公开文档/源码，不构成安装后的性能对比；
不以 Star 数、市场宣传、仓库公开可见或根许可证代替具体文件的可复用许可结论。

| 产品或项目与一手来源                                                                                                                                         | 可借鉴方向                                                  | 在 Axterm 的落点与限制                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Termius](https://termius.com/)                                                                                                                              | 保存连接、会话入口、SFTP 与常用命令之间的连贯流程           | 改进入口与任务完成路径；商业产品只参考体验                                    |
| [MobaXterm 文档](https://mobaxterm.mobatek.net/documentation.html)                                                                                           | SSH 与文件浏览结合、拖放、分屏、多会话操作                  | 优化已有能力的衔接与反馈，不扩张本轮协议范围                                  |
| [WindTerm](https://github.com/kingToolbox/WindTerm)                                                                                                          | 会话组织、终端和文件侧栏、多协议展示                        | 参考 README 与公开流程，不假定可获得或可复用完整源码                          |
| [Tabby](https://github.com/Eugeny/tabby)、[Profile service](https://github.com/Eugeny/tabby/blob/master/tabby-core/src/services/profiles.service.ts)         | Profile 默认值分层、功能模块组织                            | 整理连接/设置模型；不迁入其 Renderer 原生访问方式或插件架构                   |
| [Wave Terminal](https://github.com/wavetermdev/waveterm)、[terminal view](https://github.com/wavetermdev/waveterm/blob/main/frontend/app/view/term/term.tsx) | 终端、编辑、预览与 AI 的上下文入口；View/Model/Wrapper 分工 | 静态 feature 模块与明确上下文；不引入远端 helper 或新 RPC                     |
| [Windows Terminal](https://github.com/microsoft/terminal)、[Command palette](https://learn.microsoft.com/en-us/windows/terminal/command-palette)             | 命令搜索、分组与上下文动作                                  | OP-02 统一静态 action registry、键盘选择及实际执行路径                        |
| [WezTerm Workspaces](https://wezterm.org/recipes/workspaces.html)、[multiplexing](https://github.com/wezterm/wezterm/blob/main/docs/multiplexing.md)         | 命名工作区、布局与会话切换                                  | 在命令面板提供现有工作区切换；布局恢复不等于远端进程持久存活                  |
| [Ghostty](https://github.com/ghostty-org/ghostty)                                                                                                            | 终端兼容性和输入/输出/渲染边界的重视                        | 增加实测与兼容回归；继续使用 xterm.js，不重写终端引擎                         |
| [xterm.js flow control](https://xtermjs.org/docs/guides/flowcontrol/)                                                                                        | 使用 write callback 观察消费进度，约束生产速度              | OP-03 实测 Renderer 消费队列，再决定是否补充协议级消费反馈                    |
| [ttyd terminal 实现](https://github.com/tsl0922/ttyd/blob/main/html/src/components/terminal/xterm/index.ts)                                                  | 消费回调与高低水位协作                                      | 参考背压思路，沿用 Axterm 的 Binary data + Zod control 协议；不复制其鉴权路径 |
| [WinSCP 同步文档](https://winscp.net/eng/docs/task_synchronize_full)、[许可](https://winscp.net/eng/docs/license)                                            | 目标路径、冲突决策、差异预览                                | 本轮做传输反馈与恢复；完整目录同步单独立项，GPL 代码/资产不直接引入           |
| [Nexterm](https://github.com/gnmyt/Nexterm)                                                                                                                  | 连接与管理界面组织                                          | 参考信息组织；服务器多租户、组织 SSO 与 Engine 部署不进入本地桌面目标         |

借鉴默认采取独立实现。确需引入源码或资产时，先固定来源提交、检查具体文件许可并
补齐 NOTICE、来源和打包清单；不能仅凭本表判断授权。

## 4. 工作包与执行顺序

推荐顺序：`OP-01 → OP-04 → OP-02 → OP-03 → OP-05 → OP-06 → OP-07 → OP-08 → OP-09`。
每次先领取一个工作包，完成最小完整修改、相关测试及证据，再更新状态。不得仅为
降低行数重写整个应用，也不得在修复前扩大功能范围。

| 工作包                    | 优先级 | 依赖                       | 交付物                                   | 状态      |
| ------------------------- | ------ | -------------------------- | ---------------------------------------- | --------- |
| OP-01 恢复检查与冻结基线  | P0     | 无                         | 视觉修复、可追溯基线与检查结果           | completed |
| OP-04 SFTP 闭环与恢复语义 | P0     | OP-01                      | 双向真实传输、失败反馈、明确重试能力     | completed |
| OP-02 命令面板            | P1     | OP-01                      | 搜索即到达实际动作、完整键盘交互         | completed |
| OP-03 终端消费与性能      | P1     | OP-01                      | Electron 实测、有限消费链路和 cleanup    | completed |
| OP-05 设置与视觉一致性    | P1     | OP-01、OP-02、OP-04        | 常用设置清晰、诊断独立、四语言可用       | completed |
| OP-06 静态 feature 整理   | P2     | OP-02、OP-03、OP-04、OP-05 | 本轮相关功能的组件/模型/交互职责拆分     | completed |
| OP-07 AI 上下文与审批体验 | P2     | OP-01、OP-06               | 上下文预览、生成/插入/审批流程与夹具回归 | completed |
| OP-08 文档与现状收口      | P2     | OP-01～OP-07               | 当前入口、预算、证据与历史状态一致       | completed |
| OP-09 未签名 Mac 候选验收 | P2     | OP-01～OP-08               | 独立输出目录制品、安装旅程与摘要         | completed |

执行证据：[OP-01](evidence/local-optimization/OP-01-2026-10-03.md)、
[OP-02](evidence/local-optimization/OP-02-2026-10-03.md)、
[OP-03](evidence/local-optimization/OP-03-2026-10-03.md)、
[OP-04](evidence/local-optimization/OP-04-2026-10-03.md)、
[OP-05](evidence/local-optimization/OP-05-2026-10-03.md)、
[OP-06](evidence/local-optimization/OP-06-2026-10-03.md)、
[OP-07](evidence/local-optimization/OP-07-2026-10-03.md) 与
[OP-08](evidence/local-optimization/OP-08-2026-10-03.md) 已满足各自验收。
[OP-09](evidence/local-optimization/OP-09-2026-10-03.md) 记录新未签名 Mac 候选的
源码/制品摘要、DMG 独立安装、本轮 14 项复验、40 项既有安装旅程及 15 条件跳过、
三项 OpenSSH 扩展和确定性清理。没有沿用旧包证明本轮功能；最终完整门禁返回 0：1,328 项单元/集成与 23 项视觉/无障碍通过。
各文件中的早期“待 OP-09”已明确为阶段记录，最新领取状态以顶部为准。

### OP-01：恢复检查与冻结基线

实现：

1. 记录当前提交、已有修改文件和 diff 摘要；区分原有修改与本轮增量，保留现有行为。
2. 复现日文设置页差异，查看实际/期望截图、trace 和 CSS；定位关闭按钮尺寸、标签
   换行等布局变化的实际原因。它们是待排查方向，不能提前写成确认根因。
3. 修复导致回归的实现。确属新的 Axterm 自有设计时，先明确设计意图和可用性证据，
   再更新对应快照；不得批量刷新、放宽阈值、删测试或借用旧产品相似度门禁。
4. 保存本轮基线摘要；继续使用隐藏窗口做常规自动化，可见窗口测量另行注明。
5. 复核完整套件中设置保存重试后的状态恢复失败；定向通过只能作为定位证据，不能
   替代修复后的完整检查。

验收：日文失败场景与设置保存重试恢复通过；四语言语言设置与 200% 缩放测试通过；标签关闭/新增/固定/
悬停语义通过；完整 `bun run check` 返回 0。任一未通过，OP-01 不得记为 completed。

### OP-04：SFTP 闭环与恢复语义

源码入口：Renderer `app.tsx`、`panels.tsx`、`file-context-menu.tsx`；Runtime
`packages/runtime/src/application/transfer-service.ts`；现有 SSH/SFTP 夹具与桌面旅程。

实现：

1. 打通本地/远端列表、右键上传/下载、工具栏当前目录目标、多选确认与传输中心。
   显示真实目标、进行中/完成/取消/失败状态及可操作的本地化错误。
2. 修复失败/取消项统一提供重试、但请求只存在于当前 generation 内存中的不一致。
   明确哪些记录可重试、哪些必须重新连接或授权；重试 Promise 失败必须可见。
3. 若需要能力字段，通过 Contract/OpenAPI/Client 表达，不能由 Renderer 猜测 Runtime
   内部状态。旧 generation 的 Grant/请求/审批不得自动复活。
4. 使用临时目录、自动生成的夹具凭据和 loopback SSH/SFTP server 完成真实协议旅程。
   可以修复现有 Widget 列表或使用独立测试夹具，但必须核对实际远端列表与传输字节。

验收：双向文件与递归目录、多选、目标相对路径和刷新通过；以 SHA-256/逐字节比较
证明数据正确；覆盖已有文件的覆盖冲突、取消、断线、Runtime 重启后不可重试/重新授权行为；
失败/取消的临时文件按既有策略清理，未授权覆盖不得损坏原文件；SSH、SFTP、stream、
listener 和 Grant 的所属资源清理通过。存在路径穿越或越权即不通过。

Docker daemon 可用时，补跑 `bun run test:ssh` 和最终候选的 packaged SSH 旅程。
不可用时记录 OpenSSH 项的原因、已完成的本地真实协议证据和解除条件；该项保留
`external-pending`，不能记为 OpenSSH 通过。本地 loopback 测试必须通过，不能用 mock
响应、空列表或 disabled 下载入口替代。

### OP-02：命令面板

现状：`app.tsx` 的 CommandPalette 搜索为 label 包含匹配，Enter 执行第一项，缺少
上下选择；Host 结果目前只导航到 Hosts 页。已有快捷键 action registry 可复用。

实现：统一静态动作描述、可用性、分组和快捷键提示；支持上下选择、Enter 执行选中项、
Esc 关闭、焦点回到原入口、空结果和合理限量。Host 结果进入现有连接流程；现有会话、
工作区、文件区及传输中心可通过明确动作到达。常用/最近排序只记录非敏感动作元数据，
先用当前会话内有上限的状态；不新增终端历史持久化。

验收：键盘选择能执行非第一项；中文/繁体/英文/日文搜索与显示可用；Host 搜索通过
本地夹具完成实际连接，Unknown/Changed Host Key 仍要求确认；失效上下文动作不可
执行且有说明；关闭后焦点恢复；命令与快捷键使用同一动作定义且无重复分发。

### OP-03：终端消费与性能

现状：Runtime 已用 socket bufferedAmount 和高低水位限制发送；常规 Renderer
`terminal.write` 尚未用消费回调对齐生产速度。现有 64 MiB 测试主要覆盖 Runtime
replay buffer，不能证明真实 Electron 中 xterm 消费、输入延迟或后台恢复表现。

实现：

1. 先建立 1/4/8 终端的真实生产 Electron 输出突发测试，记录吞吐、write 消费进度、
   待消费字节峰值、RSS、输入响应和 Ctrl+C、后台切换/恢复及搜索。运行可见性、输出
   规模、机器参数和采样方法进入证据，隐藏窗口不作为实际绘制/系统焦点性能证据。
2. 在 `PERFORMANCE_BUDGETS.md` 写清固定负载、队列上限与通过阈值，再进行实现比较。
   保留已有预算；修正当前文档 replay 常量与源码的差异，不凭旧测试耗时承诺 UI 性能。
3. 按数据决定是否补充消费反馈。若现有发送限制足够，仍需消费回调、队列上限与
   cleanup 的有效证据；若增加 WS control，则先记录设计决策，使用 Zod 校验与有限
   字节计数，验证累计确认不超过已发送量及重放/generation/socket 切换语义。
4. 所有 pause/resume、pending callback、listener 和 timer 在关闭、重启与断线时清理。
   不增加无上限的中间队列，不把 terminal bytes 放入 React/Zustand。

验收：固定负载下各项预先定义预算通过，前后对比可重现；交互与 Ctrl+C 可用；关闭/
断线/重启/重放不丢失协议语义、无残留资源或错误恢复；相关 Runtime 与 Electron 测试
通过。不能因没有出现崩溃就认定队列有界。既有 J-01 30 分钟认证保留，不无故重跑。

### OP-05：设置与视觉一致性

实现：将常用设置组织为语言、外观、终端、快捷键、连接和隐私等已有能力入口；原始
资源计数与诊断字段进入有明确标题的高级诊断区，避免普通页面直接展示内部字段名。
统一本轮涉及的标签、标题、按钮和文件菜单的自有 token 与布局职责，消除冲突覆盖，
而不是重做全部主题。失败、保存、恢复与失效状态有具体的用户说明。

验收：四语言 × 三视口（1280×800、1440×900、1920×1080）的相关页面可用；200%
缩放、键盘路径、可访问名称与焦点通过；无内容溢出或隐藏必需操作；保存/加载失败有
恢复入口；视觉基线体现明确自有设计，阈值与 Architecture Gate 不放松。

### OP-06：静态 feature 整理

现状：`app.tsx` 约 4,292 行、`panels.tsx` 约 11,662 行、Runtime HTTP app 约
6,519 行，功能与交互集中。行数是维护成本提示，不是缺陷或验收指标。

实现：将本轮命令面板、文件/传输中心、AI 上下文/审批 UI 拆成静态 feature 模块，
区分组件、纯模型和 Client 交互 hooks；共享 Shell 只负责布局、导航与组合。本轮新增
或修改的 HTTP 路由按既有 Application interface 组织，避免把实现继续堆入总入口。
已有未涉及路由不要求整体重写；禁止通过动态插件、全局 service locator 或跨层 import
实现拆分。新功能从开始就使用目标模块结构，避免后续重复迁移。

验收：三类 UI 功能有清晰归属与显式依赖；Shell 不重复实现业务状态机；Runtime route
不直接泄漏 Repository/vendor object；现有 Contract、generation、错误与测试行为不变；
类型、架构与相关集成/E2E 通过。仅机械拆文件或删除功能不算完成。

### OP-07：AI 上下文与审批体验

实现：展示本次请求实际使用的来源、大小/截断与脱敏提示，允许发送前检查与移除；
不把未确认的旧附件隐式带入下一轮。把解释错误、生成命令、插入终端及审批执行的
动作和目标区分清楚；审批卡展示可见参数、目标及结果，保留现有 Inspector 能力。
使用已有 loopback HTTP Provider 夹具生成确定性响应，不需要真实 API Key。

验收：OpenAI Chat、Responses、Anthropic 三类既有协议的相关流式/取消/错误路径通过；
上下文边界、附件上限与脱敏通过；生成和插入不自动执行；mutating/destructive/
privileged Tool 按 MASTER_SPEC 审批；参数/目标/摘要/有效期变化、重复审批、取消与
Runtime 重启不能绕过策略；无 secret、Provider token 或隐藏推理进入 UI store/日志。
真实模型回答质量和真实云端连通性保留为外部验证，不能由夹具结果代替。

### OP-08：文档与现状收口

实现：以 `STATUS.md` 顶部和文档导航作为当前进展入口，明确本地优化、已完成商业
脱钩、后续正式发行和历史 parity 的关系。修正仍被当作当前事实的旧描述，并更新
性能预算、打包流程、失败恢复和本轮操作说明。保留历史证据的日期、哈希和原结论；
确需拆出归档时保持链接可解析，不能改写历史通过记录为当前通过。

验收：九个工作包状态与实际证据一致；当前阅读路径无相互矛盾的领取指令；本地链接
可解析；新增文案只用四个支持语言；依赖发生变化才更新 `VERSIONS.md`，且版本例外
仍有 ADR 依据；文档、来源摘要及格式门禁通过。

### OP-09：未签名 macOS 本地候选

实现：在当前 Mac 上从验收源码构建独立输出目录的未签名 `.app`、DMG/ZIP 候选；
记录源码提交、dirty 快照摘要、构建工具版本及产物 SHA-256，生成/验证包级 SPDX
sidecar。使用现有打包脚本的 `--output`，不得覆盖此前保全的 `release/` 证据。
复制安装到源码目录外，卸载镜像后在受限 PATH 启动，验证 Runtime、PTY、持久化、
本轮 UI、AI loopback fixture 和 SSH/SFTP 本地真实协议流程。测试使用隔离数据目录，
不访问所有者真实 `data-v2/`、`vault-v2/` 或旧原型备份。

验收：候选独立运行，资源路径无源码/workspace 依赖；本轮功能不是仅 dev 可用；
安装旅程、包级 Contract/许可/名称边界检查通过；测试逐项记录 passed/skipped/pending；
测试结束回收 app、Runtime、fixture、stream、临时安装及挂载资源。签名、公证、
公开下载与正式签收不进入本工作包；Windows/Linux 未运行的原生测试继续 pending。

## 5. 检查入口与证据规则

以下命令在仓库根目录执行；仅运行与当前修改相关的定向测试，再运行必要的完整门禁。
测试筛选名称/路径在执行时核对，不能因为筛选得到零测试就记为通过。

```sh
# OP-01：定位现有失败；运行前保存上一轮需要保留的 test-results
AXTERM_E2E_HIDDEN_WINDOW=1 bunx playwright test --project=visual --grep 'keeps language settings bounded'
AXTERM_E2E_HIDDEN_WINDOW=1 bunx playwright test --project=desktop --grep 'tab close and add controls stay beside'

# Runtime 与本地 Provider 夹具
bunx vitest run packages/runtime/src/application/transfer-service.test.ts
bunx vitest run tests/integration/ai-provider-runtime.test.ts tests/integration/ai-conversation-runtime.test.ts
bunx vitest run tests/unit/performance-budget.test.ts

# 修改协议/边界后的检查
bun run contracts:check
bun run architecture:check

# 真实 Electron、桌面、视觉与无障碍；性能用例按 OP-03 补齐
bun run test:performance
AXTERM_E2E_HIDDEN_WINDOW=1 bun run test:e2e
AXTERM_E2E_HIDDEN_WINDOW=1 bun run test:visual
AXTERM_E2E_HIDDEN_WINDOW=1 bun run test:a11y

# 条件项：只有 daemon 可用时才领取 Docker OpenSSH 旅程
docker info
bun run test:ssh

# 收尾：文件摘要变化后重算来源台账，保留未审查项 pending
bun run source:review:generate
AXTERM_E2E_HIDDEN_WINDOW=1 bun run check
```

未签名 Mac 打包示例（`mktemp` 每次创建新的空目录；执行前核对当前脚本参数）：

```sh
bun run build
axterm_opt_package_dir="$(mktemp -d /tmp/axterm-local-opt-package.XXXXXX)"
node scripts/package-desktop.mjs --output "$axterm_opt_package_dir"
```

包级 SPDX、`AXTERM_PACKAGED_APP`、`AXTERM_DMG_PATH` 和 packaged SSH 的参数按
[PACKAGING](PACKAGING.md)、[既有 DMG 旅程](../../scripts/test-macos-dmg.sh) 及其脚本
实际读取项配置。示例打包成功不等于 OP-09 验收成功；不得在缺少 sidecar、夹具或
制品时空跑旅程后记完成。package/test 可能使用可见窗口，隐藏开发窗口开关不作用于
正式包；不把隐藏模式的 DOM focus 断言写成系统焦点验收。

每个工作包保存 `docs/implementation/evidence/local-optimization/OP-NN-YYYY-MM-DD.md`，
至少包含：问题与最终行为、变更文件、源码状态、环境、测试命令/退出码/通过与跳过数、
必要截图或 trace 的摘要、资源清理结果、剩余限制。大制品不直接加入源码，记录实际
位置和 SHA-256；证据不含 Token、密码、私钥、Host Vault 明文或个人终端内容。

工作包状态使用 `planned → in-progress → completed`，只反映必需本地验收；Docker
OpenSSH 等扩展子项独立登记，客观外部条件不足用 `external-pending` 并写清原因、
已有证据与解除条件。外部 pending 不算 passed，不阻止已满足全部本地验收的工作包
标记 completed；必需本地验收未通过则不能标记 completed。
遇到可修复失败先修代码，不删测试、不放宽架构门禁；继续执行不依赖该条件的工作包。
最终需要的本地条件无法满足时，目标保持未完成并如实交接，不能把等待记为验收。

## 6. 本地目标完成线与外部事项

只有以下条件全部满足，才可宣布本地优化目标完成：

1. OP-01～OP-09 的本地验收全部通过，相关 UI 与实际 Runtime/协议行为都有证据。
2. 完整 `bun run check` 返回 0；本轮定向/桌面/性能/安装旅程通过，没有忽略未知失败。
3. 本地 SSH/SFTP 的真实远端列表、双向字节和恢复语义，以及 AI 本地 Provider 的
   上下文/审批/取消路径通过；未签名 Mac 候选来自同一被验收源码。
4. `STATUS.md`、本计划状态表、预算、来源摘要和证据一致；资源 cleanup、安全与
   generation/restart 语义没有回退。

以下是明确独立的外部事项，不扩大本地目标，且必须持续标记真实状态：

| 外部事项                              | 当前起点                           | 解除条件                                                   |
| ------------------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| Docker OpenSSH 源码/packaged 扩展旅程 | 2026-10-03 本机三项真实旅程 passed | 证据见 OP-04/OP-09；以后候选仍须按其自身源码与制品真实复验 |
| 真实云模型连通性与回答质量            | 未领取                             | 实际 Provider 与授权测试条件；不要求所有者在本轮填写 Key   |
| 真实用户服务器/同步 Provider          | 未领取                             | 实际服务与账号授权；本地夹具只证明协议与产品行为           |
| Mac 签名、公证、公开下载、正式签收    | 后续 MCR-01～04                    | 另行领取发行任务及其真实外部条件                           |
| Windows/Linux 原生安装与性能          | 未在本机执行                       | 对应原生设备/执行器及真实测试证据                          |

本地目标完成后的报告应写“本地优化九项验收完成”，并附外部 pending 清单；不能写
“三平台发行完成”“OpenSSH 全通过”或“真实 AI 服务验证完成”。

## 7. 可直接用于目标模式的启动指令

2026-10-03 本计划的目标模式已完成全部九项本地验收；以下保留本轮目标指令作为
执行记录与复核模板。后续新工作需按其真实范围领取：

```text
在 /Volumes/A/code/project/axterm 执行
docs/implementation/LOCAL_OPTIMIZATION_GOAL_PLAN.md 定义的本地优化目标。

先完整阅读 AGENTS.md 要求的 MASTER_SPEC、STATUS、ADR-016、ADR-022、
MINIMUM_COMMERCIAL_RELEASE、COMMERCIALIZATION_CLEANUP_PLAN，遵循 ADR-023。
记录当前源码提交与已有工作树修改，保留原有修改和已通过行为。

按 OP-01 → OP-04 → OP-02 → OP-03 → OP-05 → OP-06 → OP-07 → OP-08 → OP-09
逐项完成最小完整实现、对应测试和证据。每个工作包更新本计划状态、STATUS 及证据；
需要架构变化先写 ADR。保持 Level 1、独立 Runtime、Zero Business IPC、正式
Contract 边界、应用本地 Vault、File Grant、Host Key 确认和 AI 审批策略。

不要求我提供 Token、API Key、Apple ID 或真实服务器凭据。使用自动生成的本地
SSH/SFTP 和 HTTP Model Provider 夹具，必须验证真实协议/文件字节和实际 UI。
先修复当前日文视觉失败，不删测试、不调宽阈值、不自动批量刷新快照。
终端性能先冻结负载与预算，再优化并用真实 Electron 复验；不无故重跑已接受的
J-01 30 分钟认证。未签名 Mac 制品用独立输出与测试数据目录，保留旧候选及备份。

Docker 可用则补 OpenSSH；不可用记录原因、已有证据与解除条件，继续独立工作。
云模型质量、真实账号服务、正式发布与 Windows/Linux 原生测试另列 pending，
不能记为通过。不要扩展为旧 parity 队列、完整三平台发行或 Plugin Kernel 改造。

持续推进到计划第 6 节的本地完成线全部满足。结束前重算必要来源摘要并运行
bun run check；失败修代码。只有全部必需本地验收通过才能标记目标完成。
最终报告已完成工作包、真实测试结果、未签名候选位置/摘要及剩余外部事项。
```
