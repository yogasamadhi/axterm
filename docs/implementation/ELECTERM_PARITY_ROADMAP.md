# Electerm 5.5.0 复刻实施路线

> 文档类型：可执行实施路线  
> 状态：Active  
> 更新日期：2026-09-14  
> 固定基线：`vendor/electerm@799bedef98c1deae676ae03041719de98d3b57f1`（Electerm 5.5.0）  
> 产品验收：[ELECTERM_PARITY_SPEC](../product/ELECTERM_PARITY_SPEC.md)  
> 逐项台账：[ELECTERM_PARITY_MATRIX](ELECTERM_PARITY_MATRIX.md)  
> 当前证据：[STATUS](STATUS.md)

## 1. 这条路线要交付什么

目标是用 Axterm 自己的技术栈复刻固定 Electerm 5.5.0 基线的桌面端。复刻范围不只
是页面外观，还包括功能、信息架构、交互、键盘路径、配置结果、加载/空态/失败状态、
断线恢复以及 macOS、Windows、Linux 安装包行为。

Axterm 保留自己的品牌和架构。Electerm 的代码、测试和运行结果是行为依据；实现代码
进入 Axterm 对应层，不能把 Electerm 的 Renderer 状态、业务 IPC、`original-fs`、
无界缓冲或隐式 SCP 回退带进产品。每个借鉴点都记录到
[UPSTREAM](UPSTREAM.md)。

固定基线只有通过新 ADR 才能改变。开发中不得静默跟随 Electerm 默认分支。

## 2. 使用 Axterm 技术栈怎样复刻

| 层           | Axterm 实现                                                                                                            | Electerm 参考怎样进入本项目                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer     | React 19、TypeScript strict、Tailwind CSS v4、shadcn/ui、TanStack Query、Zustand、xterm.js、CodeMirror                 | 复现布局、控件、状态、菜单、快捷键、拖放和反馈；业务数据只通过生成 Client、SSE 和 Binary WebSocket 获取。                                         |
| Core Runtime | 独立 Electron `utilityProcess` / Node Headless 入口、Hono、Zod/OpenAPI、SQLite/Drizzle、Application Service 和 Adapter | 重写 Electerm 的会话、文件、传输、自动化和 AI 行为；Runtime 是业务和 SQLite 事实源，不 import Electron。                                          |
| Desktop Host | Electron Main、Host Capability REST、Runtime supervision、File Grant、Native Dialog、Updater、External URL Validation  | 承接确实需要桌面权限的能力；Main 与 Renderer 之间不增加业务 IPC。                                                                                 |
| 凭据         | application-local Host Credential Vault，业务库只保存 `credentialRef`                                                  | 本地保存密码、密钥口令和 API Key；不探测、不调用、也不提示使用系统钥匙串、Credential Manager、Keyring、Secret Service 或 Electron `safeStorage`。 |
| 数据通道     | REST/JSON/OpenAPI、fetch SSE、Binary WebSocket、HTTP/FS/SFTP stream                                                    | 按数据类型选择边界；终端字节不进 React/Zustand，大文件不走 Base64 JSON。                                                                          |
| 验收         | Vitest、Playwright、真实 PTY/SSH/协议 fixture、三档截图、打包应用测试                                                  | 上游应用、测试和默认设置提供预期结果；Axterm 测试证明等价行为、资源释放和平台结果。                                                               |

默认首次窗口为 **1440×900**。视觉对照同时覆盖 1280×800、1440×900、1920×1080；
稳定截图相似度至少为 95%（差异不超过 5%），固定边缘差不超过 4 CSS px；主要控件重叠、
文字/操作裁切、不可读、菜单/对话框越界、方向错误、焦点断裂或关键操作不可达均直接失败。

## 3. 当前进度

截至 2026-09-13：

- Phase 0–9 的基础架构和常用桌面能力已在 macOS arm64 验收。
- Phase 10 的打包配置及 macOS arm64 证据已完成；旧 schema 到当前版本的 SQLite/
  应用本地 Vault 升级旅程已通过。Windows x64、Linux x64 和签名测试频道证据仍 open。
- Phase 11 的固定基线、50 个场景、122 项矩阵、72 项设置映射、23 项动作映射、三档
  截图与视觉差异工具已完成。
- 72 项设置映射现为 50 Implemented、22 Partial、0 Missing，23 项动作全部 Implemented。
  最后七个设置已接入启动会话、代理、外部编辑器、xterm 无障碍与 SFTP 行为；普通冷启动
  默认只创建一个本地终端，显式启动会话可替代该默认值，Electerm 数据导入会在事务内重映射
  短 Bookmark ID。
- Phase 12 已完成标签、布局、工作区、空态和窗口偏好等主干实现；依赖后续协议、文件、
  Widget、主题、同步和三平台证据的行仍未认证。
- 当前生产 Electron 全量桌面回归为 65/65 可运行旅程通过，另有 1 条 Docker SSH 路径
  在该调用中按条件跳过并由独立 `test:ssh` 覆盖；无障碍 2/2、万级书签性能 1/1 通过。
  回归收口修复了全窗口设置中的 AI Inspector 无可见目标，以及 SSH 书签新建→编辑时
  跳板链/隧道组件 key 冲突造成的重复控件与重复 DOM id。
- Phase 13 已完成嵌套书签、搜索/拖放、连接/命令历史、Profile、SSH Config 导入、
  Electerm 数据导入导出和 SSH 表单主干；非 SSH 表单及后续标签页仍 open。
- Phase 12–21 的固定视觉现在组成 48 个场景、144 张三视口
  对照；全部通过 95% 相似度门禁，最差相似度为 95.089%。每张 Axterm 截图还通过
  7 项硬伤检查，共 1008 项通过。Phase 18 新增 Quick Command、Trigger、Terminal
  Information/Monitor 和 Static File Server Widget 成对实景，区间为 95.089%–98.460%；
  Phase 19 六个设置场景为 95.428%–97.143%；Phase 20 Provider、Chat、Agent 和 MCP 为
  95.340%–98.452%；Phase 21 三个认证 UI 场景为 96.444%–99.410%，其中真实 SSH 断线重连为 98.931%–99.410%。
  `ssh.authentication` / `ssh.network` /
  `ssh.tunnels-sftp` 以 96.641%–98.354% 的三档相似度覆盖真实 SSH 书签认证、
  Settings 网络与隧道面；`settings.themes` 覆盖 312 套内建主题、搜索、分页、
  创建和颜色编辑；`terminal.addons-settings` 的 compact/reference/wide
  相似度为 96.396% / 96.645% / 97.154%，T14-VIS-03 已关闭；macOS `.app`/DMG/ZIP、
  PTY、SQLite 和真实 SSH 打包证据通过。C-16 已由 Phase 17 的终端传输协议工作关闭。
- Phase 15 的 D-01–D-12 已全部完成实现。D-06 ProxyCommand 至 D-11 隧道体验已完成实现。真实三节点
  Docker OpenSSH 覆盖跳板、算法接受/拒绝、末端 SFTP、启动标记、X11 远端请求到本地
  display 的数据管道、三类隧道及逆序逐级清理。D-12 的 256 MiB SFTP/交互终端并发和
  32 个活动传输上限证据也已通过。D-01 的认证选择、MFA 密码自动应答和连续挑战也已
  实现；D-02 证书/平台 Agent、D-03 Host Key 管理面与 D-04 真实网络故障重连闭环也已实现。Phase 15 的 D-01–D-12 已全部进入 Implemented。Phase 16 的 E-01 双面板至 E-18 原生文件操作均已实现。Phase 17 F-01 FTP/FTPS 至 F-08 Deep Links 与 C-16 ZMODEM/XMODEM/trzsz 已进入 Implemented。
- Phase 18 G-01 Quick Command tree 至 G-12 Command-line entry 已进入 Implemented；
  H-01 Settings navigation 与 H-02 Settings inventory closure 已实现，
  **Phase 19 H-03 Terminal themes**、**H-04 Theme scope/background**、**H-05 Shortcut editor**
  、**H-06 Global visibility hotkey**、**H-07 Window behavior** 与
  **H-08 Settings/password import/export**、**H-09 Selected-category sync** 与
  **H-10 GitHub/Gitee/WebDAV/custom providers** 已实现；**H-11 Localization** 已完成
  15 语言/410 键资源、持久即时切换、fallback、RTL 和全部 Renderer surface 的目录接入，
  包括 Shell、应用编排、终端、主机与协议表单、书签隧道、启动脚本、跳板链、文件管理、
  传输冲突和权限编辑；AST 门禁已将未目录化的直接 CJK 字面量从 2,495 降至 0。固定
  三档 LTR/RTL 的 Electerm/Axterm 截图与 trace 已在 macOS arm64 采集。设置框架在
  RTL 下保持与 Electerm 一致的物理位置，同时让阿拉伯文内容按 RTL 排版；六张专项截图
  相似度为 96.660%–97.143%，全部通过 95% 数值门禁以及控件重叠、文字裁切、可读性、
  视口边界、双向排版、键盘焦点和关键操作七项硬伤门禁。复制后的 macOS arm64 安装包也已
  在受限 PATH 下通过 English 即时切换、冷启动持久化、Arabic RTL 和物理左侧活动栏检查；
  当前继续补 Windows/Linux 安装包证据；**H-12 Updater** 已完成默认禁用、Ed25519
  签名清单、有界流式下载、进度、取消、失败、重试和安装包交接；正式 HTTPS 源、生产签名
  和三平台二进制升级保持 open；
  Phase 20 I-01/I-02 的 Provider 配置、连接测试和三种流式格式，以及 I-03 的持久聊天
  会话/历史主链、I-04 终端选区解释、I-05 命令/脚本审核、I-06 结构化书签审阅保存、
  I-07 AI 主题预览/编辑/保存、I-08 Agent Tool Card 完整生命周期、I-09 安全文本附件和
  I-10 MCP Server/Widget 已经实现；Phase 21 的 J-01–J-03、J-06、J-08–J-10 已完成实现。
  J-09 已通过万级书签/目录/传输历史、64 MiB 终端流和生产 Electron DOM 上限门禁。
  J-04/J-05 已定义平台工作流，因当前无可达 Windows/Linux 执行器而按阻塞登记；J-01 已用
  31 分 27 秒、1812 轮零违规和独立最终清理证据完成当前 30 分钟目标。macOS DMG 独立安装门禁已经固化并通过，
  余下队列为需要外部 Windows/Linux 主机、生产签名或正式更新频道的发行证据。
  Phase 16–21 尚未完成认证。

当前 122 项矩阵为：**1 Certified、116 Implemented、5 Partial、0 Missing**。
72 个上游设置已经全部登记，当前为 50 Implemented、22 Partial、0 Missing；最终数量以
当前 `parity:audit` 产物为准。23 个上游默认动作已经全部登记，
23 个固定动作现已全部进入 Implemented。登记完成只代表差距不会丢失，不代表功能已经完成跨平台认证。
`Implemented` 表示代码和自动化行为已存在；只有功能、交互、视觉、配置、故障与所需平台
证据全部齐全，才可改为 `Certified`。

## 4. 每个矩阵项的固定实施步骤

每个功能按下面的垂直切片完成，不能只做界面或只做 API：

1. **锁定参考行为。** 运行固定 Electerm 基线，阅读对应组件、服务、默认设置和上游测试，
   在矩阵行记录菜单、键盘、拖放、正常状态和失败状态。
2. **建立验收场景。** 在 `electerm-scenarios.json` 增加或细化 route/state/menu/modal；需要
   视觉验收时先采集三档基线截图和交互 trace。
3. **设计 Axterm 边界。** 明确 Renderer、Runtime、Desktop Host 的 owner。公共资源先改
   Zod/OpenAPI Contract 和生成 Client；新进程边界、数据库或安全策略先写 ADR。
4. **实现 Runtime 纵向能力。** Domain/Application 不依赖 Hono、Drizzle 或 vendor object；
   Adapter 承接协议库；队列、流、监听器、计时器和连接都有容量、owner、取消和 cleanup。
5. **实现 Host 能力。** 只有原生对话框、File Grant、应用本地 Vault、外部链接、通知、
   更新和窗口能力进入 Desktop Host，并通过认证的 `/host/v1` 暴露。
6. **实现 Renderer 交互。** 复现 Electerm 的信息层级、尺寸、菜单、快捷键、焦点、反馈、
   错误与恢复路径；终端字节和 secret 不进入 UI 状态仓库。
7. **补齐证据。** 添加单元/Contract/Runtime/真实 fixture/Desktop E2E；覆盖成功、取消、
   重试、断线、权限、冲突、重启和资源释放；需要的平台必须在打包应用中验证。
8. **对照验收。** 在三个固定视口运行截图差异，检查像素、几何、键盘和可访问性；不得
   为通过比较扩大 mask 或放松阈值。
9. **更新台账。** 同步矩阵、`STATUS.md`、`UPSTREAM.md`；依赖变化更新 `VERSIONS.md`；
   最后运行 `bun run check`。证据不完整时保持 `Partial` 或 `Implemented`。

### 阻塞登记与 99% 交付线

遇到外部平台、证书、硬件或可复现技术障碍时，不反复停在原任务：先在 `STATUS.md` 的
Blocker Register 记录任务 ID、Matrix 行、阻塞原因、最后证据、已完成部分、解除条件和回填
位置，再领取队列中的下一项。工作量大、一次测试失败或尚未实现不算阻塞。

常规目标仍是 122/122。用户接受的实施收口线为严格超过 99%，即至少 121/122 行达到
Certified 或经 ADR 批准的 Not applicable，且最多一个未计入覆盖率的 Blocked 行。该规则
只允许结束实施追赶，不把阻塞行改写为完成，也不豁免架构、安全、数据完整性或正式发行
门禁；Phase 10/21/Desktop 1.0 应在缺少强制平台证据时继续显示 open。

## 5. Phase 11–21 详细路线

### Phase 11 — 对照工具和设计系统（已完成）

1. 固定 Electerm 5.5.0 commit、版本和 reference launcher。
2. 维护 122 项能力矩阵、50 个场景、设置/动作映射和协议 fixture owner。
3. 维护三档截图、动态内容 mask、几何快照、Playwright trace 和像素差报告。
4. 维护颜色、间距、字体、阴影、图标和动效 token，不在业务组件散落临时值。

后续每个阶段都必须继续扩充这套证据；Phase 11 完成不表示产品已复刻完成。

### Phase 12 — Shell、导航、标签、布局和工作区（实现主干，认证 open）

1. A-01/A-02 已完成实现：精确七项活动栏支持选择、排序、持久化、Electerm
   `leftSideBarIcons` 导入导出、全部目标跳转和折叠状态恢复；继续补三平台认证证据。
2. A-03/A-04 已完成实现：新建菜单统一承载本地、保存目标、Terminal Profile 和所有
   Quick Connect 协议路径；继续补固定视觉和打包证据。
3. 完成 A-05 至 A-10 的三平台打包交互证据：标签拖放/焦点/菜单、1–4 pane、命名工作区、
   重启和空态键盘路径。
4. A-11 已完成 Phase 16 文件面板、Phase 17 远程会话和 Phase 18 监控/批量输入集成。
   本地 `Terminal / File Manager` 与远端 `SSH / SFTP` 已作为所属连接标签的二级视图，
   切换时不创建 Files 顶层标签、不改变连接或窗格，并按会话保留模式和内容状态；继续补
   单窗格、多窗格和远程会话的固定视觉/平台证据。
5. A-05/A-06/A-08/A-09/A-11/A-12 已新增复制后的 macOS arm64 安装目录旅程：验证键盘排序、固定/重命名、四窗格、指针调整、最大化/还原、命名工作区、冷重启断开态与 1440×900。前台窗口保持原生全屏；
   macOS 拒绝后台窗口焦点时使用状态可见的 simple fullscreen，避免动作无反馈，并保留两张审阅截图。
6. 关闭 A-12：继续接入 Phase 21 的 Windows/Linux 窗口和安装包证据；这些外部平台项沿用 J04/J05 阻塞登记，不阻断下一阶段本机工作。

完成条件：A-01 至 A-12 全部 Certified。

### Phase 13 — 书签、分组、Profile、历史和迁移（实现主干，认证 open）

1. B-02/B-05 已完成非 SSH 书签的连接、编辑、复制、删除、颜色、描述、分组和协议表单；
   继续补完整导入导出与三平台认证证据。
2. B-11 已把 Quick Commands、Triggers、Tunnel、Hops 接入六标签结构，并让九项协议选择
   全部进入真实表单或会话；继续扩充标签固定视觉和打包证据。
3. 扩展 Electerm 导入导出，覆盖后续设置、主题、工作区和协议数据；保持重复导入收敛、
   可预览、可取消，portable export 不含凭据原文。
4. B-06 已新增真实 Docker OpenSSH 的 macOS arm64 打包旅程：连接历史转书签、冷启动保留、应用本地 Vault 重连和删除后二次重启均通过；继续补 Windows/Linux 证据。
5. 完成书签树、命令历史、Profile、SSH Config 和完整表单的三平台打包证据。

完成条件：B-01 至 B-12 全部 Certified。

### Phase 14 — 终端体验（等待跨阶段依赖）

粘贴路径已对齐 Electerm 的 xterm 输入方式，并增加保守的 Shell 续行识别：格式化管道可直接
作为一条命令粘贴，普通多命令、脚本、注释、here-document 和非 Shell 会话保持原文；模型测试
与真实 Electron/node-pty 回归均已覆盖。

1. **T14-11 / C-11 会话日志：** 已实现 File Grant 选址、追加写入、保存近期内容或从当前
   时刻录制、可选时间戳、录制状态、停止和退出清理；补固定截图与跨平台打包证据。
2. **T14-12 / C-12 重连：** 已实现默认关闭的持久化自动重连/重载恢复设置、只在曾经连接
   成功后启动的有界重试、参考倒计时 overlay、立即重试、取消与计时器执行前的开关复核；
   同 generation 内可一次性恢复有上限的 xterm 画面和已校验 cwd，generation 变化立即丢弃。
   网络断开、应用重载、休眠恢复、固定截图和三平台打包证据仍待 Phase 14/21 认证。
3. **T14-13 / C-13 快捷键栏：** 已实现上游默认按钮/顺序、持久显示开关、触摸软键盘检测、
   44 px bar、收起/重开、横向 overflow、候选搜索、增删/重置、拖动与键盘排序、自定义两个
   修饰键，以及按 xterm DECCKM 向活动 pane 的 Binary WS 显式发送。固定截图、物理触屏和
   Windows/Linux 打包证据仍待 Phase 14/21 认证。
4. **T14-14 / C-14 命令建议：** 已实现默认关闭的持久设置、OSC 633 提示符限定、80 ms
   刷新、历史频次排序、严格前缀去重、光标定位/上下翻转、历史删除、Escape、方向键选择、
   只补齐不执行、32 项缓存/失效，以及经 Runtime Provider 显式触发和可取消的 AI 建议。
   Phase 18 已在真实 Batch/Quick Command aggregate 落地后接入预留来源；命令建议专项截图与 Windows/Linux
   打包证据继续 open。
5. **T14-15 / C-15 文件拖放：** 已实现 ask/upload/path-insert 持久设置、活动终端 drop target、
   浏览器文件到 Desktop Host 临时 File Grant 的认证流、400 px 决策框、SSH 当前目录上传和
   本地临时路径插入。32 文件、单文件 4 GiB、批次 8 GiB 有界；危险名称、目录、取消、
   无 SFTP、generation 轮换和一小时授权清理都有明确结果。真实 SSH drop-upload、固定截图与
   Windows/Linux 打包证据继续 open。
6. **T14-16 / C-08：** 已实现全局默认 Terminal Profile、失效引用回退和
   会话显式选择 → 书签 → 全局默认 → 平台默认的统一优先级；Windows/Linux 打包按键、
   单词选择与固定视觉证据继续 open。
7. Phase 19 H-04 已完成 C-10 终端背景；Phase 17 已完成 C-16 Zmodem/Xmodem/trzsz。
8. 当前固定视觉为 144/144 通过，最低相似度为 95.089%；`terminal.addons-settings` 三档差异为
   3.604% / 3.355% / 2.846%，即相似度 96.396% / 96.645% / 97.154%。全部 Axterm
   截图的 1008 项硬伤检查通过，T14-VIS-03 已关闭。`ssh.authentication` 三档为
   97.834% / 98.071% / 98.354%，`ssh.network` 为 97.346% / 97.652% / 97.975%，
   `ssh.tunnels-sftp` 为 96.641% / 96.847% / 97.705%；Phase 17 的协议表单和终端传输场景
   为 95.642%–98.935%；Phase 18 四个场景为 95.089%–98.460%；Phase 19–21 新增场景为
   95.340%–99.410%。Manifest 中 48 个 `capture: true` 场景已经全部有三视口证据；真实 SSH 断线与自动重连、
   AI Chat 取消与部分输出保留均已有独立场景，Windows/Linux 安装包状态继续在 J-07 收口。

完成条件：C-01 至 C-15 全部 Certified；C-16 在 Phase 17 认证。

### Phase 15 — SSH、代理、跳板和隧道

1. 对齐密码、私钥、口令、证书、Keyboard Interactive/OTP 和平台 SSH Agent 表单与挑战
   状态；凭据只进入 application-local Vault。
2. 完成 Unknown/Changed Host Key 的指纹、主机身份、记住/拒绝和管理界面。
3. 完成 timeout、keepalive、compression、reconnect 的设置应用和真实网络故障状态。
4. 完成 global/session HTTP、HTTPS、SOCKS5 代理以及 ProxyCommand 的验证、错误、取消和
   进程清理。
5. 完成可排序多级 jump chain、循环校验、算法/Host Key/cipher 覆盖、启动目录、环境、
   login/run scripts 和 X11。
6. 将本地/远程/动态隧道接入书签表单和参考状态面板，验证端口冲突、断线重试和退出清理。
7. 用多节点真实 SSH fixture 验证认证、代理、跳板、SFTP 并发与三类隧道。
8. **D-06 已实现：** ProxyCommand 使用结构化 executable/arguments，必含 `%h`/`%p`，
   `shell: false` 启动；进程失败、取消、stderr 上限和 owner cleanup 已由单元、Electron
   表单及真实 Docker OpenSSH relay 验证。跨平台打包和固定视觉留在认证队列。
9. **D-07 已实现：** 目标书签保存最多八级有序 Host 引用，编辑器支持增删、上下重排和
   路径预览；旧单跳数据兼容读取。三容器 OpenSSH 拓扑验证两次 `forwardOut` 与末端 SFTP，
   清理按目标到首跳串行执行，避免压缩通道并发关闭。
10. **D-08 已实现：** 保存并按顺序应用 KEX、cipher、server Host Key 和 HMAC 偏好；空列表
    继续使用 ssh2 默认值。Contract、迁移重启、Adapter 参数、Electron 编辑器及 Docker
    OpenSSH 允许/拒绝协商矩阵通过。
11. **D-09 已实现：** 保存启动目录、受限环境变量及两组最多 16 项的脚本/延迟。Runtime 在
    Shell Integration 后通过同一个 256 KiB 输入队列依次写入环境、登录脚本、转义后的目录
    和连接后脚本，并沿用会话编码；队列溢出会关闭新会话。迁移、编辑器、顺序/转义及真实
    OpenSSH 启动标记通过。
12. **D-10 已实现：** 书签显式启用并保存本地 DISPLAY；ssh2 Adapter 仅接受本机 display
    编号或 socket，先探测端点，再无 shell 地读取有界 xauth 结果。每条 SSH 连接只持有一个
    X11 listener，最后一个 X11 终端关闭即销毁全部双向 socket。Docker OpenSSH 已验证远端
    X11 请求的数据实际到达本地 fixture。
13. **D-11 已实现：** 已保存书签的 Ssh tunnel 标签和全局隧道中心共享同一组带 ETag
    的本地/远程/动态 Profile，支持创建、编辑、删除、启动和停止，并显示 Host、绑定地址、
    实际临时端口、目标与实时状态。端口冲突和 SSH 断开保留可查看、可清除的失败状态；所有
    listener、channel 和 socket 都按 SSH owner 或用户停止确定性释放。Runtime 单元、Electron
    CRUD/断开门控测试和真实 Docker OpenSSH 三类转发回归通过；固定视觉、自动重连后重启及
    Windows/Linux 打包证据留在认证队列。
14. **D-12 并发证据已实现：** 真实 Docker OpenSSH 在同一 SSH transport 上保持 256 MiB
    SFTP 上传处于 running 时，既有 PTY 的非回显标记往返低于 1.5 秒，随后核对完整字节数并
    删除远端文件。每个传输独占 SFTP channel、单任务最多四个文件流，全局活动任务上限为
    32；容量单元测试验证第 33 个请求得到类型化失败，shutdown 后 owner 数归零。固定 UI
    联动视觉和 Windows/Linux 打包负载证据仍留在认证队列。
15. **D-01 已实现：** Password、PrivateKey/Certificate 与 Profiles 选择均进入真实保存路径；
    MFA/OTP 以 Keyboard Interactive 模式保存本地 Vault 密码引用，重开不回显。Runtime 只对
    单一隐藏 Password challenge 自动应答，后续 OTP/多因素挑战逐次显示带序号、目标身份和
    字段的交互框。ssh2 认证调度在 partial success 后重置可选方法，真实 ssh2 fixture 已通过
    Password challenge → OTP challenge，Docker 密码链路也保持通过。
16. **D-02 已实现：** migration 16 保存独立证书引用及 Agent enabled/path；书签表单通过
    application-local Vault 保存私钥、口令和 OpenSSH v01 证书，并通过 Runtime REST 探测
    Unix socket、Pageant 或 Windows named pipe。Runtime 可组合密码、私钥、证书和 Agent
    回退，建连前校验证书结构及签名私钥完全匹配。真实 ssh2 证书握手、Unix socket、Contract、
    Repository 重启和 built Electron 状态/重开测试通过；Windows/Linux 打包 Agent 与固定视觉
    证据继续 open。
17. **D-03 已实现：** Unknown 对话框展示目标、算法和 SHA256 指纹；Changed 对话框以高风险
    样式同时展示旧/新指纹、拦截风险，并要求显式核对后才能替换。版本化 known-key REST
    资源及 Common 设置面列出首次/最近核对时间，可用 If-Match 撤销并写入审计事件；Repository
    并发与 built Electron 列表/撤销测试通过。固定三视口和跨平台打包证据继续 open。

完成条件：D-01 至 D-12 全部 Certified。

### Phase 16 — 文件管理器、编辑器和传输中心

1. 将本地文件面嵌入本地会话的 `Terminal / File Manager` 二级标签，将 SFTP 面嵌入对应
   SSH 会话的 `SSH / SFTP` 二级标签；侧栏、传输中心、命令面板和终端 cwd 入口统一定位
   到所属会话，不创建独立顶层文件标签。建立本地/远程双面板、split mode、跟随终端路径、
   地址历史/书签、父目录、刷新、过滤、隐藏文件、排序、列配置、分页和 10k 目录虚拟化。
   本地终端和本地文件面在没有显式覆盖时都从系统用户主目录开始；SSH 文件面通过 SFTP
   `realpath('.')` 从远端账号主目录开始。文件地址栏显示并接受绝对目录路径，切换本地目录
   时替换 generation-bound Grant，实际操作继续使用相对路径载荷。
2. 完成多选、键盘、上下文菜单、新建、重命名、删除、剪切/复制/粘贴、路径复制、chmod、
   文件信息和 native reveal/open-terminal。
3. 完成 local↔remote、remote→remote、递归目录和双向拖放，并允许 Finder/Explorer 的普通
   文件直接拖入当前远端目录后开始队列上传；不默认跟随符号链接。
4. 完成交互式重名决策、apply-to-all、队列、速度、总进度、暂停/恢复、取消、重试、清理和
   可控历史；所有数据保持 streaming。
5. 对齐内部小文本编辑、新文件、版本冲突、系统编辑器 watch、文本/二进制比较以及
   compress-and-transfer；临时文件、watcher 和 channel 确定性清理。

当前实现状态：E-01 至 E-18 均已进入 Implemented。`files.browse-operate`、
`files.transfers` 和 `files.edit-inspect` 已在三档视口驱动 Axterm 与固定 Electerm，使用
同一个一次性 Docker OpenSSH/SFTP 目标和授权本地目录。双面板浏览最低 95.213%，真实
128 MiB 流式传输与传输中心最低 95.171%，远程文本编辑最低 96.513%；九张候选图的
63 项硬伤检查全部通过。Windows/Linux 安装包和剩余故障注入仍属于认证证据。

完成条件：E-01 至 E-18 全部 Certified。

### Phase 17 — FTP/Telnet/Serial/RDP/VNC/SPICE/Web 和终端传输协议

1. 逐个建立独立 Adapter、Contract、Profile/Bookmark 表单和真实 fixture：FTP/FTPS、Telnet、
   Serial、RDP、VNC、SPICE、Web。
2. 接入协议特有设置：Telnet prompt、Serial 线路参数、RDP domain、VNC/SPICE 画质/缩放/
   view-only、Web user-agent 和导航限制。
3. 完成 Deep Link/Quick Connect 协议路由、错误反馈和打包应用生命周期。
4. 实现 Zmodem、Xmodem、trzsz 双向传输、取消、超时、背压和临时资源清理。
5. 新 native module、代理进程或信任边界必须先写 ADR，再进入打包矩阵。

当前子项状态：F-01 FTP/FTPS 至 F-08 Deep Links 已实现。Web 使用 ADR-011 定义的 Desktop Host
`WebContentsView`，保留 sandbox/webSecurity 并通过 Runtime REST 管理书签、地址栏、导航、缩放、
弹窗拦截、显式外部打开、瞬时 Basic Auth、多窗格几何与确定性清理；Deep Link 使用 ADR-012
定义的独立 generation ingress token、内存队列和 REST/SSE 领取路径，覆盖启动参数、macOS
`open-url` 与 second-instance，并将验证后的非 SSH 目标送入对应协议表单。SPICE/Web 的真实
服务与固定视觉、Deep Link 的安装协议激活以及三平台包仍属于认证证据。C-16 使用 ADR-013
定义的 Runtime 协议 Adapter、File Grant 选择、无路径状态、等待超时/缓冲上限和临时文件提交；
XMODEM 双端二进制 fixture 及 ZMODEM/trzsz 分片识别已通过。真实 `rz`/`sz`/`trz`/`tsz`、
连接/失败视觉和 Windows/Linux 打包证据仍属于认证工作。macOS arm64 固定 corpus 已加入
FTP、Telnet、Serial、RDP、VNC、SPICE、Web/Deep Link 七个真实配置表面及 XMODEM 传输中
状态，共 24 组三档对照。七类表单相似度为 95.642%–97.513%；XMODEM 场景通过真实
Runtime 认证、256 KiB File Grant 流式导入和本地 PTY CRC 握手推进到传输中，三档相似度为
97.933%–98.935%。进入协议编辑时保留 Electerm 风格的书签目录与协议上下文；关闭或保存回到主工作区，
保存并连接则进入真实会话。Phase 18 G-01 至 G-12 已完成实现，下一项为 Phase 19 H-01。

完成条件：F-01 至 F-08 和 C-16 全部 Certified。

### Phase 18 — 快捷命令、自动化、监控、Widget 和 CLI

1. 完成 Quick Command 文件夹、搜索、拖放、模板、多行、书签分配和 Insert/Send 两条路径。
2. 完成多终端 Batch Input 和多书签 Batch Operation，限制并发，提供逐目标日志、取消和总结。
3. 完成跨输出 chunk 的 Trigger engine、ANSI stripping、once/repeat/cooldown，以及有序的
   login/run scripts。
4. 完成 Terminal Info 和 Remote Monitor bar/detail：主机、uptime、CPU/历史、内存、网络、
   用户、磁盘、活动和进程；poller 共享、有上限且隐藏/断线即停止。
5. 完成 Widget 生命周期、local file/FTP/SSH server 和 CLI/deep-link action；绑定地址、授权、
   owner、审计和关闭状态明确。

当前子项状态：G-01 至 G-12 已完成实现。G-05 的 Runtime Trigger engine 使用 64 KiB
有界流窗口，支持跨 chunk ANSI/CR/CRLF 处理、文本/正则、once/repeat/cooldown、通知和
显式发送；全局规则有独立 ETag 聚合，书签规则随 Bookmark 持久化并只绑定到该书签创建的
Terminal。全局/书签编辑器、Electerm 导入导出、规则隔离、事件脱敏、触发上限和清理测试
均已落地。G-06 将书签的登录/连接后脚本扩展为 Runtime 有序状态机：Shell 集成就绪后按
环境变量、登录脚本、启动目录和连接后脚本执行；每项可配置延迟、发送方式、输出静默等待
和超时，关闭或替换会取消后续步骤。启动期间到达的用户输入留在有界队列，序列完成后才
释放，真实 Docker OpenSSH 和生产 Electron 编辑器测试已通过。G-07 通过 Runtime 固定只读
命令与已建立 SSH 连接提供 system、uptime、CPU/历史、memory、users、network、disks 和
activities；按组 TTL、并发 2、64 KiB 输出、5 秒超时、64 会话缓存、60 点历史和列表上限
约束资源。Renderer 的可筛选侧栏只在可见且会话 ready 时轮询，并完整呈现
ready/stale/unsupported/error。纯解析/缓存、真实 Linux Docker OpenSSH 和生产 Electron
Save-and-Connect 测试已通过。G-08 增加默认关闭、SSH-only 的 28 px 监控栏，九类项目的
顺序和显示开关经 Runtime Settings 持久化。监控栏与信息面板共享 Query key 与 Runtime
采样缓存，提供阈值状态、CPU 曲线、hover/focus/click 固定详情、Escape、断线反馈、关闭和
跳转完整信息；终端几何、详情、配置及 SQLite 重启证据已通过。G-09 至 G-11 增加
Runtime-owned Widget catalog 和八实例上限、运行实例管理、详细通知、两阶段 File Renamer、
Static File Server，以及真实 FTP 和 SSH/SFTP Server。所有目录能力先取得 generation-bound
Desktop File Grant；默认 loopback，连接、端口、路径、handle、stream 和输出均有上限并由
Runtime shutdown 确定性清理。FTP/SSH 密码只在启动请求和实例内存存在。真实 basic-ftp、
ssh2、HTTP、Runtime generation 与生产 Electron 测试已通过。由于目录授权随 generation
失效，重启后要求用户重新选目录，不复制 Electerm 绕过授权的 auto-run。G-12 在 root
launcher 和 Electron Main 共用有界命令行语义，覆盖直接 URL、连接选项、本地 cwd、SSH
环境/私钥/SFTP-only、single/second-instance/new-window 和 grant-scoped Batch Operation。
命令行秘密保持瞬时；`--server-port` 因 Runtime loopback + OS-assigned port 不变量明确拒绝；
Electerm 工作流中的绝对路径 SFTP action 要求改由文件工作区取得授权。纯解析/转换/授权测试
和生产 Electron 启动、第二实例、多窗口、批量 action 测试已通过。Phase 19 H-01 的六类设置
导航、搜索、键盘焦点、Vault 安全元数据和持久地址掩码也已通过生产 Electron 验证。H-02 的固定
72-key 生成审计已经以 zero-unmapped/zero-missing 通过；启动书签/工作区、代理开关语义、
外部编辑器、屏幕阅读器、SFTP 自动刷新/跟随目录/默认分栏均已有持久化设置、实际行为和
针对性桌面回归。H-03 的迁移 29、主题 CRUD/预览/导入导出与生产
Electron 往返已经通过。H-04 的实时预览、会话/全局作用域、文字/图片/filter 与重启恢复也已通过生产 Electron。H-05 的 23 项 Action Registry、平台默认组合、键盘/滚轮捕获、冲突检测、Runtime 持久化和实际命令分发已通过 Contract、重启及生产 Electron 测试。H-06 的 Desktop Host 全局显隐热键、冲突保持、关闭、重启恢复和真实 Electron 注册测试已通过。H-07 的窗口即时偏好、bounds 重启恢复、多实例和退出确认已通过生产 Electron。H-08 的便携设置、窗口偏好与凭据元数据导出、差异预览、ETag/快照冲突、补偿回滚、无重复回导和 Vault 不变性已通过 Application 与生产 Electron 测试。H-09/H-10 的八类数据快照、比较、手动/自动同步、可恢复下载预览、应用本地 Vault、GitHub/Gitee Gist、WebDAV/custom provider 与冲突处理已通过单元、真实 loopback WebDAV 和生产 Electron 测试。H-11 已完成本地化基础和全部 Renderer surface 的目录接入；AST 门禁已将未目录化的直接 CJK 字面量从 2,495 项降至 0。macOS arm64 的三档 LTR/RTL 对照证据相似度为 96.660%–97.143%，六张均通过 95% 数值门禁与七项硬伤门禁；下一项是补齐 Windows/Linux 安装包本地化认证。
H-12 已在 Desktop Host 落地签名更新源，生产 Electron 通过真实 loopback 清单和流式制品验证
检查、进度、取消、重试、ready 与安装交接；无 Provider 时仍不联网并准确显示 disabled。

完成条件：G-01 至 G-12 全部 Certified；MCP Widget 在 Phase 20 关闭。

### Phase 19 — 设置、主题、同步和本地化

1. 将固定 `default-setting.js` 的 72 个键逐项落到设置、明确例外或矩阵项，最终 missing 为零。
2. 对齐设置导航、Terminal Theme CRUD/preview/import/export、背景图片/文字/filter 和全局/
   会话作用域，由此关闭 C-10。
3. 建立完整 Action Registry、快捷键编辑和冲突检测，完成全局窗口显隐热键。
4. 补齐 title bar、opacity、zoom、multi-instance、多屏 bounds、退出确认和启动默认标签。
5. 完成设置/凭据元数据导入导出、分类选择、比较、手动/自动同步以及 GitHub/Gitee gist、
   WebDAV/custom server Adapter。凭据值继续只保存在本地 Vault。
6. 建立语言资源覆盖、运行时切换、fallback 和三档布局回归。
7. 更新源缺省保持 disabled；配置后校验签名清单和制品，提供检查、进度、取消、失败、重试
   与安装交接，正式源和生产签名留给发行认证。

完成条件：H-01 至 H-11 全部 Certified，设置映射 missing 为零。

### Phase 20 — AI 和 MCP

1. 对齐 Provider endpoint/model/role/proxy 配置和连接测试，实现 OpenAI Chat、OpenAI
   Responses、Anthropic 三种流式格式。
2. 完成聊天会话/历史、终端选择解释、建议/缓存、脚本、附件预览和用户显式发送上下文。
3. 实现 AI 创建书签和主题的结构化审阅/编辑/预览后保存流程。
4. 对齐 Agent Tool Card 的参数、等待审批、执行、输出、取消、失败和重试状态。
5. 实现 MCP server/widget 生命周期；所有工具仍经 Application Service、Risk Policy、
   exact-args Approval 和 Audit，不直接调用协议 vendor object。

完成条件：I-01 至 I-10 和 MCP Widget 行为全部 Certified。

### Phase 21 — 可靠性、可访问性、性能和发行认证

1. 建立 30 分钟混合负载和独立验证器，验证终端、协议、文件、传输、监控、Widget 和 AI
   资源上限。既有 31 分 27 秒运行及独立最终清理回归已满足目标，用户明确要求不再重跑。
2. 覆盖网络断开、休眠/恢复、Runtime crash/generation 轮换、迁移失败和磁盘错误；修改操作
   不因重连被静默重放。
3. 定义并验证 10k 书签树、10k 目录、长时间终端输出、大文件和大传输队列的响应预算。
4. 完成键盘、焦点、screen-reader label、对比度和 reduced-motion 审计。
5. 完成所有 route/state/menu/modal 的三档视觉 corpus 和人工几何审查。
6. 在 macOS arm64、Windows x64、Linux x64 安装包中运行完整 golden journey；完成旧版本
   升级、SQLite/Vault 保留、原生模块、签名接入点和更新测试源验证。
7. 运行完整架构、Contract、secret leak、依赖、ASAR 和 `bun run check` 门禁，关闭所有差异。

完成条件：常规目标为 122 项全部 Certified 或有审核通过的 Not applicable。实施交付可在
至少 121/122 且唯一剩余行已完整登记为 Blocked 时收口；Phase 10 未关闭时，Phase 21 的
正式发行认证仍保持 open。

## 6. 从现在开始的执行队列

后续工作按以下顺序领取，除明确的跨阶段依赖外不跳项：

1. Phase 16 的 E-01 至 E-18 已经完成实现。
2. Phase 17 F-01 FTP/FTPS 至 F-08 Deep Links 与 C-16 Zmodem/Xmodem/trzsz 已完成实现。
3. Phase 18 G-01 Quick Command tree 至 G-12 Command-line entry 已完成实现。
4. 对已实现行补交互、故障、三档视觉和可取得的平台证据；客观阻塞按 Blocker Register
   登记后领取下一项。
5. 按 Phase 19 → 20 → 21 推进，并在后置能力落地时回填
   Phase 12/13/14 的依赖行。

Phase 20 当前已完成 I-01 至 I-10 的实现和自动化行为证据；I-08 已覆盖只读结果、精确参数
审批、拒绝、过期、重放、取消、Runtime 中断和真实 PTY 命令；I-09 已覆盖 50/100 KiB 限制、
UTF-8/二进制校验、脱敏预览、File Grant 即时撤销、移除、取消、过期、显式发送和仅元数据历史，
I-10 已覆盖 loopback/Bearer/Origin、MCP 初始化与会话、工具枚举、只读结果、修改审批、实时实例
状态和确定性关闭。三项均保存 1440×900 证据。J-02 也已覆盖断网/恢复、原生休眠唤醒、
Runtime SIGKILL/generation 轮换、恢复提示、手动会话重连和不自动重放修改，并保存
1440×900 证据。J-03 的七个安装包黄金状态、真实 SSH/SFTP 和重启持久化已通过；J-06
已验证 0.9.0/schema 31 到当前版本的数据与应用本地 Vault 保留。J-04/J-05 平台证据按
Blocker Register 暂停；J-07 Manifest 的 48 个可视场景、144 张三视口截图已全部通过，J-08
键盘/可访问名称/模态焦点/减少动态效果门禁也已通过。J-09 已量化 10k 书签树、10k
目录、64 MiB 终端流和 10k 传输历史，并由生产 Electron 验证 DOM 上限。J-01 已按
30 分钟目标完成认证。macOS DMG 已通过校验、挂载、独立复制、卸载后启动和
完整 packaged 旅程；J-07 余下 Windows/Linux 平台证据按 Blocker Register 保持 open。H-12 已用真实签名 loopback 源覆盖检查、进度、
取消、重试、哈希/签名失败和安装交接；最新复制后的 macOS arm64 应用也已通过完整签名
更新旅程，并验证本机安装包路径不会进入 Renderer。各行的官方
客户端交叉验证与三平台安装包证据继续留在认证队列中。

J-01 的生产 Runtime 混合负载入口现已落地：Domain Event 默认保留最新 10,000 条，未声明
更小上限的幂等操作默认保留 2,000 个收据；macOS arm64 的 60 秒真实 OpenSSH 冒烟完成
60 轮终端/SFTP/传输/隧道/Widget/MCP 组合负载且所有临时 owner 归零。该结果只确认 harness
与资源清理可用。首次正式运行在 506 轮后暴露 node-pty 的 macOS 原生 PTY 描述符泄漏；
系统上限为 511，依赖代码没有关闭每次 spawn 的第一个保护描述符。Axterm 已补原生
count/close 下标、应用层 destroy/exit 等待和 Node/Electron ABI 可重复构建。修复后的 100 ms
加速轮廓通过 729 轮、364 次传输、243 次隧道和 145 次 MCP，最终 owner 全部归零。
第二次正式轮廓于 `2026-09-14T00:21:19.745Z` 启动，运行 31 分 27 秒，完成 1812 轮、
906 次传输、604 次隧道、362 次 MCP 且零违规；最后检查点也超过 30 分钟。正常结束的
729 轮加速回归和 60 秒冒烟提供最终 owner 全部归零证据。用户将目标固定为 30 分钟，
确认现有组合证据已经足够并明确要求不再运行。持久认证记录保存在
`docs/implementation/evidence/J01-30M-CERTIFICATION-2026-09-14.json`，J-01 已标记 Certified。
macOS 安装包的本机可执行发行证据也已完成，余下发行认证依赖已登记的外部平台和签名环境。

T14-11/C-11 至 T14-16/C-08 的实现、Contract、客户端生成、自动化测试和
文档记录已经收口；固定视觉、真实故障、物理触屏与三平台认证证据继续保持 open，并在
Phase 14/21 的证据矩阵中补齐。

任何 disabled 控件、占位页面、只有 mock 的流程或只在开发模式工作的能力都不能算完成。
Windows/Linux 实机不可用时登记具体阻塞并保持对应证据 open，继续做不依赖该平台的下一项；
达到 121/122 可以报告 99% 实施交付，Phase 21 正式发行认证和桌面 1.0 仍必须等待三平台与
升级证据。

## 7. 文档和证据的职责

| 文件                                             | 职责                                                       |
| ------------------------------------------------ | ---------------------------------------------------------- |
| `docs/architecture/MASTER_SPEC.md`               | 架构、安全、通信边界和总阶段定义的最高事实源。             |
| `docs/product/ELECTERM_PARITY_SPEC.md`           | “1:1”的产品范围、允许差异和验收规则。                      |
| `docs/implementation/ELECTERM_PARITY_ROADMAP.md` | 要做什么、依赖顺序、每阶段步骤和当前领取顺序。             |
| `docs/implementation/ELECTERM_PARITY_MATRIX.md`  | 122 个用户可观察能力的 owner、状态、差距和证据。           |
| `docs/implementation/STATUS.md`                  | 已完成代码、测试结果、平台证据和仍 open 的事项。           |
| `docs/implementation/PARITY_HARNESS.md`          | reference launcher、场景采集、截图、trace 和视觉比较操作。 |
| `docs/implementation/UPSTREAM.md`                | Electerm 来源、许可证、本地目标和行为改写记录。            |
| `docs/implementation/VERSIONS.md`                | 固定依赖、原生模块和打包策略。                             |

出现差异时，先服从 `MASTER_SPEC.md` 的架构与安全不变量，再按
`ELECTERM_PARITY_SPEC.md` 确定产品结果，最后在 Matrix 和 Status 中记录实际证据。
