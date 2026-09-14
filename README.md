<p align="center">
  <img src="apps/desktop/build/icon.svg" width="112" height="112" alt="AxTerm logo" />
</p>

# Axterm

当前项目目标是使用 Axterm 的 Level 1 技术栈，1:1 复刻固定 Electerm 5.5.0 基线的
桌面功能与 UI/UX。文档入口、实施顺序和完成口径见
[项目文档导航](docs/README.md)。

Axterm 是一个 Electron 桌面终端与远程运维工作台。当前 `0.10.0` 已实现
MASTER_SPEC Phase 1–9，并完成 Phase 10 的发行配置与 macOS arm64 本机验收。
Windows/Linux 实机打包和签名测试频道升级尚未验收，因此 Desktop 1.0 仍保持未完成。
实施遇到客观阻塞时会先登记任务、原因、证据和解除条件，再继续后续工作；常规目标是
122/122，用户接受的实施交付线为至少 121/122（99.18%）且最多一个登记 Blocked 项。

项目现已固定 `vendor/electerm` 的 package 5.5.0 提交作为桌面功能和 UI/UX
的 1:1 复刻基线。Phase 1–9 是技术和基础功能底座，不代表已经达到 Electerm
产品完整度。当前 122 个能力条目为 1 Certified、116 Implemented、5 Partial、
0 Missing；Phase 11 的对照工具与 Phase 16–18 的功能主干实现已完成，Phase 19 H-11
已完成语言基础和全部 Renderer surface 的目录接入，AST 门禁已将未目录化的直接 CJK
字面量从 2,495 项降为 0。macOS arm64 已采集 Electerm/Axterm 的三档 LTR/RTL 截图与
trace；六张均已达到 95% 相似度，区间为 96.660%–97.143%。截图证据同时通过控件重叠、
文字裁切、可读性、视口边界、双向排版、键盘焦点和关键操作七项硬伤门禁；复制后的
macOS arm64 安装包也已通过 English 切换、冷启动持久化和 Arabic RTL，H-11 仍需补
Windows/Linux 安装包证据。H-05 的
23 项快捷键注册表、H-06 的全局窗口
显隐热键、H-07 的窗口恢复/多实例/退出确认、H-08 的无密文设置与凭据元数据
导入导出，以及 H-09/H-10 的八类数据同步和 Provider 已经实现，并按
Phase 12–21 的依赖关系持续回填和认证。
固定 `default-setting.js` 的 72 个键现为 50 Implemented、22 Partial、0 Missing：
`onStartSessions`、`enableGlobalProxy`、`defaultEditor`、`screenReaderMode`、
`autoRefreshWhenSwitchToSftp`、`sftpPathFollowSsh` 和 `sshSftpSplitView` 已落到
Runtime Settings 及实际启动、终端、文件管理和 Host 打开行为；Electerm 数据往返也覆盖这些
设置，其中短 ID 启动书签会在导入事务中映射到新实体。
Phase 20 已完成 I-01/I-02 的 Provider 全量配置、连接测试与 OpenAI Chat、OpenAI
Responses、Anthropic 三种流式格式，并完成 I-03 的持久聊天会话、历史续聊、取消和删除
主链；I-04 的终端选区解释和 I-05 的命令建议/脚本复制插入审核也已实现。I-06 现已完成
严格结构化、无凭据的 AI 书签草稿，以及生成、检查、编辑和显式保存流程；I-07 也已完成
AI 主题的完整颜色/对比度校验、预览、编辑、丢弃恢复和显式保存。I-08 已完成参数、风险、
审批、状态、结果、拒绝、取消和过期均可见的 Agent Tool Card，并通过真实 PTY 审批执行测试；
I-09 也已完成安全文本附件的选择/拖放、脱敏预览、移除、显式发送和仅元数据历史；I-10
已完成 loopback/Bearer MCP Server、工具筛选、会话状态和复用 Agent 精确审批的修改调用。
Phase 21 的 J-01–J-03、J-06 和 J-10 已完成实现。macOS arm64 安装包已通过
独立目录、PTY、SQLite、重启持久化、真实 SSH/SFTP 和旧 schema/本地 Vault 升级旅程；
Windows/Linux 工作流已定义，等待可达的对应平台执行证据。J-09 万级数据与长输出性能门禁已通过；
现有 48 个真实场景的 144 张三视口对照全部达到 95% 相似度，1008/1008 项硬伤检查通过，
最低相似度为 95.089%。Phase 16 已覆盖真实 Docker OpenSSH/SFTP 文件浏览、128 MiB 传输和
远程文本编辑；Phase 17 已覆盖 FTP、Telnet、Serial、RDP、VNC、SPICE、Web/Deep Link
真实配置表单，以及通过 Runtime、File Grant 和本地 PTY 握手推进的 XMODEM 传输进度；
Phase 18 已加入 Quick Command/Batch、Trigger、Terminal Information/Monitor 和 Static File
Server Widget 的 Electerm/Axterm 成对实景；Phase 19 的六个设置场景、Phase 20 的
Provider/Chat/Agent/MCP 和 Phase 21 的真实 SSH 断线重连、升级/无障碍 UI 也已进入三视口 corpus。
AI Chat 的真实持久取消态同时覆盖部分输出保留和 `REQUEST_CANCELED`。Manifest 中
48 个 `capture: true` 场景已全部覆盖；平台安装和签名频道仍按独立证据验收。
生产 Electron 全量桌面回归现为 65/65 可运行旅程通过，另有一条
Docker SSH 旅程由独立套件覆盖；无障碍与万级书签性能回归也全部通过。
J-01 已有固定的 Domain Event/幂等数据上限和可重复的真实混合负载入口；60 秒冒烟、
729 轮加速回归均通过。既有正式轮廓运行 31 分 27 秒，完成 1812 轮且零违规，超过当前
30 分钟门槛；用户确认无需重跑，J-01 已按组合证据完成认证。
最新 macOS arm64 DMG 已通过校验、挂载、独立安装复制、镜像卸载后启动及 5 项可运行
安装包旅程，其中包括真实签名 loopback 更新检查、下载、校验、ready 状态和系统安装交接。

## 现有基础能力

- 本地终端：多标签、拆分窗格、配置、搜索、链接、复制粘贴和渲染降级；
- SSH：密码、私钥/口令、Keyboard Interactive、Agent、Host Key 和跳板机；
- SFTP：目录与文件操作、递归上传下载、队列、进度、取消、重试和冲突策略；
- 远程文件：2 MiB 以内 UTF-8 文本编辑、版本冲突、原子保存和 chmod；
- 隧道：本地转发、远程转发和动态 SOCKS；
- 工作区：主机/分组、SSH Config 导入、最近连接、快捷命令和命令面板；
- AI：OpenAI-compatible Provider、Explain/Generate/Diagnose、流式输出、脱敏上下文、
  明确 Tool 白名单、精确参数审批和审计；
- 可靠性：SQLite 迁移/备份恢复、SSE 重放、任务幂等、Runtime 自动重启、日志脱敏和诊断导出。
- 更新：无服务器时保持禁用；配置源后由 Desktop Host 校验 Ed25519 清单并提供有界下载、
  进度、取消、重试和安装包交接。

## 架构

```text
Electron Main (Desktop Host)
  ├─ Application-local encrypted Vault / File Grant / Native Dialog / Updater boundary
  └─ utilityProcess → Core Runtime (Hono / SQLite / SSH / PTY / AI)

React Renderer ── REST/OpenAPI + SSE + Binary WS ── Core Runtime
```

业务能力只通过 Runtime 的版本化 REST/OpenAPI、fetch SSE 和终端 Binary WebSocket
暴露。`desktop:bootstrap` 仅返回 Runtime discovery 信息。Renderer 没有 Node、Electron、
SQLite、Drizzle、ssh2 或 node-pty 访问权限；Runtime 不 import Electron，并保留独立 Node
入口。完整约束见 [MASTER_SPEC](docs/architecture/MASTER_SPEC.md) 和 [AGENTS](AGENTS.md)。

## 开发

需要 Bun 1.4.x、Node 24.18+（24.x）和 Git。首次获取需初始化 electerm 子模块：

```sh
git submodule update --init --recursive
bun install --frozen-lockfile
bun run dev
```

最终用户运行桌面安装包时不需要安装 Node、Bun 或 Docker。Docker 只用于开发仓库中
可丢弃的 OpenSSH/SFTP 集成测试对端，不参与应用启动、业务运行或发行。开发 Renderer 固定使用
`127.0.0.1:5173`，Runtime 始终绑定 `127.0.0.1` 的系统分配端口。

开发启动器会把 Electerm 兼容参数转发给 Desktop：

```sh
bun run run.ts -- -tp local -d "/path/with spaces" -t "Local workspace"
bun run run.ts -- -l operator -P 2222 -pw session-only server.example
bun run run.ts -- -tp telnet -opts '{"host":"router.example","port":2323}' --new-window
bun run run.ts -- -bo "/path/to/batch-operation.json"
```

使用 `bun run run.ts -- --help` 查看完整选项。命令行密码、私钥口令只用于本次会话；
私钥、初始目录和批量文件会先转换为 Desktop Host File Grant，绝对路径不会交给 Renderer。
`--server-port` 不受支持，因为 Runtime 固定使用 loopback 的系统分配端口。

## 验证

| 命令                             | 用途                                                              |
| -------------------------------- | ----------------------------------------------------------------- |
| `bun run check`                  | lint、strict typecheck、测试、架构门禁、Contract drift 和生产构建 |
| `bun run test:e2e`               | Electron utilityProcess、真实本地 PTY、持久化、崩溃重启与清理     |
| `bun run test:performance`       | 生产 Electron 万级书签树响应、搜索、滚动和 DOM 上限               |
| `bun run test:ssh`               | digest-pinned Docker OpenSSH、SSH/SFTP/三类隧道                   |
| `bun run test:soak:smoke`        | 运行一分钟真实 SSH/PTY/SFTP/Widget/MCP 混合负载                   |
| `bun run test:soak:30m`          | 仅在明确要求时重新运行 J-01 的 30 分钟资源稳定性认证              |
| `bun run test:soak:verify`       | 独立校验完整时长、连续检查点、预算、计数和最终资源释放            |
| `bun run package:dir`            | 为当前平台生成未签名的 unpacked app                               |
| `bun run test:packaged`          | 独立目录、受限 PATH、Runtime、本地 PTY 和 SQLite 验收             |
| `bun run test:ssh:packaged`      | 从已打包应用连接 Docker OpenSSH 并验证 SSH PTY                    |
| `bun run package`                | 生成当前平台安装包，不发布                                        |
| `bun run contracts:check`        | 校验 255 个 OpenAPI 操作与生成 Client 无漂移                      |
| `bun run parity:audit`           | 校验固定基线、122 项矩阵、映射、设计 token 与 trace 脱敏          |
| `bun run parity:capture:phase16` | 采集真实 Docker SFTP 文件管理三档对照                             |
| `bun run parity:capture:phase17` | 采集七类协议表单与真实 XMODEM 传输中三档对照                      |
| `bun run parity:capture:phase18` | 采集命令/Trigger、监控和 Widget 四类三档对照                      |
| `bun run parity:trace:audit`     | 单独扫描全部视觉证据 trace，拒绝未脱敏的凭据与鉴权值              |
| `bun run parity:diff`            | 对三档视口的 Electerm/Axterm 截图生成像素差异报告                 |

macOS 未签名本地构建使用：

```sh
bun run package
```

打包脚本固定关闭本机签名身份自动发现，不读取开发者环境中的证书身份。

打包、原生模块、签名接入点、Updater 状态及跨平台验收命令见
[PACKAGING](docs/implementation/PACKAGING.md)。阶段证据和未完成项见
[STATUS](docs/implementation/STATUS.md)，依赖见
[VERSIONS](docs/implementation/VERSIONS.md)。

Electerm 1:1 的范围、允许差异、视觉阈值和证据规则见
[ELECTERM_PARITY_SPEC](docs/product/ELECTERM_PARITY_SPEC.md)，逐功能差距、
上游路径和负责阶段见
[ELECTERM_PARITY_MATRIX](docs/implementation/ELECTERM_PARITY_MATRIX.md)。
具体要做的功能、垂直切片步骤、阶段依赖和当前执行队列见
[ELECTERM_PARITY_ROADMAP](docs/implementation/ELECTERM_PARITY_ROADMAP.md)。
对照环境准备、本地凭据隔离采集守卫、截图和 trace 命令见
[PARITY_HARNESS](docs/implementation/PARITY_HARNESS.md)。

## electerm 上游

`.gitmodules` 将 [electerm](https://github.com/electerm/electerm) 固定在
`vendor/electerm`。Axterm 复刻固定基线的用户可观察功能、交互和视觉结果，并按
本项目的 Application/Adapter/Contract 边界重新实现；上游全局状态、业务 IPC、
无界缓冲和隐式 SCP 回退不会进入本项目。来源记录见
[UPSTREAM](docs/implementation/UPSTREAM.md)，决策见
[ADR-003](docs/adr/ADR-003-electerm-parity-program.md)。

## 许可证

Axterm 自有代码采用 [Apache License 2.0](LICENSE)。`vendor/electerm` 是独立 Git
子模块，继续适用其自身的 [MIT 许可证](vendor/electerm/LICENSE)。
