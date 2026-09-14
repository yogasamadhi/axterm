# Axterm 项目文档导航

> 当前目标：使用 Axterm 自己的 Level 1 技术栈，1:1 复刻固定 Electerm 5.5.0 基线的
> 桌面功能和 UI/UX。

## 固定决策

- 参考基线是 `vendor/electerm@799bedef98c1deae676ae03041719de98d3b57f1`。
- 1:1 覆盖功能、信息架构、交互、视觉、配置、数据、失败恢复和三平台打包行为。
- Axterm 保留 React 19、TypeScript、独立 Core Runtime、REST/OpenAPI、SSE、Binary WS、
  HTTP/FS/SFTP streaming、SQLite/Drizzle 等现有技术边界。
- Electron Main 只承载 Desktop Host 能力；Renderer 不直接使用 Node、Electron、数据库或
  协议实现。
- 凭据只保存在 application-local Host Credential Vault，业务数据库只保存
  `credentialRef`。产品不探测、不调用、也不提示使用任何系统凭据服务。
- 首次窗口默认尺寸固定为 **1440×900**；视觉验收同时覆盖 1280×800、1440×900 和
  1920×1080。
- Docker 只允许作为开发/CI 中可丢弃的远端协议测试夹具；它不是桌面产品组件、运行时
  依赖或最终用户安装条件。
- Phase 0–10 是架构与基础功能底座。Phase 11–21 是当前复刻路线；常规目标是 122/122，
  遇到客观阻塞时允许在至少 121/122（99.18%）加唯一登记 Blocked 项处结束实施追赶。
  Desktop 1.0 的强制架构、安全和发行门禁仍按 `MASTER_SPEC` §49 判断。

## 开发时按什么顺序读

1. [MASTER_SPEC](architecture/MASTER_SPEC.md)：架构、安全、通信边界和总阶段定义。
2. [STATUS](implementation/STATUS.md)：实际完成内容、验证结果和仍 open 的事项。
3. [ELECTERM_PARITY_ROADMAP](implementation/ELECTERM_PARITY_ROADMAP.md)：要做什么、分阶段步骤、依赖和当前执行队列。
4. [ELECTERM_PARITY_MATRIX](implementation/ELECTERM_PARITY_MATRIX.md)：122 项功能逐项差距、owner、状态和认证证据。
5. [ELECTERM_PARITY_SPEC](product/ELECTERM_PARITY_SPEC.md)：1:1 的七维定义、允许差异和验收阈值。
6. [PARITY_HARNESS](implementation/PARITY_HARNESS.md)：如何运行固定 Electerm、采集截图/trace 和生成差异报告。
7. [UPSTREAM](implementation/UPSTREAM.md)：借鉴了哪些 Electerm 代码、落到 Axterm 哪一层、做了什么架构改写。
8. [VERSIONS](implementation/VERSIONS.md) 与 [PACKAGING](implementation/PACKAGING.md)：依赖、原生模块、安装包和平台验收。
9. [PERFORMANCE_BUDGETS](implementation/PERFORMANCE_BUDGETS.md)：Phase 21 万级数据、长输出和队列性能预算与证据。
10. [LONG_RUN_RELIABILITY](implementation/LONG_RUN_RELIABILITY.md)：Phase 21 混合负载、资源上限、60 秒冒烟和 30 分钟认证证据。
11. [SIGNED_UPDATE_FEED](implementation/SIGNED_UPDATE_FEED.md)：签名更新清单、下载约束、环境配置与发行验收流程。
12. [AXTERM_BRAND](product/AXTERM_BRAND.md)：AxTerm 标志含义、色彩、资产来源和使用规则。
13. [ISSUE_TRACKER](ISSUE_TRACKER.md)：使用中发现的问题、分诊、复现和下一次迭代的验证记录。

## 当前实施位置

截至 2026-09-14，Phase 11 已完成；Phase 12–18 的功能主干已经实现，仍需按各行补齐固定
视觉、故障和 macOS/Windows/Linux 打包证据。Phase 19 的 H-01 设置导航、H-02 全量设置
映射、H-03 Terminal Theme CRUD/导入导出、H-04 实时主题/背景作用域、H-05 完整快捷键
Action Registry/编辑/冲突检测/分发、H-06 全局窗口显隐热键和 H-07 窗口恢复、多实例/
退出确认、H-08 无密文设置/凭据元数据导入导出，以及 H-09/H-10 八类数据同步和
GitHub/Gitee/WebDAV/custom Provider 已经实现；**Phase 19 H-11 语言资源、运行时切换、
fallback、RTL 和全部 Renderer surface 的目录接入**已经完成，AST 门禁已将未目录化的
直接 CJK 字面量从 2,495 项降为 0。macOS arm64 的三档 LTR/RTL Electerm/Axterm 截图与
trace 已入库；六张相似度为 96.660%–97.143%，全部通过 95% 数值门禁和七项硬伤门禁。
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
实现。七个最后缺失的 Electerm 默认行为已经接入 Runtime Settings、实际启动/SFTP/xterm/
Host 编辑器路径和数据往返；H-11 语言项保持 Partial。`Implemented` 只代表
代码和自动化行为已存在；缺少视觉、交互、故障或平台证据时仍不能标记 Certified。

这里的“当前实施 Phase 21”不表示早期 Phase 已经认证。Phase 12–18 中仍 open 的集成项会在
文件、协议、自动化、设置和发行能力落地后回填；完整范围始终是下面 Phase 11–21 的全部
内容。实际领取顺序只以 Roadmap 的“从现在开始的执行队列”为准。

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

## 什么情况下才算完成

- 常规目标是 Matrix 122/122 Certified 或经 ADR 批准的 Not applicable；遇到客观阻塞时，
  实施交付线是至少 121/122，并在 `STATUS.md` 完整登记唯一剩余 Blocked 项；
- 功能、交互、视觉、配置、数据、失败恢复和平台七个维度都有对应证据；
- macOS arm64、Windows x64、Linux x64 打包应用和旧版本升级流程通过；
- `bun run check`、真实协议 fixture、桌面 E2E、视觉差异和长期运行门禁通过；
- Phase 10、Phase 21 与 `MASTER_SPEC` §49 同时关闭。

`Partial`、`Implemented`、`Blocked`、静态页面、disabled 入口、mock 数据和只在开发模式
工作的流程都不计入覆盖率。99% 实施交付也不能替代 Desktop 1.0 的强制发行证据。
