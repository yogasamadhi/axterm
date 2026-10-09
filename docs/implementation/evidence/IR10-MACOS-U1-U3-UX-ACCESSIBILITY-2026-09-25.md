# IR-10 / W-10-02 / U1–U3：Mac 紧凑窗口 UX 与无障碍工程交接

日期：2026-09-25。范围是当前 macOS arm64 **无签名**目录包及同源码 Electron；不代表人工无障碍、设计/商标、签名发行或 Windows/Linux 原生验收。

## 当前制品和可复核命令

- 源码构建：`bun run build`。当前目录包：`/tmp/axterm-u3-release-review.2YD40C/mac-arm64/Axterm.app`；`Contents/Resources/app.asar` SHA-256：`3c743cbb8a902a62a1d0b19c695764fa88fab9fc122e1c930d1492adec99ed2f`。Playwright 将应用复制到隔离目录，以新 user-data 启动实际 Host/Runtime。
- `bunx playwright test --project=visual -g 'P-07 gives empty panes|P-07 U1 keeps Shell navigation|P-07 U2 keeps Settings'`：三档视口空窗格基线及 1280×800 物理窗口、200%（CSS 640×400）Shell/设置/弹窗验证；定向运行 3/3。完整视觉/无障碍检查由本轮 `bun run check` 最终记录。
- `AXTERM_PACKAGED_APP=/tmp/axterm-u3-release-review.2YD40C/mac-arm64/Axterm.app bunx playwright test --project=packaged -g 'packaged macOS Shell and Settings remain bounded|packaged macOS keeps all four languages and Settings categories bounded|packaged macOS U3 keeps compact Shell'`：同一当前包 3/3。涵盖三档物理视口、四语言设置分类 200%、U3 空窗格/主机侧栏/连接编辑/传输浮层/设置页的键盘聚焦和 axe-core WCAG 扫描。
- U3 包内截图保存在本地忽略目录 `test-results/packaged-evidence/`：`macos-u3-empty-panes-200-percent.png` SHA-256 `9800ffd65a8db5ffc9f33ecf3f093f7527cdf82560931ede915ac82c4792b49a`；`macos-u3-settings-200-percent.png` SHA-256 `44ce0e48f564491a74c1c147391b085bb1c006f5720091a862dd8148b0843846`。前者显示窄四窗格可独立滚动；后者显示顶部设置标签单行横向滚动且关闭按钮与标签分离。截图是本机生成证据，不是签名发行素材；测试脚本可重建。

## 本批修复与验证范围

| 格                   | 实际发现和修复                                                                                                                                                                                                                                                                 | 验证边界                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1 Shell、导航、空态 | 主机侧栏标题小字对比度不足；四窗格在 200% 时空窗格内容高于可用区域却被 `overflow: hidden` 裁切。改用语义化文字色、`safe center` 与窗格自身纵向滚动。空窗格改为按窗格编号唯一命名的 `region`、连续的二级标题；空书签树不再暴露没有 `treeitem` 的 `tree`，改由状态文案报告空态。 | 1280/1440/1920 的现有 Axterm 截图基线、1280×800/200% 的键盘聚焦与每个空窗格操作可视、包内 axe-core 扫描。                                                                        |
| U2 设置与弹窗        | 传输浮层摘要/空态文字对比度不足；设置关闭目标原为 16×16；终端设置的一级标题被 `display:none` 排除于无障碍树，下一标题跳级；顶部设置标签在 200% 时换行拥挤。改为对比度合格的语义色、28×28 点击目标、屏幕阅读器可见的一级标题与连续标题层级、单行横向滚动标签。                  | 1280×800/200% 的设置分类、连接配置、SSH 弹窗、传输中心；键盘可达、关闭后焦点恢复、axe-core WCAG/对比度、标签首尾可滚动聚焦和关闭按钮无重叠。已有四语言/Host Key 旅程不重复计数。 |
| U3 当前包            | 以上修复从当前源码重新打包，三条相关包内旅程在**同一** `app.asar` 上通过，含四语言设置页、三档物理视口、200% 紧凑窗口、reduced-motion 0.01 ms 上界和截图人工目视核对。                                                                                                         | 无签名 macOS arm64；不外推已签名、公证或 Windows/Linux。                                                                                                                         |

## 结论与人工交接

U1、U2、U3 的 **Mac 工程验收格通过**；这是连续批次的 3 格增量。W-10-02 仍需独立人工无障碍审查人具名签收，W-10-01 仍需产品/品牌设计签收，W-10-03 仍需用户在 Windows/Linux 原生包上复核；IR-10 仍为 In progress。此记录关闭 **0 个 W 项**、接受 **0 个 IR 门禁**。

请人工审查人用当前包和上述两张截图复核：200% 下四窗格的滚动与键盘顺序、主机/设置分类读屏名称、连接弹窗的焦点进入与关闭恢复、顶部设置标签横向滚动、传输中心空态与 reduced-motion。记录审查人、日期、设备/读屏器、接受或整改决定及问题链接；自动 axe-core 和目视检查不能代签。若提出缺陷，回到 W-10-02 修复，并在最终包字节变化后复测受影响场景。
