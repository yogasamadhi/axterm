<p align="center">
  <img src="apps/desktop/build/icon.svg" width="112" height="112" alt="AxTerm logo" />
</p>

# Axterm

本轮与旧参考产品的商业脱钩已有工程验收证据；正式商业发布是后续任务。
产品继续保留 Level 1 架构和已有通用桌面能力，依据
[独立商业发布与脱钩计划](docs/implementation/COMMERCIALIZATION_CLEANUP_PLAN.md)
继续 Apache-2.0 开源，仅保留简体中文、繁体中文、英文和日文及精选内置主题。
当前工程候选使用新源码根和独立数据目录；旧原型不原位升级，详情见
[ADR-023](docs/adr/ADR-023-clean-local-source-root-and-data-profile.md)。后续会对
现有 UI/UX 做有目标的修改和美化。状态与阅读顺序见[项目文档导航](docs/README.md)。
提交新代码或素材前请阅读[贡献与来源授权规则](CONTRIBUTING.md)。

Axterm 是一个 Electron 桌面终端与远程运维工作台。当前 `0.10.0` 已实现
MASTER_SPEC Phase 1–9，并完成 Phase 10 的发行配置与 macOS arm64 本机验收。
Windows/Linux 实机打包和签名测试频道升级尚未验收，因此 Desktop 1.0 仍保持未完成。
实施遇到客观阻塞时会先登记任务、原因、证据和解除条件，再继续后续工作。

## 当前独立发行状态

当前脱钩结论和后续发行边界见[实施状态](docs/implementation/STATUS.md)与
[最小商业发行清单](docs/implementation/MINIMUM_COMMERCIAL_RELEASE.md)，不按旧版本的
复刻完成率或截图相似度计算。macOS arm64 已有本机安装与协议验证记录；
后续正式发行仍缺最终权利签收、Developer ID 签名公证包、公开下载和所有者确认。
Windows/Linux 原生测试待所有者自测；完整三平台路线见
[独立发行矩阵](docs/implementation/INDEPENDENT_RELEASE_MATRIX.md)。

旧原型的来源与对照证据保留在受控的先前仓库，不参与当前构建或未来发布验收。
源码与安装包的名称零命中不替代实际发行内容的权利审查。

2026-10-03 [本地优化九项计划](docs/implementation/LOCAL_OPTIMIZATION_GOAL_PLAN.md)已验收完成。
新命令面板、终端消费窗口、SFTP 恢复、设置组织、AI 上下文确认和资源归属整理已通过
源码与新未签名 Mac 候选复验。使用与恢复见
[操作说明](docs/implementation/LOCAL_OPTIMIZATION_USAGE.md)，制品/测试/条件项见
[OP-09](docs/implementation/evidence/local-optimization/OP-09-2026-10-03.md)。

## 现有基础能力

- 本地终端：多标签、拆分窗格、配置、搜索、链接、复制粘贴和渲染降级；
- SSH：密码、私钥/口令、Keyboard Interactive、Agent、Host Key 和跳板机；
- SFTP：目录与文件操作、递归上传下载、队列、进度、取消、重试和冲突策略；
- 远程文件：2 MiB 以内 UTF-8 文本编辑、版本冲突、原子保存和 chmod；
- 隧道：本地转发、远程转发和动态 SOCKS；
- 工作区：主机/分组、SSH Config 导入、最近连接、快捷命令和命令面板；
- AI：Pi 源码引擎、Pi 内置厂商/模型目录与 models.json 配置、Explain/Generate/Diagnose、流式输出、脱敏上下文、
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

需要 Bun 1.4.x、Node 24.18+（24.x）和 Git。先初始化 Pi 子模块，再安装依赖：

```sh
git submodule update --init --recursive vendor/pi
bun install --frozen-lockfile
bun run dev
```

第三方源码 [Pi](https://github.com/earendil-works/pi) 通过 `.gitmodules` 固定在
`vendor/pi`，常规开发和生产构建都使用该源码。

AI 请求在 Runtime Adapter 中使用 Pi AI/Agent 源码，SDK 与固定目录数据一起编入产品。
构建前必须初始化子模块；`bun run pi:build` 校验源码与目录哈希并离线构建。
独立源码快照包含必要的 Pi 源码和 MIT 许可证，排除 Git 元数据与无关 CLI。
配置、兼容范围和安全边界见 [Pi AI 配置](docs/implementation/PI_AI_ENGINE.md)，
固定提交见 [VERSIONS](docs/implementation/VERSIONS.md)。

历史 1:1 对照工具、参考仓库、截图和 trace 已移至访问受控的外部证据归档，当前工作树
不提供这些命令，也不读取这些材料。本地新 Git 根已建立；以后公开远端仓库与正式包
仍须基于审定的干净检出验收。

最终用户运行桌面安装包时不需要安装 Node、Bun 或 Docker。Docker 只用于开发仓库中
可丢弃的 OpenSSH/SFTP 集成测试对端，不参与应用启动、业务运行或发行。开发 Renderer 固定使用
`127.0.0.1:5173`，Runtime 始终绑定 `127.0.0.1` 的系统分配端口。

`run.ts` 启动的是独立的 **Axterm Dev** 实例。它使用操作系统应用数据目录下的
`Axterm Dev` 子目录、独立单实例锁和 Windows AppUserModelID，因此可以与已经安装的
Axterm 同时运行；开发配置、窗口状态、数据库和本地凭据不会读写安装版的数据目录。

开发启动器会把 Axterm 连接参数转发给 Desktop：

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

| 命令                                          | 用途                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `bun run check`                               | lint、strict typecheck、测试、架构/Contract/本地化门禁、生产构建、Axterm 视觉和可访问性回归                  |
| `bun run test:visual`                         | Axterm 自有三档视口和迁移页面视觉回归；macOS 对比基线截图                                                    |
| `bun run test:a11y`                           | Electron 键盘与可访问性检查                                                                                  |
| `bun run test:e2e`                            | Electron utilityProcess、真实本地 PTY、持久化、崩溃重启与清理                                                |
| `bun run test:performance`                    | 生产 Electron 万级书签树响应、搜索、滚动和 DOM 上限                                                          |
| `bun run test:ssh`                            | digest-pinned Docker OpenSSH、SSH/SFTP/三类隧道                                                              |
| `bun run test:soak:smoke`                     | 运行一分钟真实 SSH/PTY/SFTP/Widget/MCP 混合负载                                                              |
| `bun run test:soak:30m`                       | 仅在明确要求时重新运行 J-01 的 30 分钟资源稳定性认证                                                         |
| `bun run test:soak:verify`                    | 独立校验完整时长、连续检查点、预算、计数和最终资源释放                                                       |
| `bun run package:dir`                         | 为当前平台生成未签名的 unpacked app                                                                          |
| `bun run test:packaged`                       | 独立目录、受限 PATH、Runtime、本地 PTY 和 SQLite 验收                                                        |
| `bun run test:ssh:packaged`                   | 从已打包应用连接 Docker OpenSSH 并验证 SSH PTY                                                               |
| `bun run package`                             | 生成当前平台安装包，不发布                                                                                   |
| `bun run contracts:check`                     | 校验当前 OpenAPI 操作与生成 Client 无漂移                                                                    |
| `bun run licenses:components:check`           | 校验生产依赖组件索引与当前冻结安装图一致，默认 `check` 已包含                                                |
| `bun run licenses:components:generate`        | 依赖变更后重建待审查的组件索引                                                                               |
| `bun run licenses:texts:check`                | 校验生产依赖根许可证原文与当前冻结安装图一致，默认 `check` 已包含                                            |
| `bun run licenses:texts:generate`             | 依赖变更后重建待审查的许可证原文归档                                                                         |
| `bun run licenses:attribution:check`          | 校验缺少机器可读版权声明的依赖人工复核台账，默认 `check` 已包含；并不代替法律审查                            |
| `bun run licenses:attribution:reviewed-check` | 最终公开源码门禁：要求每个当前版权归属复核条目已有合格审查，不接受 `pending` 或 `needs-follow-up`            |
| `bun run licenses:attribution:generate`       | 从当前许可证归档重建台账，并保留范围未变条目的复核字段                                                       |
| `bun run licenses:packaged:inventory`         | 列出实际 ASAR、unpacked 文件和包外许可证文件的哈希                                                           |
| `bun run sbom:packaged -- …`                  | 为一个实际 electron-builder Resources 目录生成平台标识与 ASAR 哈希绑定的 SPDX sidecar                        |
| `bun run release:final-public:check`          | 迁移移除后运行：要求迁移、来源/素材/语言审校及公开服务记录通过，再审计最终公开源码快照；不替代签名安装包验收 |

macOS 未签名本地构建使用：

```sh
bun run package
```

打包脚本固定关闭本机签名身份自动发现，不读取开发者环境中的证书身份。

打包、原生模块、签名接入点、Updater 状态及跨平台验收命令见
[PACKAGING](docs/implementation/PACKAGING.md)。阶段证据和未完成项见
[STATUS](docs/implementation/STATUS.md)，依赖见
[VERSIONS](docs/implementation/VERSIONS.md)。
公开发行前的隐私数据处理、安全报告和支持政策边界见
[PRIVACY](PRIVACY.md)、[SECURITY](SECURITY.md)、[SUPPORT](SUPPORT.md) 与
[发行服务记录](compliance/RELEASE_SERVICE_RECORD.json)；当前记录为 `pending`，不构成公开服务承诺。

首版 1:1 的规格、矩阵和路线图仅作为历史记录保留，不能作为当前开发或发布命令的说明。
新工作以 [独立商业发布与脱钩计划](docs/implementation/COMMERCIALIZATION_CLEANUP_PLAN.md)、
[STATUS](docs/implementation/STATUS.md) 和受控
[历史证据归档记录](docs/implementation/HISTORICAL_REFERENCE_ARCHIVE.md) 为准。

## 独立来源与迁移

当前工作树不包含上游子模块、1:1 对照脚本、参考截图或 trace，也不提供这些旧命令。
受控历史证据与可恢复材料的校验记录见
[HISTORICAL_REFERENCE_ARCHIVE](docs/implementation/HISTORICAL_REFERENCE_ARCHIVE.md)。
当前产品决策和独立发布门槛以
[ADR-016](docs/adr/ADR-016-independent-open-source-product.md)、
[ADR-021](docs/adr/ADR-021-immediate-legacy-prototype-compatibility-removal.md) 与
[独立商业发布与脱钩计划](docs/implementation/COMMERCIALIZATION_CLEANUP_PLAN.md) 为准。
旧 Axoterm/Axterm 安装包从未公开分发，因此不再发布公开迁移版本；旧 SQLite/Vault
数据留在受控备份，新版本不原位升级。Axterm 自有配置格式仍可用，旧远端同步对象
不自动删除或上传。历史迁移指南和记录
仅作旧决策的证据，不是当前技术脱钩门禁。

## 许可证

Axterm 自有代码采用 [Apache License 2.0](LICENSE)。保留的第三方代码、数据和字体
继续适用各自许可证。当前已知来源声明见
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.txt)，它随应用包分发，但尚未覆盖全部传递依赖。
生产依赖根许可证原文另见 [THIRD_PARTY_LICENSE_TEXTS](compliance/THIRD_PARTY_LICENSE_TEXTS.json)，
其中明确列出缺少根许可证文件的包；它不是完整的发行物 SBOM。
独立发行前仍须完成完整的第三方版权和许可审计。
