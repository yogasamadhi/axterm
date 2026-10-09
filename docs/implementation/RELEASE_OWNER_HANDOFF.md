# Axterm 独立发行：负责人交接清单

状态：**交接准备完成；不构成任何 IR 项的验收或发布批准**  
2026-09-26 当前商业脱钩已按[清理计划](COMMERCIALIZATION_CLEANUP_PLAN.md)顶部
三项完成线留证；[ADR-022](../adr/ADR-022-commercial-release-mac-acceptance.md)
与 [MCR-01～04](MINIMUM_COMMERCIAL_RELEASE.md) 留作以后首次商业发行的共同源码/权利、
公开渠道与 Mac 正式包完成线。Windows/Linux 是兼容目标，原生测试
由仓库所有者在对应电脑自行完成，**不阻断后续首次 Mac 发行任务**，但未回传结果前
不得称两平台已验收。自动更新首版采用真实公开手动更新路径，生产 feed
留待后续；`release:minimum-commercial:check` 是后续 Mac/manual-update 诊断入口，旧 `release:final-public:check` 仍按完整三平台/自动更新条件阻断，不能伪造 active。下列逐文件、
62/260 包和正式服务交接是**完整三平台路线的历史详细台账**，不是当前任务
必须逐格盖章的清单；以后领取 MCR-01～04 时只处理实际进入新源码/Mac 包的风险。
2026-09-25 历史更新：ADR-021 取消公开迁移期；本清单按首次公开版立即移除旧兼容入口交接。技术与商业脱钩后来完成，独立商业发行的其余签收另行领取。当时四语言核心目录为每语言 **2,542** 键。
2026-10-03 OP-04 增加五项传输恢复说明，当时目录每语言 **2,547** 键。
2026-10-03 OP-02 增加十八项命令面板说明，当时目录每语言 **2,565** 键；来源/译文审校仍 pending。
2026-10-03 OP-03 增加输出安全上限恢复说明，当时目录每语言 **2,566** 键；来源/译文审校仍 pending。
2026-10-03 OP-05 增加九项设置分组与恢复说明，当时目录每语言 **2,575** 键；来源/译文审校仍 pending。
2026-10-03 OP-07 增加十八项 AI 请求检查文案，当时目录每语言 **2,593** 键；来源/译文审校仍 pending。

2026-10-05 原生目录拖放增加两项核心文案，当时目录每语言 **2,595** 键；来源/译文审校仍 pending。
2026-10-05 Pi 厂商配置增加五项核心文案，当时目录每语言 **2,600** 键；来源/译文审校仍 pending。
2026-10-06 AI 标签工作区增加五项核心文案，当时目录每语言 **2,605** 键；来源/译文审校仍 pending。
2026-10-06 AI 模式与技能增加七项核心文案，当时目录每语言 **2,612** 键；来源/译文审校仍 pending。
2026-10-09 命令自动审核增加三项核心文案，当前目录每语言 **2,615** 键；来源/译文审校仍 pending。
即时移除决定已进入 `MIGRATION_RELEASE_RECORD.json` v2；`migration:record:removal-check`
现已通过。2026-09-25 的完整三平台最终公开检查为 **14/23 通过、9/23 阻断**；当时剩余阻断是
具名审查、正式服务和更新源。
依据：[ADR-016](../adr/ADR-016-independent-open-source-product.md)、[商业化清理计划](COMMERCIALIZATION_CLEANUP_PLAN.md)、[独立发行矩阵](INDEPENDENT_RELEASE_MATRIX.md)  
当前技术状态：[STATUS](STATUS.md)

2026-09-25 最终公开晋级门禁的实跑仍是**预期阻断**，不是发行失败后的例外批准：
`bun run release:final-public:check` 在 23 项前置检查中通过 14 项、阻断 9 项，
并按设计跳过最终源码快照扫描。阻断项按实际负责方交接：

| 负责方                     | 本次仍阻断的门禁                                                                                                                                  | 解锁所需事实                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 发布/支持负责人            | `release:services:active-check`、`release:updater-feed:active-check`                                                                              | 上线并批准实际隐私、安全、支持渠道及 HTTPS 更新源、公钥；不能把本地夹具或未来日期写成 active。                                   |
| 权利/源码/原生/WASM 审查人 | `licenses:attribution:reviewed-check`、`licenses:native:reviewed-check`、`licenses:ironrdp:review:reviewed-check`、`source:review:reviewed-check` | 分别审定 10 项缺声明队列、62 项 macOS native 源码/二进制、260 项 IronRDP 源码/WASM 和当前 958 个准备快照文件；只按具名证据晋级。 |
| 品牌/语言审查人            | `assets:marks:reviewed-check`、`locales:navigation:reviewed-check`、`locales:core:reviewed-check`                                                 | 对五个产品标识素材及四语言导航/核心目录作具名权利、品牌、译文和可访问名称审定。                                                  |

这九项是**晋级门禁**而非另外九个 W 任务。旧兼容入口已按 ADR-021 移除；
通过前置门禁后还必须通过最终快照扫描、最终安装包和三平台发布复核。
工程人员不能代签、伪造 reviewed/active 或为让数字变化而提前移除兼容入口。

2026-09-24 平台分工：先完成 macOS arm64 的本地工程验证；Windows x64 和
原生 Linux x64 的真实安装、协议及升级验证由仓库所有者到对应平台执行，不因
macOS 通过而自动通过。当前 macOS 无签名 DMG 已完成挂载/复制、包内许可证与
SPDX、23 项适用 packaged 旅程、受控 OpenSSH fixture 和历史源码包升级验证，
见[当前候选记录](evidence/IR13-MACOS-UNSIGNED-CANDIDATE-2026-09-24.md)。
macOS 的正式签名、公证、公开 HTTPS 更新源、真实旧版安装升级、网络/可移动卷
协议运行及来源权利签收仍是单独的发布门禁；当前不能称为 macOS 商业发行完成。
同一候选在真实 FAT16 卷的硬链接拒绝下通过三种协议的包内往返测试；ExFAT
只能安全拒绝落盘、不能宣称成功传输，见[当前真实卷记录](evidence/IR03-CURRENT-MACOS-REAL-VOLUMES-2026-09-24.md)。
剩余的是公开签名旧版本、用户数据及 SMB/NFS 等更广范围的验证，不能把一次
FAT16 成功外推到这些场景。

2026-09-25 最新交接：M1 Mac 工程细格已 **14/14**；[当前无签名包的
APFS/FAT16/ExFAT 强杀恢复与原子发布矩阵](evidence/IR03-ADR020-OWNED-STAGE-RECOVERY-2026-09-25.md)
通过，旧段落的“网络/可移动卷仍未验证”只代表 2026-09-24 候选，不再代表本轮
候选。W-06-02/W-08-02 的[未公开旧 Axoterm 包→当前 Mac 包手动迁移证据](evidence/IR08-HISTORICAL-PACKAGE-UPGRADE-2026-09-23.md)
现包含完整冷备份恢复、两套自建主题、已移除内置主题回退、原图片手动重选、
密码重填入新 Vault、损坏文件与晚期写入回滚；包内限定旅程 1/1 通过。所有者
已批准这条首次公开版的手动迁移**范围**，但仍须由发行负责人具名签收该证据
及其不覆盖的任意旧主题/图片、签名、其他平台和真实旧公开用户边界；W-06-02/
W-08-02 暂不勾选，IR-06/IR-08 不因 Mac 工程通过而 Accepted。
四语言迁移提醒随后又在新建无签名 Mac 目录包中随同旧包手动迁移及迁移页
无障碍扫描通过 **2/2**，当前 `app.asar` SHA-256 和具体范围见
[同一证据](evidence/IR08-HISTORICAL-PACKAGE-UPGRADE-2026-09-23.md)；这不改变
具名签收、签名公证或用户 Windows/Linux 原生验收要求。

本清单将当前无法由工程脚本代替的工作交给适当负责人。填写记录时只能写入
非敏感证据路径、发布日期、工单号、哈希和审查结论；不得将密钥、token、用户
备份、原始旧数据库或未脱敏 trace 放入本仓库或公开发布说明。

本地[贡献者历史范围核对](COMMERCIALIZATION_SOURCE_AUDIT.md#2026-09-24-local-contributor-history-scope-check)
只发现 10 个可达提交、两种共用邮箱的作者署名；它不能证明两种署名属于同一
权利人，也没有覆盖当前大量未提交的替换内容。权利/法务审查人须取得所有者的
身份与授权依据、审阅最终源码/素材快照及第三方例外，并留存具名结论；未来
贡献规则或 Git 作者字段不能追溯代替这些证明。IR-02 保持 **In progress**。
准备最终源码快照时，先运行 `bun run source:review:generate` 更新
[`AXTERM_SOURCE_FILE_REVIEW_LEDGER.json`](../../compliance/AXTERM_SOURCE_FILE_REVIEW_LEDGER.json)，
由权利审查人逐项填写非敏感来源、许可证、权利人、进入发行物的位置和依据；对受限
合同只写受控回执，不把合同原件公开。文件字节变化会使该项重新待审。最终公开门禁
要求 `bun run source:review:reviewed-check` 全部通过；通过仍不能替代真实性或法律审查。

勾选本清单的某项不自动改变 `INDEPENDENT_RELEASE_MATRIX.md` 的状态。只有负责人
将可复核的证据链接、日期和审查人记录进 `STATUS.md` 或对应 evidence 文件后，才能
由有权人员将 IR 行改为 `Accepted`。`IR-14` 仍是 **Open**，旧 GitHub 仓库也只能由
所有者在所有前置门禁完成后单独处理。

## 负责人顺序

1. **发布负责人**确认 ADR-023 的手动数据退出说明、支持渠道、平台和目标版本；先留存受控旧证据，不能
   先删除旧仓库。
2. **权利/法务审查人**完成来源、版权、商标、字体、主题、第三方和分发义务审查。
3. **语言与产品/品牌审查人**完成简体中文、繁体中文、英文和日文四个语言目录、显著 UI 页面与产品文案的签收。
4. **各平台发布工程师**在 macOS arm64、Windows x64、Linux x64 生成、安装、升级并
   核验实际发行物；发布负责人汇总签名、更新源、哈希和支持材料，并发布经过批准的
   隐私/数据处理、安全报告和支持渠道。
5. 所有前置 IR 行均满足后，**仓库所有者**基于审计后的工作树创建全新 Git 仓库和
   初始提交，配置远程 CI 并复做干净检出验证。不得 mirror-push 旧历史，不得复制旧
   `.git`、子模块、截图/trace 或旧安装包。

## 逐项外部交接

IR-11 现在另有原生 Rust 依赖审查范围：
[`NATIVE_DEPENDENCY_REVIEW_LEDGER.json`](../../compliance/NATIVE_DEPENDENCY_REVIEW_LEDGER.json)
列出 macOS arm64 `fs-safe` 绑定的 61 个锁定源码包和发布二进制，全部仍为
`pending`。权利/发布审查人须逐项记录适用版权与许可证文本在源码、Legal/About
及实际安装包中的处理，并解释本地重建与发布 `.node` 字节不一致的来源关系；
不能仅凭父 npm 包的 MIT 标签签收。普通 `bun run licenses:native:check` 只检查
台账完整性；`bun run licenses:native:texts:check` 验证已随 macOS 包和 About
提供的 111 份原始根文本，但不作适用性判断。晋级前需通过
`bun run licenses:native:reviewed-check`；Windows/Linux 目标图仍需单独证据。
详见[原生源码记录](evidence/IR11-FS-SAFE-NATIVE-SOURCE-2026-09-24.md)及
[macOS 根文本包记录](evidence/IR11-FS-SAFE-RUST-ROOT-TEXTS-2026-09-24.md)。
四个没有自带根许可证文件的 `napi` 包已有独立的
[发布源码与根许可记录](evidence/IR11-NAPI-RS-PUBLISHED-SOURCE-2026-09-24.md)：
`bun run licenses:napi:check` 验证随包文本和依赖范围，但不代替最终审查。
另见[原生 Mach-O 工具链对比](evidence/IR11-FS-SAFE-MACHO-TOOLCHAIN-2026-09-24.md)：
实际安装的 macOS arm64 `.node` 哈希现在受常规检查约束；上游发布文件记录 SDK
15.5/链接器 1167.5，本机 Rust 1.98.1 + SDK 27.0 重建仍未逐字节复现。
签收前须取得匹配工具链的复现或具名的源码到二进制差异结论，不能把行为相同视为权利证明。
另有[官方 npm 来源证明链](evidence/IR11-FS-SAFE-NPM-ATTESTED-PROVENANCE-2026-09-24.md)：
官方 registry 验证了 SLSA 声明，发布 tarball 内 `.node` 与当前 Mac 安装包字节相同，
声明关联到锁定源码提交和成功的发布工作流。发布工程师可对最终 Mac 包重跑
`bun run licenses:native:provenance:macos -- --app <Axterm.app>`。
该结果缩小来源不明范围，但不代替可复现构建、逐文件权利/许可或具名签收。
另有[macOS Cargo 源码范围 SPDX](evidence/IR11-FS-SAFE-MACOS-SOURCE-SBOM-2026-09-24.md)
独立列出锁定的 61 个 Rust 源码包；常规 `bun run sbom:native:macos:check`
检查清单漂移，`bun run sbom:native:macos:artifact-check -- <Resources>
<packaged SPDX sidecar>` 比对最终 Mac 应用的 `.node`、npm 身份和四份补充法律文本。
它不推定 61 个包均链接进二进制，也不代替 62 项具名权利审查。
另有 [原生源码头候选清单](evidence/IR11-FS-SAFE-SOURCE-HEADER-CANDIDATES-2026-09-24.md)：
在 2,157 个代码文件中检出九个包、156 个文件的 156 行版权/SPDX 候选；已与
固定 `.crate` 压缩包或上游提交逐文件比对，并单独纳入
`licenses/fs-safe-SOURCE-HEADER-ATTRIBUTIONS.txt`。`licenses:native:headers:check`
固定清单与文本，发布工程师须核对实际 Mac 包；候选不等于完整来源权利签收。
IronRDP 现另有[面向 WASM 的 Rust 来源清单](evidence/IR11-IRONRDP-WASM-SOURCE-SCOPE-2026-09-24.md)：
锁定的上游 `ironrdp-web` 目标树列出 259 个源码包，已将 470 份可取得的根法律
文本纳入 Mac 包与 About，并有独立来源 SPDX。常规
`bun run licenses:ironrdp:source:check` 检查版本、清单、文本和发布 WASM；
发布工程师还应对最终 Mac 包执行
`bun run licenses:ironrdp:source:artifact-check -- <Resources> <packaged SPDX sidecar>`。
六个 registry crate 缺自带根文本；已另按各自 `.cargo_vcs_info.json` 精确提交
保留 12 份[发布者仓库根原文](evidence/IR11-IRONRDP-MISSING-CRATE-ROOT-TEXTS-2026-09-24.md)
至 `licenses/IronRDP-MISSING-CRATE-ROOT-LICENSES.txt`，并用已发布 crate 的
`src/lib.rs` 逐字节交叉核对。`bun run licenses:ironrdp:missing:check` 是常规
检查；这并不让缺失文本变成 crate 原包内容。嵌套/逐文件声明、双许可证选择、
源码至 WASM 可复现构建及具名权利审查均未签收，不能据此晋级 IR-02/IR-11。
另有 [tracing-core 嵌套声明](evidence/IR11-IRONRDP-NESTED-SPIN-LICENSE-2026-09-24.md)：
已把 `src/spin/LICENSE` 的 Mathijs van de Nes MIT 原文加入包内和 About，
`licenses:ironrdp:nested:check` 固定字节；发布工程师可针对固定 Cargo 缓存和
上游提交运行 `licenses:ironrdp:nested:source-check`。这是文件名扫描与文本保留，
不是已确认该模块链接进 WASM 或已完成逐文件权利审查。
另有 [源码头候选清单](evidence/IR11-IRONRDP-SOURCE-HEADER-CANDIDATES-2026-09-24.md)：
已扫描目标图中 6,958 个代码文件，保留 51 个包、719 个文件中的 798 行版权/SPDX
候选，逐文件与已发布 crate 压缩包或固定上游提交比对；文本单独放在
`licenses/IronRDP-SOURCE-HEADER-ATTRIBUTIONS.txt`，纳入 Mac 包和 About。
`licenses:ironrdp:headers:check` 固定清单和文本，发布工程师还须核对具体包内
文件。候选行不能替代完整源码头、实际 WASM 包含性或具名权利结论。
`IRONRDP_DEPENDENCY_REVIEW_LEDGER.json` 将 259 个候选源码包和发布 WASM
列为 260 项待审，逐项填写审查人、日期、第一手证据、许可/声明处理和结论。
`bun run licenses:ironrdp:review:check` 只核对范围；最终公开发行须通过
`bun run licenses:ironrdp:review:reviewed-check`，不能把随包文本当成签收。
`zstd-sys` 内嵌 Zstandard 的 BSD 风格 `LICENSE` 与 GPLv2 `COPYING` 已按
[嵌套文本证据](evidence/IR11-ZSTD-NESTED-LEGAL-2026-09-24.md) 原样纳入 macOS
法律目录和 About；源码头说明两者为可选许可，并非已选择 GPLv2。
`bun run licenses:zstd:embedded:check` 只核对锁定 Cargo 源码和保留文本；
适用许可选择、实际二进制范围和发行义务仍需具名审查。

| 门禁          | 负责人                                   | 必须完成的外部工作                                                                                                                                                                                                                                                                                                         | 现有工程证据和交接输出                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IR-01 / IR-02 | 产品负责人、权利/法务审查人              | 审核逐文件/包/数据/字体/图标来源、历史贡献授权与 Axterm 商标/营销表述；结论不得由代码相似度或许可证名称推定。                                                                                                                                                                                                              | 受控历史来源审计记录、[THIRD_PARTY_LICENSE_AUDIT](THIRD_PARTY_LICENSE_AUDIT.md)、`LICENSE_ATTRIBUTION_REVIEW_LEDGER.json`；为每项写入具名审查人、日期、第一手依据和结论。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| IR-03 / IR-04 | 协议安全审查人、Windows/Linux 发布工程师 | 审查独立终端传输与 FTP 实现；在真实外部 SSH/FTP 场景和 Windows/Linux 已安装应用上验证超时、取消、路径安全、权限与清理。FTP Widget 是明文协议，只能作为本机便利服务：审查须确认 Contract、Runtime 和 UI 都拒绝 `0.0.0.0`/`::`，并只接受 `localhost`、`127.0.0.1`、`::1`；需要网络共享时只验证独立认证的 SSH Server Widget。 | 现有 Runtime/PTY/Docker/macOS 证据仅为基础；P-03 当前有 Contract/Adapter 拒绝与 source、packaged macOS real-FTP 登录/列表证据，见 [PACKAGING](PACKAGING.md) 和 [IR-12 本地候选证据](evidence/IR12-EPHEMERAL-GIT-CANDIDATE-2026-09-21.md)。仍须保存平台、应用版本、fixture、结果与发行物哈希。                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| IR-05         | 每种语言的合格审校人、产品/品牌审查人    | 审校简体中文、繁体中文、英文和日文的导航目录、2,615 键核心文案、所改可见文本、无障碍名称和用户承诺；不得把 AI 草稿或英语回退当成审校。                                                                                                                                                                                     | [LOCALIZATION_FALLBACK_POLICY](LOCALIZATION_FALLBACK_POLICY.md) 与 `scripts/localization/axterm-navigation-review-ledger.json`、`scripts/localization/axterm-core-review-ledger.json`；每个 `reviewed` 条目必须含独立语言/权利审查人和日期，并在导航目录与核心目录晋级前分别通过 `bun run locales:navigation:reviewed-check`、`bun run locales:core:reviewed-check`。                                                                                                                                                                                                                                                                                                                                                                    |
| IR-06 / IR-07 | 产品设计、品牌与权利审查人               | 审核精选主题的独立来源、旧主题迁移表、图标/字体/图片权利与商标风险；审阅 Shell、导航、设置、弹窗和空态的目标体验。                                                                                                                                                                                                         | [THEME_CATALOG_MIGRATION](THEME_CATALOG_MIGRATION.md)、[PRODUCT_ASSET_PROVENANCE](PRODUCT_ASSET_PROVENANCE.md)、[AXTERM_VISUAL_BASELINE](AXTERM_VISUAL_BASELINE.md)；为当前产品标识素材填写 `PRODUCT_ASSET_REVIEW_LEDGER.json` 并在晋级前执行 `bun run assets:marks:reviewed-check`，另补设计审定和三平台包内资产证据。                                                                                                                                                                                                                                                                                                                                                                                                                  |
| IR-08         | 发布负责人、支持负责人                   | 核准从未公开分发的旧原型退出路径：完整冷备份、旧专属文件拒绝无写入、新 `data-v2/` 与 `vault-v2/` 不读写旧 profile、手动重建主题/连接并重填密码。不得宣称旧原型原位升级、旧便携文件仍能导入或存在公开迁移窗口；未来新 profile 内的升级另行验证。                                                                            | [当前数据退出说明](UNPUBLISHED_PROTOTYPE_DATA_EXIT.md)、[旧发行物可用性审计](evidence/IR08-OLD-RELEASE-AVAILABILITY-2026-09-21.md)、当前 Mac 包新旧目录隔离回归与 `MIGRATION_RELEASE_RECORD.json` v2；发行负责人核风险、用户平台结果并具名签收。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| IR-09         | 发布负责人、支持负责人                   | 首次公开版立即移除旧深链、导入导出、主题文件和同步入口；核当前源码/API/安装包无旧兼容，Axterm 自有路径可用，旧本地行与远端对象原样保全，发行说明准确。                                                                                                                                                                     | [ADR-021](../adr/ADR-021-immediate-legacy-prototype-compatibility-removal.md)、Mac 包回归、三平台结果与最终版本 diff；`migration:record:removal-check` 已验证即时移除决定，`release:final-public:check` 仍须通过其余权利、语言、品牌、服务及最终快照门禁。                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| IR-10         | 产品设计、无障碍和品牌审查人             | 审定 Axterm 自有视觉与交互，并在三平台已安装应用上核验对比度、键盘、焦点、保留语言方向、溢出、弹窗与恢复。                                                                                                                                                                                                                 | [AXTERM_VISUAL_BASELINE](AXTERM_VISUAL_BASELINE.md)、source E2E 与复制到仓库外运行的 macOS directory-app Host Key/共享协议弹窗证据是基础，不替代设计/商标签收、签名安装或 Windows/Linux 证据。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| IR-11         | 权利/法务审查人、发布工程师              | 核查每个最终平台实际安装包的许可证/NOTICE、SBOM 与 About 可访问性；审查 LGPL/MPL、WASM、原生模块、Electron/Chromium、字体和内联资源的发行义务。                                                                                                                                                                            | `THIRD_PARTY_NOTICES.txt`、`AXTERM_PRODUCTION_DEPENDENCIES.spdx.json`、[THIRD_PARTY_LICENSE_AUDIT](THIRD_PARTY_LICENSE_AUDIT.md)；为最终签名制品生成平台 SBOM 和哈希。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| IR-12         | 发布工程师                               | 从待发布源快照的全新 Git 检出执行冻结安装、完整检查、真实协议与 Electron E2E；检查不含子模块和旧引用。                                                                                                                                                                                                                     | `bun run check`、`bun run snapshot:check`、[IR-12 本地候选证据](evidence/IR12-EPHEMERAL-GIT-CANDIDATE-2026-09-21.md)；临时候选不是最终远程仓库证据。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| IR-13         | 各平台发布工程师、发布负责人             | 对 macOS arm64、Windows x64、Linux x64 进行真实安装和升级；完成签名/公证、正式 HTTPS 更新源、认证更新、下载和发布哈希验证。                                                                                                                                                                                                | [PACKAGING](PACKAGING.md)、[SIGNED_UPDATE_FEED](SIGNED_UPDATE_FEED.md)、[最新 Linux x64 已安装包证据](evidence/IR04-FTP-READ-HANDLE-LINUX-DEB-2026-09-24.md)；macOS 使用 `test:dmg:macos`，Linux 使用 `test:deb:linux`，Windows 使用 `test:nsis:windows`。CI 在这些安装测试后、上传前使用 `release:hashes:check` 重新核验实际制品字节，再下载刚上传的安装器与清单、复核字节并保留 `AXTERM_UPLOAD_ROUNDTRIP.<platform>.json`。最新 Linux DEB 候选已在 emulated `linux/amd64` + Xvfb 中完成 APT 安装、版本核验和 23 项适用旅程，但不是原生桌面、launcher/deep-link、外部 SSH、签名或升级证据。最终仍须保存成功远程 CI 的回执，记录原生平台、公开下载后哈希、签名/公证结果、升级来源/目标和测试人；本地模拟与工作流定义不能单独接受 IR-13。 |
| IR-14         | 仓库所有者                               | 验证受控旧证据已保存；从最终审计树创建新根提交、远程 CI、下载和安装器，再决定旧 GitHub 仓库是否删除。                                                                                                                                                                                                                      | [HISTORICAL_REFERENCE_ARCHIVE](HISTORICAL_REFERENCE_ARCHIVE.md) 与最终 IR-12/IR-13 证据；所有者的远程仓库与删除操作不可由本地脚本执行。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Linux x64 的最新本地候选现在有同一审计源码快照的 [已安装 DEB
证据](evidence/IR04-FTP-READ-HANDLE-LINUX-DEB-2026-09-24.md) 和
[AppImage 静态载荷证据](evidence/IR13-LINUX-X64-APPIMAGE-READ-HANDLE-2026-09-24.md)。
后者在仿真容器的直接启动探针中于应用代码运行前失败，不能写成 AppImage 运行通过；
现已在 Linux CI 中加入静态核验后的 AppImage 实际启动门禁，并在下载后重跑、保存带哈希
的 `AXTERM_APPIMAGE_RUNTIME.linux-x64.json` 回执；当前仍无成功的原生 runner 回执，
不能写成运行通过。仍需原生 Linux x64 桌面启动、安装/升级和发布负责人签收。

## 更新源发行配置门禁

IR-13 的发布负责人须在启用自动更新的完整三平台发行前将
[`UPDATE_FEED_RECORD.json`](../../compliance/UPDATE_FEED_RECORD.json) 从 `pending` 晋级为
`active`：填写真实公开 HTTPS manifest URL、Ed25519 SPKI 公钥，以及具名审查人、
日期、依据和批准结论。对应私钥不得进入仓库或发行日志。执行
`bun run release:updater-feed:active-check` 后，还需对三平台实际安装包的
Resources 执行 `bun run release:updater-feed:package-check -- <resources> --active`，
核对 `AXTERM_UPDATE_FEED.json` 与批准记录字节一致，保存公开 HTTPS 下载、签名验证、
签名安装器及真实旧版升级证据。`bun run check` 只验证 pending/active 记录格式；
本地回环夹具和环境变量不能代替公开发行配置。包内 active 公钥与地址不能被
运行时环境变量覆盖。当前记录仍为 **pending**，IR-13 仍为 **Open**。

## 发行服务政策门禁

阶段 4 的隐私数据处理说明、安全问题接收渠道和支持政策使用
[`RELEASE_SERVICE_RECORD.json`](../../compliance/RELEASE_SERVICE_RECORD.json) 作为非敏感事实源。
它与迁移发布记录分开：前者不能决定何时移除兼容入口，后者也不能代替安全、隐私或支持
承诺。常规 `bun run release:services:check` 只保证当前 `pending` 或未来 `active` 记录
没有自相矛盾。后续首次 Mac 手动更新发行须实际发布政策与联系渠道，按 MCR-03～04
保存公开 URL、可用性和所有者批准证据；完整三平台路线另须把可访问的 HTTPS 或
`mailto:` 渠道、具名批准、日期和证据写入此记录，并运行
`bun run release:services:active-check`。

`PRIVACY.md`、`SECURITY.md` 和 `SUPPORT.md` 当前都明确是预发布技术或运营边界，
而非已生效的法律政策、漏洞响应承诺或客服服务等级。任何记录、文档或 active gate
都不替代实际服务是否有人值守、法律审查、签名/更新、安装或迁移验收。

## 即时移除决定记录

仓库所有者已按 [ADR-021](../adr/ADR-021-immediate-legacy-prototype-compatibility-removal.md)
批准首次公开版前直接移除旧兼容入口，因为旧原型从未公开分发。
`MIGRATION_RELEASE_RECORD.json` 为 v2 `immediate-removal-approved`，其中
`publicMigrationRelease` 与 `approvedWindow` 均为 `null`；无需虚构公开日期、
支持窗口或稳定版里程碑。`bun run migration:record:check` 和
`bun run migration:record:removal-check` 验证决定记录；
`migration:record:active-check` 属于已废止的旧路线，不能再当作 IR-08/IR-09 阻断。

决定记录只说明可以**立即移除入口**，不证明旧本地数据库/Vault、远端对象、
用户自建主题已安全保全，也不代替[当前数据退出说明](UNPUBLISHED_PROTOTYPE_DATA_EXIT.md)
的发行负责人签收、三平台回归、来源权利或正式服务门禁。旧记录和字节不得为了
通过名称扫描而删除。

## 最终仓库切换前的复核

在所有发布签收已收集、且由所有者准备最终源快照后，执行以下复核：

1. 在不含旧 `.git`、`.gitmodules`、`vendor/`、安装依赖、构建产物、trace、非示例
   环境文件和 `docs/api/openapi.json` 的目录运行 `bun run snapshot:check`。按 ADR-021
   立即移除旧兼容入口并完成适用审查后，运行 `bun run release:final-public:check`。该组合门禁会在
   一次执行中检查并汇总 `MIGRATION_RELEASE_RECORD.json` 的移除批准、依赖版权归属、产品标识、
   四语言目录和公开服务记录，不会因第一项失败而隐藏后续待办；只有这些前置门禁全部通过时，
   才执行底层 `snapshot:final-public:check`，后者检查整个准备后快照的文件名和字节内容。
   输出必须明确列出阻塞项并说明最终快照是否跳过；没有经批准的历史文档时不得传入例外文件。确有必要保留
   单个 `docs/` 文件时，从 [PUBLIC_SNAPSHOT_EXCEPTION_TEMPLATE.json](PUBLIC_SNAPSHOT_EXCEPTION_TEMPLATE.json)
   复制一份至受控、非公开位置，逐项填写理由、审查人、日期和审批依据，并运行 `bun run
release:final-public:check -- --exceptions /absolute/path/to/approved-record.json`。模板本身不是批准，
   代码、构建脚本、测试、素材或未命中的文档例外均不能通过该门禁。
2. 在该快照上运行 `bun run candidate:check`。它会在自己的临时目录新建本地根提交、
   `git clone --no-local`、运行 `bun install --frozen-lockfile` 与 `bun run check`，并在
   成功或失败后清理自身临时目录；不会写入当前检出或远程。这是复现检查，不能取代最终
   远程 CI。若需保留故障现场，只能由负责人显式运行脚本的 `--keep` 选项，并作为受控
   非公开证据处理。
3. 对每个签名安装器运行平台安装、升级、启动、更新与许可证/SBOM 核验；保存
   不含凭据的测试报告和 SHA-256。
4. 所有者创建新的公开仓库和 CI 后，在新仓库重做第 1–3 步并记录下载链接；只有此时才
   评估旧 GitHub 仓库删除。删除旧仓库不会撤销既有许可，也不会删除已有 fork/clone。

当前三平台 CI 会把未签名候选安装器（DMG/ZIP、NSIS EXE、AppImage/DEB 与可用
blockmap）和每个平台的 packaged SPDX sidecar 分别作为工件上传，供发布负责人
下载复核。各平台安装门禁必须先用对应 sidecar 核对实际安装出来的应用资源，再运行
packaged journeys；目前只有 macOS arm64 在此新增门禁下有实跑证据。它还对每个
候选安装器/归档生成平台和产品版本绑定的 SHA-256 清单；SBOM
覆盖包内资源，而该清单覆盖可分发文件本身。安装器、清单和 SPDX sidecar 上传后，
CI 会把三类工件下载到新的目录重新核验，并单独上传安装器/清单与 SPDX 的两个
round-trip 回执；后者记录下载后 sidecar 的哈希和对应 `app.asar` 的哈希。当前只有
本机候选的 SPDX 校验回执，不能冒充远程 CI 下载证据。回执也不是已发布下载、
签名/公证结论或 IR-13 验收；只有实际远程 CI 产出的回执才是该传输门禁的证据，
发布负责人仍须在最终签名制品和公开下载路径上重新执行本节检查。

任何缺失的签收、真实旧制品、平台安装结果或法律/品牌结论都应保持对应 IR 项为
`In progress` 或 `Open`，而不是通过勾选本文件绕过门禁。
