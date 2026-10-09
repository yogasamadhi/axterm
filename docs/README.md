# Axterm 项目文档导航

> 当前状态：依据 [商业化清理计划](implementation/COMMERCIALIZATION_CLEANUP_PLAN.md)
> 顶部的三项完成线，本轮商业脱钩已有工程验收证据；正式商业发行尚未进行。
> [ADR-022](adr/ADR-022-commercial-release-mac-acceptance.md) 与
> [最小商业发行清单](implementation/MINIMUM_COMMERCIAL_RELEASE.md) 是以后实际发行的
> Mac 完成线。Windows/Linux 保持兼容目标，由所有者在对应电脑自测；未测不得写成通过。

> 2026-10-03 新领取的本地优化计划见
> [LOCAL_OPTIMIZATION_GOAL_PLAN](implementation/LOCAL_OPTIMIZATION_GOAL_PLAN.md)：
> 九个无需所有者填写 Token 的工作包、验收条件、执行顺序与目标模式启动指令。
> [当前操作与恢复入口](implementation/LOCAL_OPTIMIZATION_USAGE.md) 说明本轮功能的使用和失败恢复。
> OP-01～OP-09 本地验收全部完成，新 Mac 候选安装/功能/可见性能/OpenSSH 与最终完整门禁通过；
> 制品与证据见 [OP-09](implementation/evidence/local-optimization/OP-09-2026-10-03.md)。正式发行与外部验证仍单独领取。

> 历史文档中的 `Legacy Prototype` 是脱敏占位称呼。含该称呼的旧包名、路径和
> 外部 URL 不再是可执行或可访问的事实依据；需要核对原始来源、许可或哈希时，
> 应查阅受控的先前仓库与证据备份。当前架构与验收以 ADR-023、STATUS 和
> 商业化清理计划顶部为准；实际发行时再按 MINIMUM_COMMERCIAL_RELEASE 验收，
> 不以这些脱敏历史记录作发布签收。

## 固定决策

- ADR-016 取代 ADR-003 的 1:1 长期产品目标；[ADR-018](adr/ADR-018-independent-terminal-transfer-implementations.md) 取代 ADR-013 的直接 Legacy Prototype 协议来源决定，同时保留其 Runtime 安全边界；保留可用工作流，并对 UI/UX 有目标地美化与品牌化。
- 已移除的旧参考基线仅保留在受控历史证据归档；当前工作树、构建和发行门禁不使用 `vendor/legacy-prototype`。
- 仅保留简体中文、繁体中文、英文和日文；内置主题改为精选的独立集合；按 [ADR-021](adr/ADR-021-immediate-legacy-prototype-compatibility-removal.md) 在首次公开版前直接移除旧兼容入口，取消公开迁移期。
- 新贡献使用根 Apache-2.0 的提交条款，并通过[贡献与来源授权规则](../CONTRIBUTING.md)
  记录权利声明和第三方材料披露；它不替代历史来源审查。
- Axterm 保留 React 19、TypeScript、独立 Core Runtime、REST/OpenAPI、SSE、Binary WS、
  HTTP/FS/SFTP streaming、SQLite/Drizzle 等现有技术边界。
- [ADR-024](adr/ADR-024-terminal-output-consumption-window.md) 约束终端消费窗口、
  Binary WS 消费确认与连接生命周期；本地验收见 OP-03 证据，新候选包内复验见 OP-09。
- [ADR-026](adr/ADR-026-native-directory-drop-metadata.md) 约束可信原生目录拖放的本地元数据读取；目录授权、文件浏览和终端路径插入仍经过 REST/File Grant。
- [ADR-025](adr/ADR-025-ai-context-review-receipt.md) 约束实际 AI 上下文预览、五分钟 review receipt 与审批绑定；本地验收见 OP-07，新候选包内复验见 OP-09。
- [ADR-028](adr/ADR-028-ai-terminal-workspace.md) 约束默认直接聊天、当前标签工作目录和经审批的本地/SSH 命令执行；[Pi AI 配置](implementation/PI_AI_ENGINE.md) 说明配置与使用。
- [ADR-029](adr/ADR-029-ai-modes-and-mentioned-skills.md) 区分聊天/工作两种模式，并复用 Pi 加载 `@` 技能；工作模式仍执行现有审批策略。
- Electron Main 只承载 Desktop Host 能力；Renderer 不直接使用 Node、Electron、数据库或
  协议实现。
- 凭据只保存在 application-local Host Credential Vault，业务数据库只保存
  `credentialRef`。产品不探测、不调用、也不提示使用任何系统凭据服务。
- 首次窗口默认尺寸固定为 **1440×900**；视觉验收同时覆盖 1280×800、1440×900 和
  1920×1080。
- Docker 只允许作为开发/CI 中可丢弃的远端协议测试夹具；它不是桌面产品组件、运行时
  依赖或最终用户安装条件。
- Phase 0–21 是已积累的能力和测试底座；旧 122 行、99% 门槛只作首版 parity 历史记录。
  本轮脱钩三项完成线已留证；MCR-01～04 和 P-01–P-08 分别是后续首次发行与完整三平台台账，`MASTER_SPEC` 的架构与安全门禁仍有效。

## 开发时按什么顺序读

1. [MASTER_SPEC](architecture/MASTER_SPEC.md)：架构、安全、通信边界和总阶段定义。
2. [STATUS](implementation/STATUS.md)：实际完成内容、验证结果和仍 open 的事项。
   [LOCAL_OPTIMIZATION_GOAL_PLAN](implementation/LOCAL_OPTIMIZATION_GOAL_PLAN.md)：本轮本地优化的领取、依赖与完成线；不要求真实账号凭据。
3. [COMMERCIALIZATION_CLEANUP_PLAN](implementation/COMMERCIALIZATION_CLEANUP_PLAN.md) 顶部与 [ADR-016](adr/ADR-016-independent-open-source-product.md)：本轮脱钩范围和完成证据。[ADR-022](adr/ADR-022-commercial-release-mac-acceptance.md) 与 [MINIMUM_COMMERCIAL_RELEASE](implementation/MINIMUM_COMMERCIAL_RELEASE.md)：以后首次商业发行的完成线。[INDEPENDENT_RELEASE_MATRIX](implementation/INDEPENDENT_RELEASE_MATRIX.md) 保留完整三平台逐项验收。
   [AXTERM_VISUAL_BASELINE](implementation/AXTERM_VISUAL_BASELINE.md)：当前 Axterm 自有三档视口与迁移页面回归的范围及未完成的设计证据。
   [未公开旧原型的数据退出说明](implementation/UNPUBLISHED_PROTOTYPE_DATA_EXIT.md)：当前冷备份、手动重建和 Axterm 自有配置路径。
   [MIGRATION_GUIDE](implementation/MIGRATION_GUIDE.md) 与 [迁移发布记录](../compliance/MIGRATION_RELEASE_RECORD.json)：仅供受控工程回溯的旧公开迁移期提案；ADR-021 已取消该窗口，准备公开源码时应排除过时操作说明。
   [发行服务记录](../compliance/RELEASE_SERVICE_RECORD.json)：发布负责人填写公开隐私/数据处理、安全报告和支持政策的非敏感事实；`pending` 不代表已有公开服务承诺。
   [RELEASE_OWNER_HANDOFF](implementation/RELEASE_OWNER_HANDOFF.md)：需要发布、法务、语言、品牌与三平台工程签收的独立发行外部工作，以及新仓库切换顺序。
4. [LEGACY_PROTOTYPE_PARITY_ROADMAP](implementation/LEGACY_PROTOTYPE_PARITY_ROADMAP.md) 和 [LEGACY_PROTOTYPE_PARITY_MATRIX](implementation/LEGACY_PROTOTYPE_PARITY_MATRIX.md)：首版历史任务与证据，不再是当前队列。
5. [LEGACY_PROTOTYPE_PARITY_SPEC](product/LEGACY_PROTOTYPE_PARITY_SPEC.md)：首版 1:1 的历史定义和证据口径。
6. [PARITY_HARNESS](implementation/PARITY_HARNESS.md)：历史上如何运行固定 Legacy Prototype、采集截图/trace 和生成差异报告；当前工作树不可运行，也不得复制进新公开仓库。
7. [UPSTREAM](implementation/UPSTREAM.md)：历史来源/改编记录；不作为当前实现或独立发行验收依据。
8. [VERSIONS](implementation/VERSIONS.md) 与 [PACKAGING](implementation/PACKAGING.md)：依赖、原生模块、安装包和平台验收。
   [THIRD_PARTY_LICENSE_AUDIT](implementation/THIRD_PARTY_LICENSE_AUDIT.md)：生产依赖许可盘点、随包文本与仍开放的发行审查。
9. [PERFORMANCE_BUDGETS](implementation/PERFORMANCE_BUDGETS.md)：Phase 21 万级数据、长输出和队列性能预算与证据。
10. [LONG_RUN_RELIABILITY](implementation/LONG_RUN_RELIABILITY.md)：Phase 21 混合负载、资源上限、60 秒冒烟和 30 分钟认证证据。
11. [SIGNED_UPDATE_FEED](implementation/SIGNED_UPDATE_FEED.md)：签名更新清单、下载约束、环境配置与发行验收流程。
12. [AXTERM_BRAND](product/AXTERM_BRAND.md)：AxTerm 标志含义、色彩、资产来源和使用规则。
13. [ISSUE_TRACKER](ISSUE_TRACKER.md)：使用中发现的问题、分诊、复现和下一次迭代的验证记录。

## 历史首版实施位置（截至 2026-09-14）

截至 2026-09-14，Phase 11 已完成；Phase 12–18 的功能主干已经实现，仍需按各行补齐固定
视觉、故障和 macOS/Windows/Linux 打包证据。Phase 19 的 H-01 设置导航、H-02 全量设置
映射、H-03 Terminal Theme CRUD/导入导出、H-04 实时主题/背景作用域、H-05 完整快捷键
Action Registry/编辑/冲突检测/分发、H-06 全局窗口显隐热键和 H-07 窗口恢复、多实例/
退出确认、H-08 无密文设置/凭据元数据导入导出，以及 H-09/H-10 八类数据同步和
GitHub/Gitee/WebDAV/custom Provider 已经实现；**Phase 19 H-11 语言资源、运行时切换、
fallback、RTL 和全部 Renderer surface 的目录接入**已经完成，AST 门禁已将未目录化的
直接 CJK 字面量从 2,495 项降为 0。macOS arm64 的三档 LTR/RTL Legacy Prototype/Axterm 截图与
trace 是已移至受控历史证据归档的首版记录，不在当前工作树、构建或新公开仓库候选中；
六张相似度为 96.660%–97.143%，全部通过 95% 数值门禁和七项硬伤门禁。
复制后的 macOS arm64 安装包已经通过 English 即时切换、冷启动持久化和 Arabic RTL；
H-11 继续补 Windows/Linux 安装包本地化证据。Phase 20 的 I-01/I-02 Provider
配置与三类流式协议、I-03 持久聊天会话和历史、I-04 终端选区解释、I-05 命令/脚本审核、
I-06 结构化 AI 书签审阅保存、I-07 AI 主题预览/编辑/保存、I-08 完整 Agent Tool Card
生命周期、I-09 安全文本附件和 I-10 认证 MCP Server/Widget 已经实现；Phase 21 的
J-01–J-03、J-06 和 J-10 已完成实现；macOS arm64 安装包的独立运行、真实
SSH/SFTP、持久化和旧 schema/应用本地 Vault 升级旅程已通过。J-04/J-05 等待可达的
Windows/Linux 执行器证据；J-09 万级数据、长输出、传输历史与生产 Electron 性能门禁已经通过；现有 48 个真实场景的 144 张
三视口对照全部达到 95% 相似度，1008/1008 项硬伤检查通过，最低相似度为 95.089%；
Phase 16 的真实文件浏览、128 MiB SFTP 传输和远程编辑实景已进入 corpus；Phase 17 的
七类协议表单和真实 XMODEM 传输中状态也已进入 corpus；Phase 18 的 Quick Command/Batch、
Trigger、Terminal Information/Monitor 与 Static File Server Widget 实景也已进入 corpus；
Phase 19–21 已补设置、同步、本地化、Provider、Chat、Agent、MCP、真实 AI 取消态、真实 SSH 断线重连、升级和无障碍 UI。
Manifest 的 48 个可视场景已全部覆盖，平台安装证据仍按独立证据收口。
H-12 的本地可实施部分也已完成：签名 loopback 更新源通过检查、进度、取消、重试、
SHA-256/Ed25519 校验和安装包交接；最新 macOS arm64 DMG 已通过校验、挂载、独立复制、
镜像卸载后启动并重复通过该签名更新旅程，同时保持安装包路径不进入 Renderer。正式 HTTPS
源、生产签名和三平台二进制升级仍待发行证据。
J-01 已加入 Domain Event/幂等收据固定保留上限和真实 SSH/PTY/SFTP/传输/隧道/Widget/MCP
混合负载入口；60 秒冒烟和 729 轮加速回归通过。既有正式轮廓运行 31 分 27 秒、完成
1812 轮且零违规，超过新的 30 分钟门槛；用户确认无需重跑，J-01 已按组合证据完成认证。
生产 Electron 全量桌面回归已达到 65/65 可运行旅程通过；该调用中条件跳过的一条 Docker
SSH 旅程由独立 SSH 套件覆盖，无障碍 2/2 与万级书签性能 1/1 同步通过。
Phase 21 的本机可执行实现和 J-01 30 分钟长稳认证已经完成；正式收口仍等待
Windows/Linux 安装包、生产签名升级和跨平台打包视觉证据。

当前矩阵共有 122 项：1 Certified、116 Implemented、5 Partial、0 Missing。72 个设置和
23 个默认动作都已登记；设置映射现为 50 Implemented、22 Partial、0 Missing，23 个动作均已
实现。七个最后缺失的 Legacy Prototype 默认行为已经接入 Runtime Settings、实际启动/SFTP/xterm/
Host 编辑器路径和数据往返；H-11 语言项保持 Partial。`Implemented` 只代表
代码和自动化行为已存在；缺少视觉、交互、故障或平台证据时仍不能标记 Certified。

这里的“当前实施 Phase 21”是首版历史状态，不表示早期 Phase 已经认证。Phase 12–18
中仍 open 的集成项原计划在后续阶段回填；以下 Phase 11–21 顺序也只作历史记录。当前
本地优化按 `LOCAL_OPTIMIZATION_GOAL_PLAN` 领取；商业脱钩与以后正式发行分别以商业化
清理计划和独立发行矩阵的实际范围为准，而非旧 Roadmap 的执行队列。

## Phase 11–21 交付顺序

| Phase | 交付范围                                                              |
| ----- | --------------------------------------------------------------------- |
| 11    | 固定参考应用、场景矩阵、设计 token、截图与 trace 工具。               |
| 12    | Shell、导航、标签、1–4 pane、窗口和工作区。                           |
| 13    | 书签、分组、Profile、历史、SSH Config 和数据迁移。                    |
| 14    | 终端菜单、搜索、剪贴板、字体/编码、日志、重连、快捷键栏、建议和拖放。 |
| 15    | SSH 认证、Host Key、代理、跳板、脚本、X11 和隧道。                    |
| 16    | 本地/远程文件管理器、编辑器、比较和完整传输中心。                     |
| 17    | FTP/FTPS、Telnet、Serial、RDP、VNC、SPICE、Web、Zmodem/Xmodem/trzsz。 |
| 18    | 快捷命令、批量输入/操作、Trigger、监控、Widget、CLI/deep link。       |
| 19    | 设置、主题、背景、快捷键、窗口、多语言和同步。                        |
| 20    | AI Provider/聊天/Agent 与 MCP。                                       |
| 21    | 长期运行、故障、性能、可访问性、视觉和三平台发行认证。                |

每个功能都必须按“参考行为 → 场景/证据 → Contract/边界 → Runtime/Host → Renderer →
自动化测试 → 三档视觉 → 打包平台 → 更新 Matrix/Status/Upstream”的垂直切片完成。具体
工作包和跨阶段依赖以实施路线为准。

## 历史首版的完成口径（非当前独立发行门禁）

- 常规目标是 Matrix 122/122 Certified 或经 ADR 批准的 Not applicable；遇到客观阻塞时，
  实施交付线是至少 121/122，并在 `STATUS.md` 完整登记唯一剩余 Blocked 项；
- 功能、交互、视觉、配置、数据、失败恢复和平台七个维度都有对应证据；
- macOS arm64、Windows x64、Linux x64 打包应用和旧版本升级流程通过；
- `bun run check`、真实协议 fixture、桌面 E2E、视觉差异和长期运行门禁通过；
- Phase 10、Phase 21 与 `MASTER_SPEC` §49 同时关闭。

`Partial`、`Implemented`、`Blocked`、静态页面、disabled 入口、mock 数据和只在开发模式
工作的流程都不计入覆盖率。99% 实施交付也不能替代 Desktop 1.0 的强制发行证据。
