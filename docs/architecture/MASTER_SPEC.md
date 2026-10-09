# Axterm 桌面端架构与实施规范

> 文档类型：Normative Architecture + Product + Implementation Specification  
> 使用对象：Codex / 开发者 / 架构审查  
> 状态：可直接执行  
> 版本：1.4-transition
> 日期：2026-09-20
> 初始架构等级：Level 1  
> 当前状态：依据 ADR-016 与商业化清理计划，本轮商业脱钩已有三项工程验收证据；ADR-022 的 Mac 正式包验收属于后续实际发行任务。保留三平台兼容目标及 Level 1、安全和已承诺的通用能力。
> 后续目标：Headless Runtime / Web / Expo 57 Mobile / Extension Ecosystem  

---

# 0. Codex 执行规则

本文件是 Axterm 桌面架构、安全边界和交付质量的主事实源。Codex 开始工作前必须完整阅读
本文件和根目录 `AGENTS.md`。**ADR-016 已取代 ADR-003 的 Legacy Prototype 1:1 产品目标**；
当前工作顺序见 `docs/implementation/COMMERCIALIZATION_CLEANUP_PLAN.md`，当前状态见
`docs/implementation/STATUS.md`。本文仍保留原 Phase 11–21、95% 视觉阈值和 122 行
parity 描述，作为首版实现的历史依据；这些描述不再是新产品的交付目标或发行门禁。本文
的进程、Contract、安全、数据完整性和资源清理不变量仍然有效，发生冲突时优先于实施计划。

## 0.1 当前交付目标

本轮商业脱钩已按商业化清理计划顶部三项完成线留下工程证据，尚未进行正式商业发布。
ADR-022 定义以后领取首次 Apache-2.0 商业发行任务时的有限完成线：产品维持 macOS、
Windows、Linux 兼容目标；该发行任务在本机验收 Mac 正式包和共同源码/权利门禁，
Windows/Linux 原生测试由仓库所有者在另两台电脑自行完成，不阻断该发行任务，
也不得记为已通过。
完整三平台 Desktop 1.0 的原生验收仍单独开放。Legacy Prototype 5.5.0
曾是快速交付可用首版的固定参考，不再定义后续产品的功能、信息架构或像素相似度。Axterm
保留自己的品牌、Contract、进程边界，以及安全、数据和可靠性承诺；在现有可用 UI 上
进行有目标的体验优化，不要求无意义的全面重写。

已执行的脱钩范围包括替换直接来源代码和数据、解除构建依赖、按 ADR-021 立即移除旧兼容路径、
建立自身设计与验收基线、保留适用的第三方许可声明。后续首发另须完成 Mac 签名/公证/安装验证；Windows/Linux
构建兼容性保持，原生包验证由所有者自测，不得把未验证平台宣传为已通过。仅保留
简体中文、繁体中文、英文和日文四种语言，内置主题精简为来源独立的 Axterm 集合。旧用户的书签、Vault、
自建主题和同步数据不得静默丢失。

当前实施入口按以下顺序读取：

1. `docs/implementation/STATUS.md`：确认商业化清理台账、现有能力和发行阻塞；
2. `docs/adr/ADR-016-independent-open-source-product.md`：确认产品方向和不可绕过的迁移条件；
3. `docs/implementation/COMMERCIALIZATION_CLEANUP_PLAN.md` 顶部：确认本轮脱钩的三项完成线与证据；以后实际领取首次 Mac 商业发行时才按 `docs/implementation/MINIMUM_COMMERCIAL_RELEASE.md` 执行，完整 P-01–P-08 工作包保留为历史及后续台账；
4. 旧 Roadmap、Matrix、Parity Spec 与 `UPSTREAM.md`：按需查看已有行为及来源，不作为新发行验收的唯一标准。

Phase 0–10 和 Phase 11–21 已建立的能力是新产品的起点，不等于商业发行完成。任何单独
页面、API、disabled 入口或仅在开发模式工作的演示都不能代表工作包完成。

Codex MUST：

1. 按 ADR-016、商业化清理计划和 `STATUS.md` 的当前队列推进。
2. 遇到外部环境、不可获得的硬件/证书或可复现的技术障碍，先在状态台账登记任务、原因、已有证据和解除条件，再继续下一项可执行工作。
3. 不得为了快速实现功能破坏 Client / Runtime / Desktop Host 边界。
4. 不得用 Electron IPC 临时替代正式业务 API。
5. 不得让 Renderer 直接访问 Node、Electron、SQLite、Drizzle、`ssh2`、`node-pty` 或 Runtime 内部实现。
6. 不得把 Electron Main 演化成业务 Backend。
7. 每个阶段必须满足新计划的验收标准后才能标记完成；旧 parity 的 99% 阈值不再等于正式发行门禁。
8. 每轮工作结束前运行适用的 lint、typecheck、test、architecture check、build。
9. 依赖 API 因新版本发生变化时，只调整 Adapter/Infrastructure；不得静默改变架构。
10. 任何进程边界、公共 Contract、数据库、凭据、安全策略、AI 执行策略的重大变更必须先写 ADR。
11. 不得新增对 Legacy Prototype 子模块、代码、数据或参考截图的产品/构建依赖；迁移期间保留旧材料时必须准确记录来源与许可。
12. “已实现功能”不得等同于“商业发行就绪”；来源、用户数据迁移、功能、安全、可访问性和平台证据必须分别验证。

完整三平台 Desktop 1.0 只有在第 49 节中仍适用的架构、安全与平台不可豁免条件，以及
ADR-016 的来源、许可、迁移和独立发行门禁同时满足时才算完成。ADR-022 为后续首次
商业发行任务设定 Mac 实测及共同权利/源码门禁；Windows/Linux 自测状态仍须如实
披露，不能由此把三平台原生验收提前标记完成。旧 parity 覆盖率规则仅作历史记录。

## 0.2 目标、实现与状态的职责边界

本项目的目标不是嵌入、换皮或直接运行 Legacy Prototype。首版使用固定参考及部分 MIT 来源的历史
记录保留在 `UPSTREAM.md`；后续按 ADR-016 替换直接来源内容。保留材料在替换之前继续履行
许可证义务，不能用改名、转写或删除 Git 历史代替独立来源证明。

文档职责固定如下，避免同一个状态在多个地方各自演变：

- 本文件定义不可违反的架构、安全和最终交付标准；
- ADR-016 与商业化清理计划定义当前产品目标、工作顺序和完成门槛；
- 旧 `LEGACY_PROTOTYPE_PARITY_SPEC.md`、Roadmap 与 Matrix 保留首版对照证据，状态不再代表新发行完成度；
- `STATUS.md` 是当前实施、测试和平台证据的实时摘要。

阶段编号本身不是完成证据。Phase 0–10 的底座验收、单个 API 可用、页面看起来相似或入口
已经显示，都不能替代新计划的逐项验收证据。

---

# 1. 产品定位

## 1.1 产品愿景

当前产品目标是用 TypeScript-first 的 Axterm 技术栈交付独立、可长期演进的桌面终端产品。
固定 Legacy Prototype 5.5.0 的 1:1 对照是首版实现方法，不是后续定位。AI 是 Axterm 安全执行
模型的一部分，不能取代终端、连接、文件、协议、自动化、设置和桌面集成的真实能力。

首版已实现的以下通用桌面能力，应作为迁移期间的功能回归基线：

- 本地终端；
- SSH；
- SFTP；
- SSH Tunnel；
- Jump Host；
- 主机/书签管理；
- 多标签页；
- 文件传输；
- 快捷命令；
- RDP/VNC/SPICE/FTP/Serial/Telnet/Web 等会话；
- 主题、同步、触发器、批量操作、远程监控、Widget、AI 和 MCP。

后续验收针对 Axterm 自身的功能结果、任务可用性、错误恢复和桌面平台行为，不再以相对
Legacy Prototype 的像素相似度判断。Axterm 继续采用独立 Runtime、正式 HTTP Contract、严格类型、
明确生命周期和 AI 一等能力。旧 1:1 定义仅见归档的 `LEGACY_PROTOTYPE_PARITY_SPEC.md`。

## 1.2 产品核心差异

本项目不是“把 Legacy Prototype 的 `.js` 改成 `.ts`”，而是使用自身架构复现同等产品行为。核心实现差异是：

1. Electron Main 仅作为 Desktop Host；
2. 独立 Hono Core Runtime 才是业务 Backend；
3. Renderer 是纯 Client；
4. TypeScript + Zod + OpenAPI 构成正式 Contract；
5. 普通业务用 REST，事件用 SSE，Terminal 用 WebSocket，文件用 HTTP Stream；
6. SQLite + Drizzle 作为 Local-first 事实源；
7. AI 直接理解终端上下文，但通过 Tool + Policy + Approval 执行操作；
8. 未来 Desktop/Web/CLI/Mobile 可共享同一 Runtime Contract。

## 1.3 AI 的产品定位

AI 不是独立聊天页面，也不是 Terminal 旁边随便嵌一个 ChatBot。

AI 应直接服务于终端场景：

```text
解释命令
解释错误
生成命令
分析当前主机
诊断服务
读取必要的终端上下文
提出可执行操作
通过审批后执行受控 Tool
```

产品在没有配置 AI Provider 时必须完整可用。

---

# 2. Desktop 1.0 交付范围

Phase 0–10 已经建立以下架构与常用功能底座：

- Electron 桌面应用；
- React 19 Renderer；
- Tailwind CSS v4；
- shadcn/ui；
- 本地 Terminal；
- SSH Terminal；
- 密码认证；
- 私钥认证；
- 私钥 Passphrase；
- Keyboard Interactive；
- SSH Host Key 校验；
- Jump Host；
- Host / Group 管理；
- Terminal Tab；
- Split Pane；
- xterm 搜索/复制/粘贴/resize/link；
- SFTP 浏览；
- 上传/下载；
- mkdir/rename/delete；
- Transfer Queue；
- Quick Commands；
- Terminal Profiles；
- Local / Remote / Dynamic SSH Tunnel；
- SQLite + Drizzle；
- Desktop Host Credential Vault；
- Runtime Crash/Restart；
- OpenAPI 与生成 Client；
- AI Provider / Model 配置；
- Explain Command；
- Explain Output；
- Generate Command；
- Diagnose；
- AI Agent Run；
- AI Tool Risk / Approval；
- 日志与诊断；
- macOS / Windows / Linux 打包 Smoke Test。

以上列表是当前可复用的底座。原 Legacy Prototype 5.5.0 的 122 项范围和第 48 节 Phase 11–21
是首版 1:1 实施记录，不再是新产品的完成计数。Desktop 1.0 现按 ADR-016、商业化清理
计划以及第 49 节中仍适用的架构、安全与三平台发行条件验收；工作包和当前顺序以
`COMMERCIALIZATION_CLEANUP_PLAN.md` 与 `STATUS.md` 为准。

---

# 3. Phase 0–10 历史非目标与当前范围

下列能力在 Phase 0–10 建设底座时没有提前实现：

```text
Cordis
Plugin Kernel
Plugin → Bundle → Profile
第三方插件
Extension Host
Marketplace
云账号体系
多人协作
默认公网 Remote Runtime
Mobile Direct SSH
RDP
VNC
SPICE
FTP
Telnet
Serial
Zmodem/trzsz
默认持久化 Terminal History
无人值守自动破坏性 Agent
Runtime 崩溃后恢复原 SSH Shell
```

其中 RDP、VNC、SPICE、FTP、Telnet、Serial、Zmodem/trzsz 和 MCP 已由 ADR-003 纳入 Phase 11–21 Legacy Prototype 复刻计划；它们不再是整个产品的非目标。Plugin Kernel、第三方插件、Extension Host、Marketplace、云账号、多用户协作、默认公网 Runtime、Mobile Direct SSH 和无人值守破坏性 Agent 仍不在复刻范围。

任何新增能力都不得改变 Client / Runtime / Host 宏观边界。

---

# 4. 架构等级

本项目从 Level 1 开始。

Level 1 的含义不是“低级”，而是：

```text
单一产品
官方维护功能
小团队/单团队
普通模块
显式依赖注入
独立 Runtime
无 Plugin Kernel
```

只有真实出现多业务域、多团队、Profile、复杂模块生命周期、服务/事件/路由注册治理等需求时，才升级 Level 2。

只有真实出现第三方插件生态，并愿意承担 Permission、Trust、Sandbox、Compatibility、Distribution、Rollback 等成本时，才升级 Level 3。

不得“为了先进”提前 Plugin Everything。

---

# 5. 最高级架构不变量

所有实现必须遵守：

```text
Desktop / Web / CLI / Mobile Client
              │
              │ REST / JSON / SSE / WS / HTTP Stream
              ▼
       Independent Core Runtime
              │
              │ Versioned Host Capability API
              ▼
          Desktop Host
```

不变量：

1. Client 不是 Runtime。
2. Electron Main 不是业务 Backend。
3. Renderer 不使用 Electron IPC 调用业务能力。
4. Core Runtime 不 import Electron。
5. Runtime 可以 Headless 启动和独立测试。
6. Runtime 是业务持久状态和运行工作流事实源。
7. Desktop Host 仅拥有宿主和原生能力。
8. Vendor Runtime/SDK 不拥有产品业务真相。

---

# 6. “不使用 IPC”的准确规则

本项目采用：

# Zero Business IPC

以下全部禁止：

```text
ipcRenderer.invoke('ssh.connect')
ipcRenderer.invoke('sftp.list')
ipcRenderer.invoke('terminal.open')
ipcRenderer.invoke('settings.update')
ipcRenderer.invoke('ai.run')
```

Renderer 与 Electron Main 之间只允许一个极窄的内部 Bootstrap/Discovery 通道：

```text
desktop:bootstrap
```

它仅用于：

```text
Runtime 当前 baseUrl
Runtime API version
runtimeId
generation
短期 bootstrap token
appVersion
```

它不是业务 API，不得出现 Host、SSH、SFTP、Terminal、AI 等业务动词。

Main ↔ `utilityProcess` 允许使用 Electron 的 process supervision channel，仅用于：

```text
startup envelope
ready handshake
runtime generation
shutdown
crash report
```

也不得演变为业务调用协议。

---

# 7. 最终 Desktop 进程架构

```text
┌──────────────────────────────────────────────────────────────────┐
│                       Electron Desktop                           │
│                                                                  │
│  ┌────────────────────────┐                                      │
│  │ Electron Main          │                                      │
│  │ Desktop Host           │                                      │
│  │                        │                                      │
│  │ App lifecycle          │                                      │
│  │ BrowserWindow          │                                      │
│  │ Menu / Tray            │                                      │
│  │ Updater                │                                      │
│  │ Native Dialog          │                                      │
│  │ File Grants            │                                      │
│  │ Credential Vault       │                                      │
│  │ Host Capability API    │                                      │
│  │ Runtime Supervisor     │                                      │
│  └────────────┬───────────┘                                      │
│               │                                                  │
│               │ utilityProcess.fork()                            │
│               ▼                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                     Core Runtime                           │  │
│  │                                                            │  │
│  │ Hono                                                       │  │
│  │ ├─ REST / OpenAPI                                         │  │
│  │ ├─ Domain Event SSE                                       │  │
│  │ ├─ Realtime SSE                                           │  │
│  │ ├─ Terminal WebSocket                                     │  │
│  │ └─ HTTP File Stream                                       │  │
│  │                                                            │  │
│  │ Application                                                │  │
│  │ Domain                                                     │  │
│  │ Repository                                                 │  │
│  │ Tasks                                                      │  │
│  │ Adapters                                                   │  │
│  │ ├─ ssh2                                                    │  │
│  │ ├─ node-pty                                                │  │
│  │ ├─ Drizzle / node:sqlite                                  │  │
│  │ ├─ AI Provider                                             │  │
│  │ └─ Host Capability Client                                  │  │
│  └─────────────────────────┬──────────────────────────────────┘  │
│                            │                                     │
│                   HTTP / SSE / WS                               │
│                            │                                     │
│  ┌─────────────────────────▼──────────────────────────────────┐  │
│  │                    React Renderer                          │  │
│  │ React 19                                                   │  │
│  │ Tailwind v4                                                │  │
│  │ shadcn/ui                                                  │  │
│  │ xterm.js                                                   │  │
│  │ TanStack Query                                             │  │
│  │ Zustand                                                    │  │
│  │ Generated API Client                                       │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

---

# 8. 各进程职责

## 8.1 Electron Main / Desktop Host

负责：

```text
Application lifecycle
BrowserWindow
Menu / Tray
Updater
Deep Link
Native Dialog
File / Directory Grant
Credential Vault
Validated External URL
Desktop Notification
Runtime supervision
Host Capability API
```

不得负责：

```text
Host Repository
SSH Workflow
SFTP Workflow
Terminal Session Registry
AI Conversation
AI Run
Domain Router
Product SQLite
Persistent business state
```

## 8.2 Core Runtime

必须：

```text
不 import Electron
可以独立 Node 启动
可以独立测试
HTTP 暴露业务 Contract
持有 SQLite
持有 SSH/PTTY/Transfer/Tunnel/AI Run 生命周期
```

## 8.3 Renderer

只负责：

```text
UI
Interaction
xterm instance
Client cache
workspace UI state
form state
approval UI
```

不得成为业务事实源。

---

# 9. Runtime Supervisor

状态机：

```text
created
→ starting
→ ready
→ degraded
→ restarting
→ stopping
→ stopped
```

最低状态数据：

```ts
interface RuntimeProcessState {
  runtimeId?: string
  generation: string
  pid?: number
  state:
    | 'created'
    | 'starting'
    | 'ready'
    | 'degraded'
    | 'restarting'
    | 'stopping'
    | 'stopped'
  startedAt?: string
  restartCount: number
  lastExit?: {
    code: number | null
    signal: string | null
    at: string
  }
  baseUrl?: string
  apiVersion?: string
}
```

规则：

- 使用系统分配端口；
- Runtime ready handshake 返回实际端口；
- Crash 使用 backoff + jitter + restart budget；
- generation 每次 Runtime 重启都变化；
- Client 拒绝旧 generation 的响应、事件和 pending result；
- Runtime Crash 后原 SSH/PTY Session 视为终止；
- 不伪装 Session 已恢复；
- Host/Settings 等持久数据保留。

---

# 10. 启动与 Bootstrap

## 10.1 Desktop 启动

```text
Electron app.ready
      │
      ├─ Host Capability Server bind 127.0.0.1:0
      ├─ generate hostAuthToken
      ├─ generate generation
      ├─ utilityProcess.fork(Runtime)
      └─ parentPort 发送 startup envelope
               │
               ▼
Runtime
      ├─ 收到 Host endpoint/token
      ├─ 打开 SQLite
      ├─ migration preflight
      ├─ migrations
      ├─ Hono bind 127.0.0.1:0
      ├─ generate runtimeId
      ├─ generate bootstrapToken
      └─ ready envelope → Main
               │
               ▼
Main 保存当前 Runtime metadata
      │
      ├─ 创建 BrowserWindow
      └─ Renderer 通过 desktop:bootstrap 读取一次
               │
               ▼
Renderer
      ├─ POST /api/v1/auth/bootstrap
      └─ 获取 Runtime sessionToken（仅内存）
               │
               ▼
REST / fetch-SSE / WS
```

## 10.2 Bootstrap API

```ts
interface DesktopBootstrapApi {
  resolve(): Promise<{
    baseUrl: string
    apiVersion: 'v1'
    runtimeId: string
    generation: string
    bootstrapToken: string
    appVersion: string
  }>
}
```

要求：

- bootstrapToken 短期、单用途；
- exchange 后旋转；
- Runtime sessionToken 只存在 Client 内存；
- REST 使用 `Authorization: Bearer <sessionToken>`；
- fetch-based SSE 同样使用 Authorization Header；
- WS 使用专用 `Sec-WebSocket-Protocol` auth subprotocol；
- Token 不进入 query string；
- Token 不进入 localStorage/sessionStorage；
- Token 不进入日志。

Runtime 重启后 Client 重新调用 `desktop:bootstrap`，获取新 generation/endpoint/token。

---

# 11. 技术栈

## 11.1 Desktop

```text
Electron 44.x stable
TypeScript
React 19
electron-vite 5.x stable
Vite
Tailwind CSS v4
shadcn/ui
Base UI primitives（新项目默认）
xterm.js
TanStack Query
Zustand
React Hook Form
Zod
```

xterm addons 按需：

```text
@xterm/addon-fit
@xterm/addon-search
@xterm/addon-web-links
@xterm/addon-webgl
@xterm/addon-unicode11
```

## 11.2 Runtime

```text
TypeScript
Node API
Hono
@hono/node-server
@hono/zod-openapi
Zod
ws
ssh2
node-pty
SQLite
Drizzle ORM
node:sqlite
pino
```

## 11.3 Tooling

```text
Bun Workspaces
Bun 1.4.x line
ESLint flat config
Prettier
Vitest
Playwright
dependency-cruiser（或等价架构依赖门禁）
electron-builder 27.x
```

## 11.4 运行时约束

Desktop Runtime：

```text
Electron embedded Node
```

未来 Headless Runtime：

```text
Node 24.20.x line
```

Build / install：

```text
Bun
```

Core Runtime 中禁止使用：

```text
bun:sqlite
bun:* runtime-only API
```

因为桌面 Runtime 不是 Bun Runtime。

---

# 12. 依赖版本策略

初始化时 Codex：

1. 使用上述 major line 对应的最新 stable；
2. 禁止在有 stable 方案时使用 beta/RC；
3. 提交 `bun.lock`；
4. 把解析后的顶级版本记录到：

```text
docs/implementation/VERSIONS.md
```

如果升级 major，必须确认：

```text
Electron ABI
node-pty
Hono
OpenAPI generator
Drizzle
Packaging
```

全部仍通过测试。

---

# 13. Monorepo 目录

```text
project/
├── apps/
│   └── desktop/
│       ├── src/
│       │   ├── main/
│       │   │   ├── index.ts
│       │   │   ├── windows/
│       │   │   ├── supervisor/
│       │   │   ├── host-api/
│       │   │   ├── credentials/
│       │   │   ├── grants/
│       │   │   └── updater/
│       │   ├── preload/
│       │   │   └── index.ts
│       │   └── renderer/
│       │       ├── index.html
│       │       └── src/
│       │           ├── app/
│       │           ├── components/
│       │           │   └── ui/
│       │           ├── features/
│       │           │   ├── hosts/
│       │           │   ├── terminal/
│       │           │   ├── sftp/
│       │           │   ├── transfers/
│       │           │   ├── tunnels/
│       │           │   ├── commands/
│       │           │   ├── ai/
│       │           │   └── settings/
│       │           ├── stores/
│       │           ├── hooks/
│       │           └── styles/
│       ├── electron.vite.config.ts
│       ├── electron-builder.yml
│       └── package.json
│
├── packages/
│   ├── runtime/
│   │   ├── src/
│   │   │   ├── entry/
│   │   │   │   ├── desktop.ts
│   │   │   │   └── headless.ts
│   │   │   ├── bootstrap/
│   │   │   ├── http/
│   │   │   │   ├── app.ts
│   │   │   │   ├── middleware/
│   │   │   │   └── routes/
│   │   │   ├── application/
│   │   │   ├── domain/
│   │   │   │   ├── hosts/
│   │   │   │   ├── connections/
│   │   │   │   ├── terminal/
│   │   │   │   ├── sftp/
│   │   │   │   ├── transfers/
│   │   │   │   ├── tunnels/
│   │   │   │   ├── commands/
│   │   │   │   ├── interactions/
│   │   │   │   ├── ai/
│   │   │   │   └── settings/
│   │   │   ├── repositories/
│   │   │   ├── tasks/
│   │   │   └── adapters/
│   │   │       ├── ssh2/
│   │   │       ├── pty/
│   │   │       ├── sqlite/
│   │   │       ├── host/
│   │   │       └── ai/
│   │   └── package.json
│   │
│   ├── contracts/
│   │   ├── src/
│   │   │   ├── schemas/
│   │   │   ├── problems/
│   │   │   ├── events/
│   │   │   ├── terminal-ws/
│   │   │   └── host-capabilities/
│   │   └── package.json
│   │
│   ├── client/
│   │   ├── src/
│   │   │   ├── generated/
│   │   │   ├── api-client.ts
│   │   │   ├── event-client.ts
│   │   │   └── terminal-client.ts
│   │   └── package.json
│   │
│   ├── db-schema/
│   │   ├── src/schema/
│   │   ├── drizzle/
│   │   └── package.json
│   │
│   └── shared/
│       ├── src/
│       └── package.json
│
├── docs/
│   ├── architecture/
│   ├── adr/
│   ├── api/
│   └── implementation/
│       ├── STATUS.md
│       └── VERSIONS.md
│
├── tests/
│   ├── fixtures/
│   ├── integration/
│   └── e2e/
│
├── scripts/
├── AGENTS.md
├── package.json
├── tsconfig.base.json
├── eslint.config.js
├── .prettierrc
└── bun.lock
```

不要为了“架构感”继续机械拆包。

---

# 14. Package 依赖方向

允许：

```text
Renderer
  → @workspace/client
  → @workspace/contracts
  → @workspace/shared

Client
  → @workspace/contracts
  → @workspace/shared

Runtime
  → @workspace/contracts
  → @workspace/db-schema
  → @workspace/shared

Desktop Main
  → host capability contracts
  → shared
```

禁止：

```text
Renderer → Electron
Renderer → node:*
Renderer → ssh2
Renderer → node-pty
Renderer → drizzle-orm
Renderer → Runtime implementation

Runtime domain → Hono
Runtime domain → Drizzle
Runtime domain → ssh2
Runtime domain → node-pty
Runtime → Electron

Electron Main → Runtime domain/repository implementation
```

跨 Domain 不允许 import 对方 internal implementation。

通过：

```text
stable interface
application service
domain event
explicit read model
```

协作。

---

# 15. TypeScript 基线

```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "useUnknownInCatchVariables": true,
  "noImplicitOverride": true,
  "noFallthroughCasesInSwitch": true,
  "verbatimModuleSyntax": true,
  "forceConsistentCasingInFileNames": true
}
```

规则：

- Repo 以 ESM 为默认；
- Public Contract 禁止 `any`；
- 不可信数据从 `unknown` 开始；
- 所有 HTTP/WS 外部输入使用 Zod 校验；
- Vendor typing 缺口只能限制在 Adapter 内；
- ID 默认 `crypto.randomUUID()`；
- JSON timestamp 统一 ISO-8601 UTC。

---

# 16. Runtime 内部分层

```text
Hono / WS / SSE Adapter
          │
          ▼
Application Layer
          │
          ▼
Domain Layer
          ▲
          │ interfaces
          │
Repository / Vendor Adapter
```

## 16.1 Application

负责：

```text
Use Case
Workflow
Transaction Boundary
Authorization decision
Idempotency orchestration
Task orchestration
User interaction orchestration
AI approval orchestration
```

## 16.2 Domain

负责：

```text
Entity
Value Object
Invariant
State Machine
Risk Policy
Domain Service interface
Domain Event
```

## 16.3 Adapter

负责：

```text
Hono
ssh2
node-pty
Drizzle
node:sqlite
Desktop Host HTTP Client
AI Vendor API
pino sink
```

---

# 17. HTTP Contract

正式业务边界：

```text
REST
JSON
OpenAPI 3.1
Zod Runtime Validation
RFC 7807 Problem Details
ETag / If-Match
Idempotency-Key
Cursor Pagination
AbortSignal / timeout
Trace ID
```

要求：

- 所有长期 Route 必须有唯一稳定 `operationId`；
- 所有 2xx/4xx/5xx 都有 Schema；
- Renderer 不散落 raw `fetch`；
- 通过 `@workspace/client` 使用；
- Server Implementation Type 不作为公共 Client Contract。

Runtime：

```text
/api/v1/*
```

Host Capability：

```text
/host/v1/*
```

两者 Token、版本、权限完全分开。

---

# 18. OpenAPI / Client 生成

采用：

```text
Zod
  ↓
@hono/zod-openapi
  ↓
Hono Route
  ↓
OpenAPI 3.1 JSON
  ↓
openapi-typescript
  ↓
openapi-fetch
  ↓
@workspace/client
```

禁止把：

```ts
type AppType = typeof app
```

作为跨端正式公共 Contract 的唯一来源。

Hono RPC 可以在局部内部场景使用，但 Desktop/Web/Mobile/CLI 的稳定 Contract 以 OpenAPI 为准。

CI MUST：

```text
重新生成 OpenAPI
重新生成 Client
检查 git diff
发现漂移则失败
```

---

# 19. Problem Details

统一错误：

```ts
interface ProblemDetails {
  type: string
  title: string
  status: number
  detail?: string
  instance?: string
  code: string
  traceId: string
  fieldErrors?: Record<string, string[]>
}
```

示例 code：

```text
VALIDATION_ERROR
UNAUTHORIZED
FORBIDDEN
NOT_FOUND
CONFLICT
PRECONDITION_FAILED
RUNTIME_UNAVAILABLE
CAPABILITY_UNAVAILABLE
SSH_AUTH_FAILED
SSH_HOST_KEY_UNKNOWN
SSH_HOST_KEY_CHANGED
SFTP_ERROR
TRANSFER_FAILED
AI_PROVIDER_ERROR
AI_APPROVAL_REQUIRED
AI_TOOL_DENIED
```

禁止在错误中返回 Secret。

---

# 20. Runtime API 路由清单

## 20.1 Bootstrap

```text
POST /api/v1/auth/bootstrap            authBootstrap
POST /api/v1/auth/logout               authLogout
```

## 20.2 Runtime metadata

```text
GET /health                            health
GET /api/v1/version                    getVersion
GET /api/v1/capabilities               getCapabilities
GET /api/v1/runtime                    getRuntimeMetadata
```

`/health` 未认证，仅返回：

```json
{ "status": "ok" }
```

不得暴露敏感发现信息。

## 20.3 Host Group

```text
GET    /api/v1/host-groups             listHostGroups
POST   /api/v1/host-groups             createHostGroup
PATCH  /api/v1/host-groups/:id         updateHostGroup
DELETE /api/v1/host-groups/:id         deleteHostGroup
```

## 20.4 Host

```text
GET    /api/v1/hosts                   listHosts
POST   /api/v1/hosts                   createHost
GET    /api/v1/hosts/:id               getHost
PATCH  /api/v1/hosts/:id               updateHost
DELETE /api/v1/hosts/:id               deleteHost
POST   /api/v1/hosts/import            importHosts
```

## 20.5 Credential Reference

```text
GET    /api/v1/credentials             listCredentialMetadata
POST   /api/v1/credentials             createCredentialReference
PATCH  /api/v1/credentials/:id         replaceCredential
DELETE /api/v1/credentials/:id         deleteCredential
```

任何 Route 都不得返回明文 Secret。

## 20.6 Connection

```text
GET    /api/v1/connections             listActiveConnections
POST   /api/v1/connections             createConnection
GET    /api/v1/connections/:id         getConnection
DELETE /api/v1/connections/:id         closeConnection
POST   /api/v1/connections/:id/retry   retryConnection
```

## 20.7 Interaction

```text
GET  /api/v1/interactions              listPendingInteractions
POST /api/v1/interactions/:id/respond  respondInteraction
POST /api/v1/interactions/:id/cancel   cancelInteraction
```

用于：

```text
Unknown Host Key
Changed Host Key
Keyboard Interactive
临时密码/Passphrase
AI Approval
```

## 20.8 Terminal

```text
GET    /api/v1/terminals               listTerminalSessions
POST   /api/v1/terminals               createTerminal
GET    /api/v1/terminals/:id           getTerminalSession
DELETE /api/v1/terminals/:id           closeTerminal
```

Terminal byte stream 不通过 REST。

终端信息通过独立的只读资源获取：

```text
GET /api/v1/terminals/:id/information  getTerminalInformation
```

### 20.8.1 SSH 会话启动序列

SSH Bookmark 可以保存有序的 login/run steps。每个 step 必须显式保存 command、delay、
是否附加 Enter、是否等待输出稳定、静默窗口和最长等待；单项命令、项数、等待时间与整个
序列字节数均有固定上限。Runtime 在 Shell Integration 已确认 active 或 unavailable 后，按
以下顺序执行：

```text
merged environment
→ login scripts
→ startup directory
→ run scripts
```

序列由 Terminal Application Service 持有，只通过 Terminal Channel 写入，不向 Renderer
暴露 SSH/PTY handle。序列存活时到达的用户、Quick Command、Trigger 或其他普通终端输入
进入既有有界输入队列，完成后按到达顺序释放，禁止越过启动步骤。输出稳定等待必须在每次
输出活动后重置静默窗口，并同时受最长等待限制。Terminal close、Runtime shutdown 或序列
替换必须取消 delay/idle/timeout，清除 listener，并且不得重放未执行步骤。命令正文与终端
输出不得进入 Domain Event、日志、诊断或浏览器持久状态；诊断只允许报告活动序列数量。

### 20.8.2 Terminal Information

Terminal Information 是 Runtime 拥有的会话只读快照。SSH 会话复用已建立连接，通过固定、
不可由 Renderer 修改的诊断命令采集 system、uptime、CPU、memory、users、network、disks 与
activities；不得把任意命令参数开放为该资源的一部分。每条命令输出上限为 64 KiB，最长执行
5 秒，同时执行不超过 2 条。进程列表、网络接口和磁盘列表必须截断到固定容量，可能包含凭据的
进程参数必须脱敏。

采样结果按组缓存并使用各自 TTL；同一 Terminal/组的并发请求只执行一次。每个 Runtime 最多
保留 64 个会话缓存，CPU 历史最多 60 点，网络速率按两次样本的真实间隔计算。缓存值过期后
采样失败时可以返回 `stale` 和上次安全值；命令不存在返回 `unsupported`，首次采样的其他失败
返回 `error`。本地终端只报告 Runtime 可直接证明的系统信息，其余组明确为 `unsupported`，
不得伪造远端指标。

Renderer 只在信息面板可见且 SSH 会话为 ready 时轮询；隐藏、断线、关闭或卸载必须停止。
Terminal close 时清除对应缓存，Runtime shutdown 清空缓存和未决请求引用。原始命令输出、完整
进程命令行和采样历史不得进入 SQLite、Domain Event、日志、Zustand 或 localStorage；诊断只
报告缓存与未决请求数量。

### 20.8.3 Remote Monitor

Remote Monitor 是 Terminal Information 快照的紧凑展示，不建立第二套采样器。监控栏与完整
信息面板必须使用相同的 Query identity；Runtime 依靠 20.8.2 的 per-group TTL 与 in-flight
去重共享结果。监控栏默认关闭，只允许当前 SSH 会话使用，并位于 Terminal 与全局 footer
之间；显示时必须占用明确高度并触发 xterm resize，不能覆盖终端最后一行。

可见项目、顺序和总开关通过 Runtime Settings 持久化。默认项目为 hostname、CPU、CPU
history、memory、upload、download、uptime、users 与 disks。CPU、memory 与 disk 使用带回差
的 warning/critical 阈值，避免临界值附近闪烁。详情可由 hover、keyboard focus 或 click 打开，
支持 click pin、Escape、明确关闭和跳转完整 Terminal Information；触摸路径使用 click。
loading、empty、unsupported、stale、error 与 disconnected 都必须可区分。

只有监控栏可见并且 SSH 会话 ready 时才允许周期刷新。栏被关闭、完整信息面板打开、用户切换
到其他 surface、Terminal 断线/关闭或组件卸载后必须立即停止轮询。Renderer 不得运行远端命令、
保存原始监控输出或直接操作 SSH handle。

## 20.9 SFTP

```text
GET    /api/v1/sftp/:connectionId/list
GET    /api/v1/sftp/:connectionId/stat
POST   /api/v1/sftp/:connectionId/mkdir
POST   /api/v1/sftp/:connectionId/rename
DELETE /api/v1/sftp/:connectionId/path
POST   /api/v1/sftp/:connectionId/upload
POST   /api/v1/sftp/:connectionId/download
```

## 20.10 Transfer

```text
GET  /api/v1/transfers
GET  /api/v1/transfers/:id
POST /api/v1/transfers/:id/cancel
POST /api/v1/transfers/:id/retry
```

## 20.11 Quick Command

```text
GET    /api/v1/quick-command-tree
GET    /api/v1/quick-commands
POST   /api/v1/quick-commands
PATCH  /api/v1/quick-commands/:id
DELETE /api/v1/quick-commands/:id
POST   /api/v1/quick-command-groups
PATCH  /api/v1/quick-command-groups/:id
DELETE /api/v1/quick-command-groups/:id
POST   /api/v1/quick-command-tree/moves
```

Quick Command 是带独立 revision/ETag 的有序聚合。文件夹可嵌套，删除时提升直接子项；
跨文件夹拖放与同级排序在一个 Runtime 事务内完成，并拒绝循环和过期版本。单条命令最多
32 个有序步骤和 128 KiB 文本；`clipboard`、`date`、`time` 模板只在用户明确 Insert/Send
时展开，持久化数据保留模板原文。

Bookmark 另有 Legacy Prototype 兼容的本地 Quick Command 列表，每个 Bookmark 最多 64 条，每条由
不超过 60 字的名称和 16 KiB 命令组成；它不改变全局 Quick Command 聚合的 revision。会话
快捷命令面板按“当前 Bookmark、本地列表在前；全局列表在后”组合。Insert 必须去除可导致
隐式提交的换行并只写入当前输入行；Send 才能附加 Enter，并按步骤延迟发送。两者都必须由
用户明确触发，只能经活动 Terminal 的 Binary WebSocket 写入，并在关闭、取消或 generation
变化时停止剩余步骤。持久 Domain Event 只保存本地命令数量，不保存命令正文。

Batch Input 是 Renderer 中的显式多终端输入面板，只能选择已连接的 Local、SSH、Telnet、
Serial Terminal。每次提交最多 16 KiB，并为每个目标分别进入既有 Binary WebSocket 的有界
发送器；不得切换活动标签或聚焦隐藏 xterm。目标关闭或 generation 变化时必须在提交前过滤，
部分失败要展示成功/目标数量。至少保留一个有效目标；Escape 或关闭面板不得发送草稿。
批量输入历史默认只保留在当前 Renderer 运行期，最多 50 条，不进入 Zustand、SQLite 或
浏览器持久存储。

## 20.11.1 Batch Operation

```text
GET  /api/v1/batch-operations
GET  /api/v1/batch-operations/:id
POST /api/v1/batch-operations
POST /api/v1/batch-operations/:id/cancel
POST /api/v1/batch-operations/clear
```

Batch Operation 由 Runtime 管理，输入为 1–64 个 SSH Bookmark、1–32 个有序命令步骤、
1–8 的并发上限和有界连接超时。每个 Bookmark 使用独立受管 SSH 连接；目标之间按 worker
上限并发，目标内步骤严格顺序执行。步骤支持 0–65,535 ms 延迟及显式的失败后继续，单条命令
不超过 16 KiB，远端输出捕获上限为 128 KiB。创建必须带 `Idempotency-Key`，重复请求返回
原任务；Runtime 同时最多运行四个 Batch Operation。

Runtime 持久化任务、目标与步骤的状态、时间、退出码和稳定错误码，并通过 Realtime Event
发布进度。命令正文、stdout、stderr 和凭据不得进入任务历史、Domain Event 或 Renderer
持久状态。取消必须中止正在连接、等待、延迟或执行的目标，关闭全部任务专用连接并把未开始
步骤标记为 canceled；Runtime 重启后未完成任务标记为 interrupted，禁止自动重放。Renderer
提供 SSH 书签搜索/选择、步骤编辑/排序、并发设置、显式执行/取消、历史和逐目标日志视图。

## 20.11.2 Trigger Automation

```text
GET    /api/v1/triggers
POST   /api/v1/triggers
PUT    /api/v1/triggers
PATCH  /api/v1/triggers/:id
DELETE /api/v1/triggers/:id
```

全局 Trigger 是带独立 revision/ETag 的 Runtime 聚合，最多 256 条；Bookmark 另有最多 32 条
有序本地规则，由 Bookmark tree 的事务和 ETag 管理。SSH/Telnet/Serial Terminal 可带
`bookmarkId`；会话只组合全局规则与这个 Bookmark 的规则，不得读取其他 Bookmark 的规则。
全局规则变化可刷新现存会话，Bookmark 规则在新会话绑定时形成快照。

Trigger engine 观察 shell integration 和终端传输协议过滤后的输出，按 Terminal encoding
增量解码，并在不超过 64 KiB 的窗口中跨 chunk 去除 ANSI/OSC/CSI、归一化 CR/CRLF 和匹配
文本或安全正则。规则支持大小写、repeat/once/cooldown、通知、显式发送、可选 Enter 以及
`\\n`、`\\r`、`\\t`、`\\xHH` 和 caret 控制字符。发送只能调用 Terminal Application
Service，不能持有 ssh2/PTY vendor object；一个会话最多触发 1,000 次，超过后禁用并发布
安全错误事件。

触发匹配的原始输出和发送正文不得进入 Domain Event、Realtime Event、日志或 Renderer
持久状态。事件只包含 Terminal/Trigger 标识、规则名称和动作类型。Terminal 退出、关闭、
generation 替换和 Runtime shutdown 必须释放 decoder、匹配状态和 observer。全局编辑器支持
CRUD、启停、预设和原子 JSON 替换；SSH Bookmark 六标签编辑器提供本地规则的同等核心字段。

## 20.12 Terminal Profile

```text
GET    /api/v1/terminal-profiles
POST   /api/v1/terminal-profiles
PATCH  /api/v1/terminal-profiles/:id
DELETE /api/v1/terminal-profiles/:id
```

## 20.13 Tunnel

```text
GET    /api/v1/tunnel-profiles
POST   /api/v1/tunnel-profiles
PATCH  /api/v1/tunnel-profiles/:id
DELETE /api/v1/tunnel-profiles/:id

GET    /api/v1/tunnels
POST   /api/v1/tunnels
DELETE /api/v1/tunnels/:id
```

## 20.14 AI Provider / Model

```text
GET    /api/v1/ai/providers
POST   /api/v1/ai/providers
PATCH  /api/v1/ai/providers/:id
DELETE /api/v1/ai/providers/:id

GET    /api/v1/ai/models
POST   /api/v1/ai/models
PATCH  /api/v1/ai/models/:id
DELETE /api/v1/ai/models/:id
```

## 20.15 AI Use Case

```text
POST /api/v1/ai/explain-command
POST /api/v1/ai/explain-output
POST /api/v1/ai/generate-command
POST /api/v1/ai/diagnose
POST /api/v1/ai/runs
GET  /api/v1/ai/runs/:id
GET  /api/v1/ai/runs/:id/stream
POST /api/v1/ai/runs/:id/cancel
POST /api/v1/ai/approvals/:id/decision
```

## 20.16 Settings / Diagnostics

```text
GET   /api/v1/settings
PATCH /api/v1/settings
GET   /api/v1/diagnostics/runtime
GET   /api/v1/diagnostics/logs
```

Settings 工作区覆盖 Common、Terminal、Shortcuts、Setting sync、AI 和 Password 六个固定分类，
分类检索和键盘焦点行为必须确定。Password 只列 application-local Vault 的类型、标签和时间
元数据，不提供凭据原文查看或复制。`privacy.hideAddresses` 只控制 Renderer 的地址显示：
IPv4 保留前两段，主机名隐藏前三个字符，Runtime 中用于连接的 canonical target 不变。

## 20.17 Axterm Configuration Snapshot

```text
POST   /api/v1/data/axterm-configuration/inspections   inspectAxtermConfiguration
POST   /api/v1/data/axterm-configuration/previews      previewAxtermConfiguration
DELETE /api/v1/data/axterm-configuration/previews/:id  cancelAxtermConfigurationPreview
POST   /api/v1/data/axterm-configuration/imports       commitAxtermConfigurationImport
POST   /api/v1/data/axterm-configuration/exports       exportAxtermConfiguration
```

只接受 Axterm 自有配置快照；旧 Legacy Prototype/Axoterm 便携文件不再解析。
检查与预览通过 Desktop File Grant 读取有界普通文件，不写入业务数据；提交
必须使用有效预览，在单个 Unit of Work 中导入可移植配置，失败时回滚全部
业务写入。用户可选择是否应用可移植设置，默认保留本地设置。导出通过精确
Save Target Grant 原子写入；导入和导出均不转移 Vault 密码或非便携
Credential Ref。旧本地 SQLite 行与远端同步对象按 ADR-021 保全，不通过
本接口转换或自动读取。

## 20.18 Widget

```text
GET    /api/v1/widgets                                  listWidgets
GET    /api/v1/widgets/instances                        listWidgetInstances
GET    /api/v1/widgets/instances/:id                    getWidgetInstance
PATCH  /api/v1/widgets/instances/:id                    renameWidgetInstance
DELETE /api/v1/widgets/instances/:id                    stopWidgetInstance
POST   /api/v1/widgets/file-renamer/previews            previewFileRename
POST   /api/v1/widgets/file-renamer/runs                runFileRename
POST   /api/v1/widgets/local-file-server/instances      startLocalFileServerWidget
POST   /api/v1/widgets/local-ftp-server/instances       startLocalFtpServerWidget
POST   /api/v1/widgets/local-ssh-server/instances       startLocalSshServerWidget
```

Widget catalog、运行实例、名称、状态和安全的服务元数据由 Runtime 管理。实例只属于创建它的
Runtime generation；一个 generation 最多同时运行 8 个实例。启动失败、显式停止、Runtime
shutdown 和 crash supervision 都必须关闭 server、socket、连接、PTY、child process、SFTP
handle、stream、listener 和 timer。Renderer 只通过生成客户端管理实例，不接收 server object、
本地绝对路径或明文密码。Realtime Event 只发送 Widget/instance ID、状态、计数和稳定错误码。

File Renamer 是需要预览后再执行的本地文件操作。它必须使用 Desktop Host 颁发的 read/write
Directory Grant，最多遍历 1,000 个文件和 32 层目录，默认不跟随符号链接。预览最多存活两分钟，
固定每个源文件的版本和最终目标名，报告 unchanged、conflict 或 ready；执行必须带
`Idempotency-Key`，重新校验来源版本与目标占用，并使用同目录两阶段临时名称处理交换和大小写
重命名。任一步失败时尽力回滚，返回逐项稳定结果，不允许把预览外的新路径加入执行。

Static File Server、FTP Server 和 SSH Server 必须先验证 read/write Directory Grant，并在
每次访问时把词法路径和已存在祖先的 realpath 限制在授权根目录内。默认绑定 loopback，显式
修改绑定地址才可扩大网络可见范围；端口、连接、socket、passive port、目录项、file handle、
单请求帧和超时均有固定上限。Static Server 支持 GET/HEAD、Range、ETag、Last-Modified、
Cache-Control、index、redirect 和 dotfile 策略。FTP 支持匿名或当前实例的瞬时密码认证；SSH
支持当前实例的瞬时密码、PTY shell、exec 与有界 SFTP 操作。密码只存在于启动请求和 Runtime
实例内存，不进入实例响应、URL、通知、日志、事件、SQLite 或浏览器持久状态。

Legacy Prototype 的目录型 Widget 可以保存绝对路径并在应用启动时 auto-run。Axterm 的 File Grant
按 generation 失效，所以这些 Widget 在 Runtime 重启后必须呈现为已停止，并由用户重新选择
目录后启动；不得为复刻 auto-run 绕过 Desktop Host 授权边界。

---

# 21. SSE 设计

Domain Event 与 Realtime Event 不共用模糊 Cursor。

## 21.1 Domain Event

```text
GET /api/v1/events/domain?after=<cursor>
```

特点：

```text
persistent
replayable
at-least-once
global cursor
schema version
bounded retention
```

```ts
interface DomainEventEnvelope<T = unknown> {
  id: string
  cursor: number
  schemaVersion: number
  type: string
  occurredAt: string
  producer: string
  payload: T
}
```

例如：

```text
host.created
host.updated
host.deleted
quickCommand.updated
tunnelProfile.updated
ai.provider.updated
```

## 21.2 Realtime Event

```text
GET /api/v1/events/realtime
```

例如：

```text
runtime.health
connection.status
interaction.required
transfer.progress
terminal.status
ai.run.status
ai.tool.status
```

Realtime 不作为业务事实源，也不承诺 Runtime Restart 后 replay。

## 21.3 SSE Client

必须使用 fetch-based SSE，而不是只依赖浏览器 `EventSource`，因为需要：

```text
Authorization Header
AbortSignal
统一 retry/backoff
trace
自定义 cursor
```

---

# 22. Terminal WebSocket

Endpoint：

```text
WS /api/v1/terminals/:terminalId/stream
```

## 22.1 Authentication

WebSocket URL 不得出现 token query。

通过：

```text
Sec-WebSocket-Protocol
```

携带：

```text
terminal.v1
terminal-client.<renderer-client-uuid>
auth.<opaque-token>
```

Server 校验 token、Runtime generation 和 client UUID 后再 attach Terminal。client UUID
不是 secret，仅用于同一 Renderer 重新 attach 时续接有界 replay 游标；每个 Terminal
最多保留 64 个 client cursor 和同时附加的 viewer。

按 [ADR-024](../adr/ADR-024-terminal-output-consumption-window.md)，Desktop Client
额外协商非敏感的 `terminal-flow.v1`。每次 attach 使用新的 stream UUID 和累计字节
计数，重放也计入消费窗口。没有协商该能力的既有 headless/raw client 保持原行为。

## 22.2 Binary Data Plane

```text
Client binary frame → stdin bytes
Server binary frame → stdout/stderr terminal bytes
```

禁止：

```json
{"type":"terminal-data","data":"base64..."}
```

## 22.3 JSON Control Plane

Client：

```ts
type TerminalClientControl =
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'signal'; signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP' }
  | { type: 'ping'; nonce: string }
  | { type: 'outputConsumed'; streamId: string; consumedBytes: number }
  | { type: 'close' }
```

Server：

```ts
type TerminalOutputFlow = {
  streamId: string
  highWaterBytes: 262144
  lowWaterBytes: 65536
  maxPendingBytes: 524288
  maxFrameBytes: 65536
}

type TerminalServerControl =
  | { type: 'ready'; outputFlow?: TerminalOutputFlow }
  | {
      type: 'status'
      state: 'opening' | 'ready' | 'closed' | 'failed' | 'reconnecting' | 'stale'
    }
  | { type: 'replay'; firstSequence?: number; lastSequence: number; byteLength: number; truncated: boolean }
  | { type: 'exit'; exitCode: number | null }
  | { type: 'pong'; nonce: string }
  | { type: 'error'; code: string }
```

所有 Text Frame 使用共享 Zod schema 校验。普通非法 control 只显示有界错误，
不得污染后续 Binary Data Plane。已协商的消费握手不一致、错误/超额消费确认或
超过消费硬上限时，按 ADR-024 显式关闭该 attachment；不能静默丢弃输出。

## 22.4 Backpressure

必须实现：

- bounded outgoing buffer；
- 最大 pending bytes；
- Renderer UTF-8 input frame 小于 64 KiB，当前固定为 32 KiB；
- 单次 input 与 pending input queue 各不超过 1 MiB；
- 能 pause 的 vendor stream 使用 pause/resume；
- 已协商的输出 frame 不超过 64 KiB；每 socket 待消费 raw bytes 高水位 256 KiB、
  低水位 64 KiB、硬上限 512 KiB；checkpoint 数量另以 4,096/8,192 为软/硬上限；
- xterm write 回调之后才累计消费；确认按 32 KiB 批量或 25 ms 有界计时器发送；
  socket 与 stream UUID 必须匹配，安全整数不能回退或超过该 socket 已发送字节；
- 消费停滞时暂停源；所有消费、transport 与 recording pause owner 解除后才能恢复；
  OS 挂起不生成无消费依据的确认，也不以挂起时长作为断连依据；
- 替换/关闭/重启回收计时器、listener 与 checkpoint；旧 ACK 不能释放新连接；
- 禁止 unbounded array/string accumulation。

## 22.5 Terminal Output State

默认：

```text
xterm scrollback = Renderer memory
Runtime recent output = bounded ring buffer
Persistent terminal recording = disabled
```

Runtime 为 AI 和同 generation reattach 保留的 recent output：

```text
每 Terminal 128 KiB complete-chunk ring
只按完整 vendor chunk 淘汰，不为满足容量从 chunk 中间裁切
无法覆盖的早期 UTF-8/ANSI 上下文通过 replay.truncated 明确报告
```

---

# 23. Domain 术语

持久：

```text
HostGroup
Host
CredentialReference
TerminalProfile
TunnelProfile
QuickCommand
KnownHostKey
RecentConnection
AiProvider
AiModel
AiConversation
AiMessage
AiRun
AiToolCall
AiApproval
AppSettings
DomainEvent
TransferHistory
```

Runtime 临时资源：

```text
Connection
TerminalSession
SftpChannel
TransferJob
TunnelInstance
PendingInteraction
RuntimeTask
```

禁止把所有对象都叫 Session。

---

# 24. SSH Domain / Adapter

Application/Domain 依赖抽象：

```ts
interface SshTransport {
  connect(input: SshConnectInput): Promise<SshConnectionHandle>
}

interface SshConnectionHandle {
  id: string
  openShell(input: ShellOpenInput): Promise<DuplexTerminalChannel>
  openSftp(): Promise<SftpHandle>
  exec(input: ExecInput): Promise<ExecResult>
  createForward(input: ForwardInput): Promise<ForwardHandle>
  close(): Promise<void>
}
```

具体 `ssh2` 只存在于：

```text
packages/runtime/src/adapters/ssh2
```

## 24.1 认证

Desktop 1.0：

```text
password
private key
private key + passphrase
keyboard-interactive
SSH agent（平台验证可靠后启用）
jump host
```

## 24.2 Host Key

绝对禁止默认静默 accept-all。

```text
known + match
→ connect

unknown
→ interaction.required

known + mismatch
→ high-severity interaction.required

reject
→ fail
```

保存：

```text
host
port
algorithm
fingerprint
public key metadata
firstSeenAt
lastSeenAt
```

Changed Host Key UI 必须与 Unknown 明显区分。

## 24.3 Jump Host

配置保存引用：

```ts
interface JumpHostRef {
  hostId: string
}
```

Application resolve 连接链并检查 cycle。

禁止 UI 直接拼接 `ssh2` config object。

## 24.4 Connection State

```text
created
→ resolving
→ connecting
→ authenticating
→ ready
→ reconnecting
→ closing
→ closed
→ failed
```

---

# 25. Local PTY

使用：

```text
node-pty
```

通过：

```text
PtyAdapter
```

隔离。

要求：

- 自动选择平台默认 shell；
- Terminal Profile 可覆盖 shell/cwd/env/login behavior；
- 默认 cwd 为 user home；
- environment 做最小必要 sanitize；
- 支持 cols/rows resize；
- 支持 close/kill；
- listener 全部 cleanup；
- 不为了执行单条命令随便套 `/bin/sh -c`；
- shell flags 不硬编码到破坏用户 `.zshrc/.bashrc` 的程度。

`loginShell` 作为 Profile 配置，而不是无条件强制。

---

# 26. SFTP

优先复用已有 SSH Connection 打开 SFTP Channel。

Renderer 永远拿不到 `ssh2` SFTP object。

SSH 会话首次打开 SFTP 文件面时，Runtime 必须通过 SFTP `realpath('.')` 解析已认证账号的
规范化用户目录，并把它作为默认远端地址；只有服务器无法解析时才回退到 `/`，同时向用户
显示明确提示。手动地址、远端书签、终端 cwd 跟随和显式启动目录可以覆盖该默认值。

统一 DTO：

```ts
interface RemoteFileEntry {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  mode?: number
  modifiedAt?: string
  owner?: string
  group?: string
}
```

支持：

```text
list
stat
mkdir
rename
delete
upload
download
```

远端文件面接受来自 Finder、Explorer 和桌面文件管理器的 `Files` 拖放。普通文件拖入当前
列表、`..` 或具体远端目录后，Renderer 立即用有界 HTTP stream 导入临时 File Grant，并为
每个文件创建可取消、可观察进度的上传任务；批次、单文件和总字节数沿用终端拖放上限，重名
进入现有冲突决策。目录拖放未实现递归浏览器入口时必须明确引导到“上传目录”。

后续再增加：

```text
chmod
recursive ops
resume
sync
```

---

# 27. Transfer

状态：

```text
queued
→ preparing
→ running
→ succeeded
| failed
| canceled
```

```ts
interface TransferProgress {
  transferId: string
  direction: 'upload' | 'download'
  bytesTransferred: number
  totalBytes?: number
  bytesPerSecond?: number
  state: string
}
```

Progress 通过 Realtime SSE。

大文件：

```text
HTTP stream / fs stream / SFTP stream
```

禁止：

```text
Base64 whole-file JSON
Buffer whole file into memory
```

---

# 28. File / Directory Grant

Renderer 不获取私钥、临时文件、保存目标等任意文件的绝对路径。本地 File Manager 为了与
Legacy Prototype 的地址栏行为一致，可以接收当前 generation-bound **目录** Grant 的规范化绝对
`rootPath`，并显示由 `rootPath + relativePath` 组成的完整路径。该例外只用于用户可见的本地
文件浏览；所有读写、传输、编辑和原生操作仍提交 `grantId + relativePath`，由 Host 再次做
realpath containment、权限和 generation 校验。

首次打开本地 File Manager 时，Host 自动为系统 `homedir()` 创建读写目录 Grant，因此 macOS
用户 `h` 默认看到 `/Users/h`。用户在地址栏提交另一个有效绝对目录时，Host 为该目录创建新
Grant并撤销旧 Grant；原生目录选择器继续作为可视化切换入口。相对输入、文件目标、无效目录
和不存在路径必须拒绝。

流程：

```text
User requests select file
      ↓
Runtime use case
      ↓
Host Capability
      ↓
Native Dialog
      ↓
grantId
      ↓
Renderer receives grantId/metadata
      ↓
Runtime uses Host to resolve authorized path when needed
```

Grant 需要：

```text
grantId
kind: file | directory | save-target
rootPath?  # 只对 File Manager 的目录 Grant 公开
permissions
createdAt
expiresAt?
owner generation
```

Runtime 可以在受认证的 Host Capability API 中解析真正 path。Renderer 只可见目录 Grant 的
展示根路径，不可见其他 Grant 的底层 path。

---

# 29. Desktop Host Capability API

Host API 不是业务 Backend，只是原生能力 Provider。

绑定：

```text
127.0.0.1:0
```

认证：

```text
per-runtime-generation random bearer token
```

Host Token 只通过 Main → Runtime supervision startup envelope 发送，不给 Renderer。

Route：

```text
POST /host/v1/dialogs/open-file
POST /host/v1/dialogs/open-directory
POST /host/v1/dialogs/save-file

POST /host/v1/grants/:id/resolve
DELETE /host/v1/grants/:id

POST /host/v1/credentials
POST /host/v1/credentials/:id/resolve
DELETE /host/v1/credentials/:id

POST /host/v1/notifications
POST /host/v1/external-url/open
GET  /host/v1/updater/status
POST /host/v1/updater/actions

GET   /host/v1/desktop/window
POST  /host/v1/desktop/window/actions
GET   /host/v1/desktop/window/preferences
PATCH /host/v1/desktop/window/preferences

POST   /host/v1/web-views
GET    /host/v1/web-views/:id
PATCH  /host/v1/web-views/:id
DELETE /host/v1/web-views/:id
POST   /host/v1/web-views/:id/actions
POST   /host/v1/web-views/:id/auth
```

窗口偏好保存在应用本地目录，使用严格 schema 与原子替换。`opacity`、
`zoomFactor` 和有效 `bounds` 可应用到当前窗口；`custom` / `system` 标题栏
模式在创建窗口时应用，活动窗口模式不一致时响应明确返回
`requiresRestart: true`。恢复 bounds 前必须按当前 display work area 修正，避免
显示器断开后窗口留在屏幕外。

Web Bookmark 的原生页面由 Desktop Host `WebContentsView` 承载，边界由
[ADR-011](../adr/ADR-011-native-web-session-host-capability.md) 固定。Runtime 是 Web Session
业务 owner；Renderer 只能通过生成的 Runtime REST Client 提交有界 geometry、visibility 和
导航动作，不接触 Electron object 或 Host Token。Host 只接受无内嵌凭据的 HTTP/HTTPS URL，
保持 sandbox、context isolation 和 web security，拒绝权限、下载、危险导航和隐式 popup。
Basic Auth 只允许一次 challenge-bound 响应并设置两分钟期限，不得持久化。每代最多八个
Web Session，session/window/generation/Host 关闭时必须同步销毁 view、listener、callback 和 timer。

Deep Link 的跨进程路径由
[ADR-012](../adr/ADR-012-deep-link-runtime-ingress.md) 固定。Desktop Host 在安装包中登记
`axterm`、兼容的 `legacy-prototype`、`ssh`、`telnet`、`vnc`、`rdp`、`spice`、`serial` 和 `ftp`；
不得抢占 `http`/`https`。Main 必须先取得 single-instance lock，再从启动参数、macOS `open-url`
和 second-instance 命令行接收最大 16 KiB 的链接，Runtime 未就绪前最多保留 32 条。

Main 仅可调用私有 `POST /desktop/v1/deep-links` ingress。该入口使用独立的每代随机令牌和
精确 generation，不复用 Renderer session token；令牌只能通过既有 startup envelope 交给 Runtime。
Runtime 解析后最多保留 32 条、两分钟、memory-only intent，并通过 Realtime SSE 发出不含源链接
和凭据的可用事件。Renderer 使用正常认证的 `GET /api/v1/desktop/deep-links/next` 原子领取；
领取后按协议进入 Quick Connect 或相应表单，关闭动作必须清除临时值。源链接、临时凭据、拒绝
详情不得进入 URL、SQLite、日志、TanStack Query、Zustand、localStorage 或 sessionStorage。
Main/Renderer 不得为 Deep Link 新增业务 IPC。

Desktop 命令行复用同一条 ingress 和 intent 领取路径，不建立另一套业务通道。Main 对 argv
设置 64 项、单项 16 KiB、合计 32 KiB 上限，支持 Legacy Prototype 5.5.0 的 `title`、`user`、
`port`、`password`、`private-key-path`、`passphrase`、`set-env`、`sftp-only`、
`init-folder`、`tp`、`opts`、`batch-op` 以及 Axterm 的 `new-window`。相对文件路径必须以
second-instance 提供的 working directory 解析；私钥、批量文件和初始目录只能先由 Desktop
Host 转为 generation-bound File Grant，再把不透明 grant ID 放入 intent。Renderer 不得收到
绝对路径，私钥和批量文件读取后立即撤销授权；SSH 文件工作区在卸载时撤销其目录授权。

命令行密码和口令只用于本次连接，不自动写入 application-local Vault，也不得进入日志、
SQLite、Domain Event 或浏览器存储。`batch-op` 可执行严格校验的 Axterm 批量文档，也可把
单 connect、后续仅 command 的 Legacy Prototype 工作流映射到已有 SSH Bookmark；含绝对路径的
Legacy Prototype SFTP 步骤必须拒绝并要求从文件工作区重新取得源/目标授权。`server-port` 不得覆盖
Runtime 的 loopback + OS-assigned port 约束，必须返回稳定、无路径的错误码。无效选项只向
Renderer 发送通用拒绝 intent，不回显可能含秘密的 argv。

Headless Mode 没有某项桌面能力时统一返回：

```text
CapabilityUnavailable
```

---

# 30. Credential Vault

## 30.1 业务 DB 只保存引用

SQLite 不保存：

```text
SSH password plaintext
private key passphrase plaintext
proxy password plaintext
AI API Key plaintext
```

只保存：

```text
credentialRef
kind
label
safe metadata
createdAt
updatedAt
```

## 30.2 Host Vault

由 Desktop Host 管理独立的应用本地 Vault；不得调用 macOS Keychain、Windows
Credential Manager/系统凭据设施或 Linux Secret Service。详细决策见 ADR-004。

接口：

```ts
interface CredentialVault {
  put(input: {
    kind: string
    secret: string
  }): Promise<string>

  get(ref: string): Promise<string>
  replace(ref: string, secret: string): Promise<void>
  delete(ref: string): Promise<void>
}
```

新凭据使用应用本地随机 256-bit master key 和 AES-256-GCM 加密，每个 blob
使用独立 nonce，并将 `credentialRef` 作为 authenticated additional data。Vault
位于 Electron `userData/vault`；POSIX 平台目录权限为 `0700`，master key、metadata
和 blob 权限为 `0600`。Runtime 不直接访问 Vault 存储。

Contract 对凭据只允许 `storage: local`，不暴露任何系统凭据存储模式。旧
`safeStorage` metadata 启动时直接忽略，旧 blob 永不解析；用户重新输入并保存后
创建新的本地 AES-GCM blob。UI/diagnostics 必须准确说明本地 key 与密文处于同一
OS 用户权限边界，不能宣称与系统硬件或 Keychain 保护等价。

这是固定产品策略。启动、设置、凭据保存、导入、迁移和错误恢复流程均不得探测
系统凭据设施，不得显示存储后端选择，也不得询问用户是否启用或改用系统钥匙串。

## 30.3 Renderer Secret State

Renderer 在用户输入时不可避免短暂持有 plaintext，但：

- 不进入 Zustand；
- 不进入 TanStack Query；
- 不进入 localStorage；
- 不进入 logs；
- 保存后清空 form state；
- Server 以后不向产品 UI 返回 saved secret。专用浏览器协议适配器是窄化例外：根据
  [ADR-008](../adr/ADR-008-rdp-wasm-and-runtime-relay.md) 与
  [ADR-009](../adr/ADR-009-vnc-browser-adapter-and-runtime-relay.md) 以及
  [ADR-010](../adr/ADR-010-spice-browser-adapter-and-multichannel-relay.md)，认证后的
  `RdpCanvasAdapter` / `VncCanvasAdapter` / `SpiceCanvasAdapter` 可为一个 Runtime
  generation 内的新建桌面 Session 单次领取协议握手所需 bootstrap。该值不进入 React
  state、Zustand、TanStack Query、browser storage 或日志；RDP/VNC 在握手后清空，SPICE
  为创建协议子通道保留不超过五秒的有界窗口后清空，且均不能重放。普通 UI 和其他资源
  API 仍不可读取凭据。

OTP/Keyboard Interactive 默认不保存。

---

# 31. 数据库设计

业务数据库：

```text
SQLite
+
Drizzle
+
node:sqlite
```

Runtime 为唯一 authoritative writer。

## 31.1 Desktop 1.0 Tables

```text
app_meta
host_groups
hosts
host_auth_refs
terminal_profiles
quick_commands
tunnel_profiles
known_host_keys
recent_connections
ai_providers
ai_models
ai_conversations
ai_messages
ai_runs
ai_tool_calls
ai_approvals
app_settings
domain_events
transfer_history
```

不持久化：

```text
ssh2.Client
PTY object
Sftp handle
WebSocket
active socket/listener
```

## 31.2 关系

```text
host_groups 1 ── N hosts
hosts       1 ── N host_auth_refs
hosts       1 ── N tunnel_profiles
hosts       1 ── N recent_connections

ai_providers      1 ── N ai_models
ai_conversations  1 ── N ai_messages
ai_runs           1 ── N ai_tool_calls
ai_runs           1 ── N ai_approvals
```

## 31.3 Migration

必须：

```text
forward-only
checksum
preflight integrity check
backup before risky migration
migration diagnostics
```

Production migration 失败禁止自动 reset DB。

## 31.4 Transaction + Domain Event

若一个业务 mutation 产生持久 Domain Event：

```text
Business state mutation
+
Event insert
```

必须在同一 SQLite transaction。

---

# 32. AI Domain

AI 是正式 Domain：

```text
runtime/domain/ai
runtime/application/ai
runtime/adapters/ai
```

数据流：

```text
Renderer
   │ REST / SSE
   ▼
AI Application Service
   │
   ├─ Context Builder
   ├─ Redaction
   ├─ Tool Registry
   ├─ Risk Policy
   ├─ Approval
   ├─ Run State Machine
   └─ ModelProvider
          │
          ▼
Provider Adapter
```

## 32.1 第一批 AI 功能

ADR-028 adds ordinary conversation as the default assistant entry. The selected terminal
defines the workspace: local tabs follow bounded live shell cwd metadata; SSH tabs use
local `~/.axterm` while commands run over their ready remote connection, in its reported
directory or remote login directory. Renderer reads this metadata through
`GET /api/v1/ai/workspaces/{terminalId}` and cannot choose an execution filesystem target.
Plain chat sends on the user's Send action after provider/model configuration. Attachments
and specialized requests retain context review. ADR-029 presents only `chat` (default) and
`work` modes; explanation, output explanation, command generation and diagnosis are `@`
skills loaded/validated by the pinned Pi skill loader from bundled `SKILL.md` files.
Runtime binds mode into preview receipts and run metadata. Chat advertises no command tool
and rejects direct workspace commands. Work may propose one `workspace_exec` command per model turn for
ordinary requests or diagnosis; explanation/generation skills remain reply-only in both
modes. ADR-030 allows Pi's tool callback to invoke only the Runtime Application Service;
the distinct Application tool `workspace.exec` uses automatic review for safe commands
and the existing human approval/audit flow for dangerous commands. Approval binds terminal, connection, exact
command and directory snapshot. Local subprocess groups and SSH exec streams are bounded,
cancellable and never write into a foreground CLI. Closed targets fail without fallback.
Results are redacted and returned to the native Pi loop until its final reply or a Runtime stop.
No other execution entry gains automatic approval.

按顺序：

```text
Explain Command
Explain Selected Output/Error
Generate Command
Diagnose Current Session/Host
Agent Run
```

## 32.2 Provider Contract

```ts
interface ModelProvider {
  generate(input: ModelRequest): Promise<ModelResponse>
  stream(input: ModelRequest): AsyncIterable<ModelEvent>
}
```

首个 Adapter：

```text
OpenAI-compatible
```

配置：

```text
baseUrl
model
credentialRef
capabilities
```

后续可增加：

```text
OpenAI official
Anthropic
Gemini
Qwen
Ollama
```

Vendor SDK type 不得越过 Adapter。

## 32.3 AI Context

```ts
interface TerminalAiContext {
  host?: {
    id: string
    name: string
    hostname?: string
    port?: number
    username?: string
  }
  terminalId?: string
  platform?: string
  shell?: string
  cwd?: string
  selectedText?: string
  recentOutput?: string
  recentCommands?: Array<{
    command: string
    exitCode?: number
  }>
  capabilities: string[]
}
```

默认禁止自动发送：

```text
完整 Terminal History
完整 env
Private Key
Saved Password
AI API Key
任意本地文件
任意远程文件
```

## 32.4 Redaction

ADR-025 extends the model-request path with a Runtime-owned bounded context preview and an
optional generation-scoped review receipt. Preview and send share the same builder; receipts
do not authorize tool execution. The composer permits source removal and explicitly confirms
the reviewed request for attachments and specialized tasks. Ordinary chat can send directly
with the same Runtime redaction and bounds. Existing risk/approval/audit and credential
boundaries remain mandatory.

发送模型前至少检查：

```text
Authorization header
Bearer token
API key pattern
private key block
common cloud secret
password-like key/value
known secret fingerprint match
```

Redaction 是第二道防线，不是收集无限上下文的理由。

---

# 33. AI Stream

AI Stream 使用 SSE，不占用 Terminal WS。

```text
POST /api/v1/ai/runs
GET  /api/v1/ai/runs/:id/stream
```

事件：

```text
ai.text.delta
ai.reasoning.summary
ai.tool.proposed
ai.tool.started
ai.tool.completed
ai.approval.required
ai.run.completed
ai.run.failed
```

`ai.reasoning.summary` 只能是 Provider 明确给出的用户可见总结，不得暴露隐藏 Chain-of-Thought。

---

# 34. AI Tool Layer

AI 不直接操作 `ssh2` / PTY。

必须：

```text
AI
 ↓
Tool
 ↓
Application Service
 ↓
Domain/Adapter
```

初始 Tool：

```text
host.getSummary
terminal.getRecentOutput
terminal.execReadOnly
sftp.list
sftp.readText
system.inspectDisk
system.inspectMemory
system.inspectProcesses
system.inspectService
```

后续才增加：

```text
terminal.exec
sftp.writeText
service.restart
package.install
```

Tool Contract：

```ts
interface AiToolDefinition<I, O> {
  name: string
  description: string
  inputSchema: unknown
  risk:
    | 'read_only'
    | 'mutating'
    | 'destructive'
    | 'privileged'
  execute(input: I, ctx: AiToolContext): Promise<O>
}
```

---

# 35. AI Risk / Approval

策略：

```text
read_only
→ 显式 allowlist 可自动执行；ADR-030 的助手 workspace.exec 也可通过独立模型审核低风险观察操作

mutating
→ 默认需要 Approval；ADR-030 的助手 workspace.exec 可对授权明确、范围有限的可逆修改自动审核批准

destructive
→ 永远 Approval

privileged
→ 永远 Approval
```

任何高影响命令都不能 silent run，例如：

```text
删除文件/用户
磁盘格式化
重启/关机
防火墙修改
数据库 destructive DDL
大规模权限修改
```

Privilege/Sudo Secret 不提供给模型。

## 35.1 Approval

```text
AI proposes
   ↓
Policy classify
   ↓
Approval record
   ↓
UI 显示 exact tool + args + target + reason
   ↓
Cancel / Run once
   ↓
Execute
   ↓
Audit result
```

Approval 必须绑定：

```text
runId
toolName
canonical args hash
target host/session
expiresAt
```

参数一旦变化，旧 Approval 无效。

ADR-030 的工作模式命令先由 Runtime 安全底线及独立、无工具的当前模型请求审核。
严格白名单观察命令直接通过；自动审核不能降低破坏性、提权和高影响操作的人工确认底线。
真实用户消息是唯一授权来源；助手、工具、文件和摘要不是授权。异常、证据不足、不可可靠解释的
CMD/SSH 载荷或非法审核输出转人工；产品凭据和目标边界违规直接拒绝。
审核输入上限估算 8,192 tokens、输出 1,024 tokens，超时为 Provider 超时与 30 秒的较小值，零重试。
决定还绑定目录快照、Runtime generation、策略版本；自动批准 60 秒且只消费一次，人工批准 10 分钟。
每任务最多 50 次命令尝试及 30 分钟实际运行时间，等待人工确认时暂停预算；每命令 30 秒、128 KiB，
返回模型最多 16 KiB（标明截断），可见回复累计 2 MiB，上下文保留完整调用/结果对。
最多 4 个并行工作任务、每终端一个。拒绝、过期、关闭目标、取消、启动/超时/资源错误终止整个任务；
普通非零退出码可交回 Pi 诊断。重启后中断任务与批准失效，不自动恢复或重放。

## 35.2 AiRun State

```text
queued
→ running
→ waiting_approval
→ running
→ succeeded
| failed
| canceled
```

持久化：

```text
tool call
approval
tool result metadata
```

不持久化隐藏推理过程。

---

# 36. UI / UX

> **Historical first-version context.** The following parity-oriented language
> records how the first usable desktop version was delivered. ADR-016 replaces
> it as a current product/release requirement: Axterm now validates its own
> task usability, accessibility, recovery and visual baseline rather than
> Legacy Prototype pixel similarity. The architecture, security and interaction
> invariants remain applicable; historical reference paths and screenshots do
> not.

The first-version information architecture and UI/UX used pinned Legacy Prototype 5.5.0
as a comparison baseline. The current product preserves useful terminal,
connection and file workflows while allowing targeted Axterm branding and UX
improvement under the independent-release plan.

主界面必须具备 Legacy Prototype 对应的活动栏、上下文侧栏、标签/快速连接/布局控制、多窗格会话区和底部辅助面：

```text
┌──────────────────────────────────────────┬──────────────────┬────┐
│ Tabs / Quick connect / Layout / Window   │ Context sidebar  │Rail│
├──────────────────────────────────────────┤ bookmark/history │    │
│ 1–4 Terminal / File / Remote panes       │ theme/sync/widget│    │
│                                         │ search/tree      │    │
├──────────────────────────────────────────┴──────────────────┤    │
│ Quick commands / shortcut bar / monitor / transfers / status│    │
└─────────────────────────────────────────────────────────────┴────┘
```

活动栏固定在窗口右侧，上下文侧栏紧邻其左侧展开；AI 助手与主机等面板共用该
侧栏容器和尺寸，选择图标时切换内容，不额外增加一列。AI 图标与其他入口一起
放在活动栏上方并固定为第一个，活动栏移除新建会话“＋”入口，仅保留添加书签入口；标签栏
仍提供新建终端及会话菜单。侧栏标题直接显示面板名称，不显示“工作区”小字。
右侧活动栏图标悬停或获得键盘焦点时，在其左侧显示当前语言的名称提示；移开或按 Esc 收起。
设置之外的功能导航仅打开/切换上下文侧栏，不得在主区域生成主机、AI、命令等独立功能标签；
书签管理放在侧栏，新增/编辑使用原有弹窗，当前终端保持挂载和选择。仅设置使用独立主页面。
添加 SSH 主机只打开创建弹窗，不自动打开主机书签侧栏，也不改变已有侧栏内容或展开状态。
终端信息辅助面仍在工作区右侧。
终端工作区左侧保留 24px 的空白装饰栏；右侧活动栏为 40px。上下文侧栏在宽窗口为
520px，宽度不超过 1100px 时为 440px；辅助面在宽窗口为 360px，宽度不超过
1100px 时为 340px。
AI 模型选择占完整一行，选中的模型名称完整显示，过长名称允许换行；保留原生
选择控件的键盘操作和表单语义，不与模式选择共享半行宽度。
窄窗口的侧栏和辅助面从右侧覆盖展开，保留活动栏的可点击区域。macOS 左上角原生
窗口按钮在标签栏及窄侧栏标题中按当前缩放比例与面板位置避让，不随活动栏移动。
默认背景使用中性深灰色：终端 `#1e1e1e`、面板 `#252525`、标题栏和活动栏
`#191919`，分隔线及悬浮层使用灰阶形成层次；文字保持可读对比度。

Terminal 是核心工作区；SFTP、AI、远程桌面和监控按 Legacy Prototype 的会话/辅助面关系呈现。所有可折叠面板保留焦点和选择状态。本地会话必须在同一个顶层连接标签内提供 `Terminal / File Manager` 二级标签，SSH 会话必须在同一个顶层连接标签内提供 `SSH / SFTP` 二级标签。切换二级标签不得创建 Files 顶层工作区标签，不得更换所属连接、窗格或顶层标签；终端实例保持挂载，文件地址、选择和授权状态按会话保留。FTP 等没有终端面的独立协议仍可进入专用文件工作区。

普通冷启动或关闭窗口后重新打开时，不自动恢复上次的终端、远程连接、分栏或活动工作区；
必须从单窗格中的一个全新本地终端开始。已保存的命名工作区继续持久化并可手动加载；用户后来
显式配置的启动书签/命名工作区，以及命令行或 Deep Link 启动目标，可以替代这个默认本地终端。
从旧版本升级时清除历史的自动布局恢复和启动会话默认值，但不得删除命名工作区本身。

The former 1:1 gate compared fixed screenshots at 1280×800, 1440×900 and
1920×1080 with a 95% pixel threshold. That threshold and its reference corpus
are historical evidence only. Current UI acceptance requires Axterm-owned
three-viewport baselines plus keyboard, accessible-name/focus, contrast,
overflow, supported-language direction, error/recovery and real business-flow
coverage. A visual score
cannot waive any of those failures, nor can it substitute for brand or
trademark review.

Axterm may retain useful workflows but must not represent historical behavior
as an ongoing upstream acceptance requirement. The current release status is
governed by ADR-016 and the independent-release matrix.

---

# 37. UI State Ownership

TanStack Query：

```text
hosts
groups
settings
quick commands
tunnel profiles
AI metadata
transfer history
```

Zustand：

```text
active tab
split layout
sidebar open/close
AI inspector open/close
selected IDs
workspace ephemeral state
```

禁止：

```text
terminal stdout → Zustand
terminal stdout → React useState
```

Terminal：

```text
WebSocket Uint8Array
      ↓
xterm.write()
```

Keyboard：

```text
xterm.onData
      ↓
TextEncoder
      ↓
WS binary
```

---

# 38. Renderer Security

BrowserWindow：

```text
nodeIntegration = false
contextIsolation = true
sandbox = true（与极小 preload 兼容时）
webSecurity = true
webviewTag = false
```

Preload 的 IPC 只允许 `desktop:bootstrap`。
[ADR-026](../adr/ADR-026-native-directory-drop-metadata.md) 允许独立的、无参数、单次消费
本地目录拖放元数据 accessor；只接纳有界可信原生目录 drop，不读取内容，不进行 RPC、
不暴露 Electron object，不接受任意路径。目录授权与终端插入仍通过既有 REST/File Grant。

首次启动且没有已保存窗口位置时，主窗口使用 **1440×900**。用户第一次移动或调整窗口后，
Desktop Host 可以保存并恢复经显示器工作区校正的 bounds；恢复结果不得落在当前显示器之外。

必须：

- CSP；
- 禁止任意 `window.open`；
- Navigation allowlist；
- Electron Session 权限默认拒绝；仅主窗口当前受信任的顶层 Axterm 文档可使用
  `clipboard-read` 和 `clipboard-sanitized-write`，用于终端、编辑器和文件管理器的系统剪贴板；
  子 frame、外部 origin、Native Web View 及其他权限保持拒绝；
- 外链通过 Runtime → Host validated external URL；
- 禁止 remote script；
- 禁止 eval；
- Renderer 无 Node builtin；
- Renderer 无 Electron import；
- Renderer 不保存 Secret。

---

# 39. Local Runtime Security

Desktop Local Mode：

```text
bind = loopback only
port = OS-assigned
auth = per-generation random
origin = explicit allowlist
```

必须：

- 不监听 `0.0.0.0`；
- 不 wildcard CORS；
- 校验 Origin；
- 限制 request body；
- timeout；
- 敏感 endpoint rate limit；
- Token 不进 URL；
- Token 不进 log；
- WS auth；
- generation 改变后旧 session 全失效。

开发环境只 allow Vite dev origin。

生产环境优先由 Runtime 提供 Renderer static assets，让 UI 和 API origin 简单一致；Auth 仍使用内存 session token。

---

# 40. Renderer Build / Serve

开发：

```text
Electron → electron-vite / Vite dev renderer
Renderer → Runtime loopback random port
```

生产：

```text
Electron → Runtime baseUrl
Runtime → built Renderer static assets
Renderer → same Runtime origin
```

Runtime static serving 只是 Infrastructure，不允许业务层依赖 React 实现。

生产构建时必须确保 Runtime 能从打包后的 resources 找到 Renderer dist。

Main 可以在 Runtime startup envelope 中提供 Renderer asset directory；该路径只属于 trusted process internal，不给 Renderer。

---

# 41. 日志与诊断

使用 `pino` structured log。

字段：

```text
timestamp
level
component
runtimeId
generation
traceId
operationId
connectionId?
terminalId?
transferId?
aiRunId?
message
safe metadata
```

禁止日志：

```text
password
API key
private key body
runtime token
bootstrap token
full terminal output
unredacted AI context
arbitrary file body
```

Desktop Host 与 Runtime 分开日志和 rotate。

Diagnostics：

```text
app version
runtime version
runtimeId/generation
runtime health
active resource counts
last crash
migration version
credential vault storage (`local`)
sanitized recent error
```

---

# 42. Resource Lifecycle

以下全部必须有 owner + deterministic cleanup：

```text
HTTP listener
SSE stream
WebSocket
SSH connection
SSH channel
PTY
SFTP handle
file stream
tunnel listener/socket
timer
watcher
AI stream
utility process
SQLite handle
```

API 要成对：

```text
start / stop
open / close
subscribe / unsubscribe
acquire / release
```

测试 teardown 后长期资源数量必须归零。

---

# 43. Idempotency / Concurrency

需要 `Idempotency-Key` 的典型 operation：

```text
create transfer
start tunnel
start AI run
其它 job-like mutation
```

Client timeout 后不得盲目重试未知结果 mutation。

需要 ETag / If-Match 的典型对象：

```text
Host
QuickCommand
TunnelProfile
Settings section
```

冲突返回：

```text
HTTP 412 + Problem Details
```

---

# 44. Runtime Connection Manager

Client 状态：

```text
idle
→ discovering
→ attaching
→ authenticating
→ negotiating
→ ready
→ reconnecting
→ degraded
→ disconnected
→ incompatible
```

职责：

- bootstrap/discover；
- auth；
- GET version/capabilities/runtime；
- API compatibility；
- 安全重连 GET；
- 重连 SSE；
- generation change 清 cache；
- AbortController 取消旧请求；
- 不自动 replay unsafe mutation。

---

# 45. Testing

## 45.1 Unit

覆盖：

```text
Domain invariant
state machine
validators
risk classification
redaction
path normalization
policy
adapter mapping
```

## 45.2 Runtime Integration

真实启动 Runtime：

```text
temp SQLite
fake Host Capability
random port
SSH fixture where feasible
```

必须测真实 HTTP Contract。

## 45.3 Contract

覆盖：

```text
valid request
invalid body/path/query
invalid auth
invalid origin
Problem Details
Idempotency-Key
If-Match conflict
OpenAPI drift
```

## 45.4 SSE

覆盖：

```text
heartbeat
disconnect
persistent replay
duplicate delivery
slow consumer
generation change
```

## 45.5 WS

覆盖：

```text
binary stdin/stdout
resize
exit
invalid control frame
auth failure
backpressure
shutdown cleanup
```

## 45.6 Fault Injection

覆盖：

```text
Runtime startup failure
Runtime crash
SSH disconnect
transfer failure
migration failure
AI provider timeout
AI cancellation
Host capability unavailable
credential vault unavailable
```

## 45.7 Desktop E2E

关键链路：

```text
launch
→ Runtime ready
→ create host
→ local terminal
→ SSH fixture
→ execute command
→ SFTP basic flow
→ AI explain mock provider
→ restart app
→ persistent data remains
```

## 45.8 Legacy Prototype Parity

每个 `LEGACY_PROTOTYPE_PARITY_MATRIX.md` 条目按适用范围提供：

```text
pinned upstream path/test
Axterm implementation link
unit/runtime behavior test
Playwright mouse + keyboard flow
reference/Axterm screenshot pair
packaged platform evidence
```

视觉回归使用确定性 fixture 和动态区域 mask。不得通过扩大 mask、提高阈值或删除交互断言掩盖真实差异。每个设置键和用户动作都必须映射到矩阵条目或经 ADR 批准的 Not applicable 结论。

---

# 46. Packaging

使用：

```text
electron-builder 27.x
```

重点：

`node-pty` 是 native dependency。

必须验证 packaged app：

```text
macOS
Windows
Linux
```

ADR-022 为**后续首次商业发行任务**设定完成线：实际签名、公证、公开下载的 macOS arm64
安装包及共同源码/权利门禁验收。Windows/Linux 仍为兼容目标，相关构建路径不得
退化；原生包安装、升级和协议测试由所有者自行在对应电脑完成，不阻断该首次发行任务完成，
也不能用 Mac 或模拟 Linux 结果代签为三平台验收通过。

要求：

- native dependency 放正确 dependencies；
- 使用 electron-builder native rebuild；
- 检查 Electron ABI；
- 检查 ASAR；
- 如必须 `asarUnpack`，只配置最小 precise pattern；
- 不依赖 workspace 源路径；
- 不依赖用户系统 Node；
- Runtime entry 正确打包。

Runtime utility entry 优先采用 electron-vite 官方支持的 `?modulePath`/isolated build 机制或当前稳定等价方式。

---

# 47. Updater

Updater 由 Desktop Host 管理。

Runtime 只能通过 Host Capability 查询：

```text
status
available version
progress
error
```

Runtime 不直接操作 Electron updater object。

后续首次商业发行按 ADR-022 采用公开 HTTPS 页面**手动更新**。在没有正式
签名更新源时，provider 必须保持 inert、无网络请求，产品中不得出现可操作但不可用或
误导用户的自动更新入口；About/发行说明要指向经验证的版本、哈希和下载流程。
自动更新仍按 ADR-015 后续验收，配置时不得降低签名、来源、下载和 Host 边界要求。
历史 1.0 如果没有正式更新服务器，可以 provider disabled，但必须保留：

```text
interface
status model
error handling
UI entry
packaging boundary
```

配置更新源后，Desktop Host 还负责签名清单校验、有界流式下载、进度、取消、错误和安装包
交接。Runtime 只通过 Host Capability 查询状态或提交 `check`、`download`、`cancel`、`install`
动作；URL、本地临时路径和 updater object 不越过 Host 边界。具体决策见
`ADR-015-signed-desktop-update-provider.md`。

---

# 48. Historical parity roadmap / Codex phases

本节保留首版阶段边界和旧 Acceptance 的历史口径。原上游依据、差距、状态和证据仍可在
`LEGACY_PROTOTYPE_PARITY_MATRIX.md` 查阅，但 ADR-016 已取代这条路线的当前执行权。
新工作按 `COMMERCIALIZATION_CLEANUP_PLAN.md` 和 `STATUS.md` 领取，不得把旧 95% 像素
或 121/122 阈值当成商业发行证明。当前仓库也不得重新执行 Phase 0 初始化。

每阶段结束至少运行：

```text
bun run lint
bun run typecheck
bun run test
bun run architecture:check
bun run build
```

## Phase 0 — Repository Foundation

目标：先把正确骨架跑起来。

Deliverables：

- Bun workspace；
- TS strict；
- ESLint/Prettier；
- `apps/desktop`；
- `packages/runtime/contracts/client/db-schema/shared`；
- electron-vite；
- Electron Main；
- minimal Preload；
- Runtime utilityProcess；
- Hono `/health`；
- `/api/v1/version`；
- `/api/v1/runtime`；
- `desktop:bootstrap`；
- React 19；
- Tailwind v4；
- shadcn/ui；
- UI Runtime status；
- architecture gate；
- Vitest/Playwright 基础；
- STATUS/VERSIONS。

Acceptance：

- clean clone `bun install` 成功；
- `bun run dev` 启动 Desktop；
- UI 显示 runtimeId/generation；
- Runtime 在 utilityProcess；
- Runtime 不 import Electron；
- Renderer 无业务 IPC；
- `bun run check` 通过。

## Phase 1 — Persistence / Contract / Host Manager

Deliverables：

- SQLite/Drizzle；
- migrations；
- Host/Group；
- Settings；
- Zod OpenAPI；
- OpenAPI JSON；
- Generated Client；
- Host CRUD UI；
- Problem Details；
- Connection Manager。

Acceptance：

- Host/Group restart 后保留；
- Renderer 无 DB access；
- Contract drift check；
- Invalid request typed error。

## Phase 2 — Local Terminal

Deliverables：

- PtyAdapter；
- node-pty；
- Terminal Application Service；
- Runtime Session Registry；
- WS Protocol；
- xterm；
- resize/exit/close；
- profile。
- 默认 cwd 使用系统用户主目录；显式 Profile cwd 或授权目录可以覆盖。

Acceptance：

- 本地 Shell 可交互；
- resize 生效；
- interactive program 可用；
- close 后 PTY/listener 清零；
- output 不进入 React/Zustand；
- backpressure 存在。

## Phase 3 — SSH Terminal

Deliverables：

- ssh2 adapter；
- Connection state machine；
- password/key/passphrase；
- credentialRef；
- Host Key；
- Keyboard Interactive；
- SSH Terminal；
- realtime status。

Acceptance：

- SSH fixture 成功；
- Unknown key 需要确认；
- Changed key 高风险提示；
- Saved secret 不在业务 DB plaintext；
- Stream cleanup。

## Phase 4 — SFTP / File Grant / Transfer

Deliverables：

- Native Dialog；
- grant registry；
- SFTP；
- upload/download；
- transfer progress；
- cancel/retry；
- UI。

Acceptance：

- 大文件不 Base64；
- Renderer 无任意 path；
- cancel cleanup；
- repeated transfer 无 leak。

## Phase 5 — Productivity Workspace

Deliverables：

- tabs；
- split panes；
- recent connection；
- quick command；
- search；
- command palette；
- safe web links；
- SSH config import via grant；
- terminal profile；
- jump host。

Acceptance：

- keyboard-first workflow 可用；
- jump host cycle validation；
- quick command 默认 insert，不自动 execute；
- 持久业务仍走 Runtime。

## Phase 6 — SSH Tunnels

Deliverables：

```text
local forwarding
remote forwarding
dynamic SOCKS
profiles
active tunnel lifecycle
status
```

Acceptance：

- start/stop deterministic；
- Runtime shutdown 关闭 listener/socket；
- repeated start/stop 无 leak；
- invalid config typed error。

## Phase 7 — AI Foundation

Deliverables：

- AiProvider/AiModel schema；
- API Key CredentialRef；
- OpenAI-compatible adapter；
- streaming；
- Explain Command；
- Explain Output；
- Generate Command；
- Redaction；
- AI 助手（AI Assistant）。

Acceptance：

- Renderer 不含 Provider SDK；
- API Key 保存后不可读回 UI；
- Generate Command 不自动执行；
- context bounded/redacted；
- stream cancellation。

## Phase 8 — AI Diagnosis / Agent

Deliverables：

- AiRun；
- Tool Registry；
- read-only diagnostic tools；
- risk policy；
- approval；
- mutating tool；
- audit UI；
- cancellation。

Acceptance：

- read-only allowlist 显式；
- mutating/destructive/privileged 按 Policy；
- approval exact args hash；
- 参数变更旧 Approval 失效；
- tool execution auditable；
- 不故意发送 secret。

## Phase 9 — Reliability Hardening

Deliverables：

- Runtime restart/backoff；
- stale generation；
- SSE replay；
- Idempotency；
- migration recovery；
- fault injection；
- leak tests；
- diagnostics。

Acceptance：

- Kill Runtime → 自动 restart；
- Renderer reconnect；
- old active session 标记失效；
- persisted DB 正常；
- old generation event 被拒绝。

## Phase 10 — Packaging / Desktop 1.0

Deliverables：

- electron-builder；
- macOS；
- Windows；
- Linux；
- node-pty native verification；
- icon/app metadata；
- signing config boundary；
- updater boundary；
- production CSP；
- fresh install smoke。

Acceptance：

- packaged app 启动；
- Runtime 启动；
- local terminal；
- SSH；
- SQLite writable path；
- node-pty load；
- 不依赖 source/workspace；
- 第 49 节 DoD 全通过。

Phase 11–21 执行 ADR-003 的 Legacy Prototype 复刻计划。Phase 10 的 Windows、Linux 和升级实机证据可保持 open，但不能阻止不依赖这些环境的 Phase 11 工作；Phase 21 必须同时关闭 Phase 10。

复刻阶段按依赖顺序推进实现，但矩阵认证允许跨阶段回填。一个较早阶段可以在
Acceptance 仍 open 时进入后续阶段，前提是未完成项及其依赖阶段在矩阵中明确记录，
且不得把占位、disabled 入口或仅有外观的控件标成 Certified。例如 A-01 的主题、
同步和 Widget 入口要等 Phase 18/19 的真实 surface，A-04 要等 Phase 17 的协议会话，
A-11 要等 Phase 16/17 的文件与远程控制，A-12 还需要 Phase 19/21 的平台窗口证据。
Phase 21 负责关闭所有这类跨阶段依赖；此规则只解除实施死锁，不降低任何证据门槛。

J-01 的长期资源认证门槛固定为 30 分钟，旧的更长门槛已经删除。2026-09-14 的既有轮廓
运行 31 分 27 秒、完成 1812 轮且零违规，另有正常结束的 729 轮加速回归和 60 秒冒烟证明
最终 owner 归零。用户明确接受该组合证据并要求不再重跑，因此 J-01 可标记 Certified。
正式发行状态仍按本节和 Phase 21 的其他 Acceptance 保持 open。

### 48.1 历史首版实施的阻塞登记与超过 99% 的收口

> This 122-row/99% policy is historical parity evidence. It is not an
> independent-release completion rule and cannot be used to waive any ADR-016
> source, migration, rights or platform requirement.

Legacy Prototype 复刻仍以 122 项全部通过为常规目标。为了避免外部平台、证书、硬件或可复现的
技术障碍让整个实施停滞，执行时使用以下规则：

- 遇到阻塞先在 `STATUS.md` 的 Blocker Register 登记任务 ID、关联 Matrix 行、阻塞原因、
  已取得的最后证据、已完成部分、解除条件和后续回填位置，然后继续下一项可执行工作。
- “工作量大”“尚未实现”或一次失败不构成阻塞；必须存在当前环境内无法继续推进的客观
  条件或经过复现仍无法解除的技术障碍。
- 实施覆盖率只按 `(Certified + 经 ADR 批准的 Not applicable) / 122` 计算。`Missing`、
  `Partial`、`Implemented` 和 `Blocked` 都不计入覆盖率。
- 用户接受的实施收口线是严格超过 99%，即至少 121/122；因此最多只有一个 Matrix 行可
  作为已登记的 Blocked 项留待回填。达到该阈值时可以报告“复刻实施达到 99% 交付线”，
  但不得把剩余项写成 Certified。
- 架构边界、Runtime loopback/auth、凭据保密、数据完整性、流式资源上限、AI 修改审批和
  第 49 节明确要求的发行安全门禁不可由覆盖率规则豁免。外部平台证据卡住时可以继续后续
  实施并达到 99% 交付线，但 Phase 10、Phase 21 或 Desktop 1.0 的正式发行状态继续 open。

## Phase 11 — Historical Parity Harness / Reference Design System

> Phases 11–21 below document the first-version parity implementation. They
> remain useful historical evidence but do not form the current work queue or
> release gate; use the commercialization plan and independent matrix instead.

Deliverables：

- 固定 Legacy Prototype reference launcher 和版本校验；
- route/screen/modal/menu/state scenario manifest；
- 1280×800、1440×900、1920×1080 截图库与动态 mask；
- Playwright 视觉 diff 和交互 trace helper；
- SSH/SFTP/FTP/Telnet/Serial/RDP/VNC/SPICE/Web/AI/Sync fixture 接口；
- Legacy Prototype → Axterm color/spacing/type/elevation/icon/motion token map；
- setting/action 未映射报告；
- 矩阵证据索引。

Acceptance：reference corpus 可重复生成；固定页面满足可比较条件；CI 输出视觉差异和未映射项，不把 Legacy Prototype 打进 Axterm 安装包。

## Phase 12 — Shell / Navigation / Tabs / Layout / Workspace

复刻活动栏、上下文侧栏、Quick Connect、新建菜单、标签溢出和全部上下文操作、pin/duplicate/reload、1–4 pane 布局、resize/focus/swap/clone、named workspace、empty state、session controls、title bar 和 window controls。Session controls 必须让本地 `Terminal / File Manager` 与远端 `SSH / SFTP` 成为所属连接标签内的二级视图，并在多窗格中分别保持状态。

Acceptance：Parity Matrix A 组全部 Certified。

## Phase 13 — Bookmarks / Groups / Profiles / History / Migration

复刻 nested bookmark tree、搜索高亮、拖放与排序、color/category/description、
session/command history、protocol profile、完整协议表单、SSH Config import preview、
Legacy Prototype data importer/exporter、save/connect/create-new 路径。独立 labels 若保留为
Axterm 扩展，不作为 pinned Legacy Prototype 5.5.0 的 1:1 认证项。

Acceptance：Parity Matrix B 组全部 Certified；迁移可预览、可取消、重复执行安全，secret 不进入业务 DB。

## Phase 14 — Terminal UX

复刻终端 context menu、search、OSC 52、timestamp、Unicode/ligature/image addon、renderer、font/cursor/key behavior、encoding/raw/env、background、session log、reconnect、shortcut bar、command suggestion 和 file drop。

终端粘贴先保留 Legacy Prototype 将内容交给 xterm 的输入路径，再对本地终端和 SSH 中明确的 Shell
语法续行做保守归一化：换行前为未引用且未转义的 `|`、`||`、`|&` 或 `&&` 时，将缩进
续行合并为同一输入行。完整且只有一个终止符的 SQL 语句可以在括号/引号平衡、没有注释、
跨行字符串或 dollar-quoted body 时将格式换行折叠为空格，避免交互式数据库客户端堆叠续行
提示符。行尾反斜杠、普通多命令、多条或不完整 SQL、引号内换行、注释、here-document、
空续行目标及 Telnet/Serial 原始输入不得改写；归一化后仍为多行或超过 500 字符时继续执行
可预览、可取消的粘贴保护。

Acceptance：Parity Matrix C 组除 C-16 的终端传输协议外全部 Certified。

## Phase 15 — SSH / Proxy / Hopping / Tunnels

补齐 certificate/agent/OTP UI、Host Key 管理、global/session proxy、ProxyCommand、jump chain editor、algorithm/compression、ordered scripts、environment/encoding、X11 和 bookmark-scoped tunnels。

Acceptance：Parity Matrix D 组全部 Certified；真实 fixture 覆盖所有启用的认证、代理、跳板和隧道路径。

## Phase 16 — File Manager / Editor / Transfer Center

复刻 local/remote dual pane、地址历史/书签、filter/sort/columns/pagination、多选和键盘操作、context menu、cut/copy/paste、双向拖放、remote-to-remote、冲突对话框、pause/resume/history、internal/system editor、compare、permission/info、compress-and-transfer 和 native reveal/open-terminal。本地文件面嵌入本地会话，SFTP 文件面绑定对应 SSH connection；从侧栏、传输中心、命令面板或终端 cwd 打开文件时，统一激活所属会话的二级文件视图。

本地文件面默认打开系统用户目录；SSH 的 SFTP 文件面默认使用 `realpath('.')` 得到远端账号
目录。远端列表必须支持从操作系统文件管理器直接拖入普通文件并立即开始队列上传。

Acceptance：Parity Matrix E 组全部 Certified；所有大文件仍走 stream，watcher/channel/temp file 有确定性 cleanup。

## Phase 17 — Protocol Parity

实现 FTP/FTPS、Telnet、Serial、RDP、VNC、SPICE、Web session 和 Zmodem/Xmodem/trzsz。Adapter 可以不同于 Legacy Prototype，但新增 native dependency、proxy process 或 trust boundary 必须先写 ADR。

Acceptance：Parity Matrix F 组与 C-16 全部 Certified；真实协议 fixture 与 packaged native test 通过。

## Phase 18 — Commands / Automation / Monitoring / Widgets / CLI

复刻 Quick Command tree/templates/assignment、batch input、batch operation、trigger engine、login/run script、terminal info、remote monitor bar/details、widget lifecycle、local file/FTP/SSH server widget、deep link 和 CLI。

Acceptance：Parity Matrix G 组除 MCP 专属行为外全部 Certified；poller、server 和 automation 都有容量、owner、取消和审计。

## Phase 19 — Settings / Themes / Sync / Localization

映射 pinned `default-setting.js` 全部设置；复刻设置导航、theme CRUD/preview/import/export/AI entry、background、shortcut conflict editor、global hotkey、window/multi-display behavior、data/password import/export、selected-category sync、GitHub/Gitee gist、WebDAV/custom server 和语言切换。

Terminal Theme 是 Runtime 持久资源。内建 dark/light 主题只读，自定义主题使用 SQLite 与
实体 ETag；列表、搜索、调色板预览、新建、克隆、编辑和删除只通过 REST/生成 Client。
Legacy Prototype `key=value` 文本导入导出保留 12 个 UI 颜色角色与 21 个 terminal/xterm 颜色角色，
拒绝缺失、未知或非法颜色。Renderer 只持有草稿和 File Grant ID；Desktop Host 选择路径，
Runtime 有界读取并原子写入。主题应用范围、背景图片/文字/filter 与实时 xterm 更新属于 H-04，
不得让 H-03 的编辑预览隐式改变活动会话。H-04 使用 `Settings.terminal.visual` 保存全局
默认值，并允许 Workspace Terminal Tab 保存会话覆盖；当前主题编辑器只为活动会话建立
可撤销的实时预览。背景图片必须经 Desktop File Grant 导入，Runtime 校验 PNG/JPEG/GIF/WebP
文件头和 16 MiB 上限后流式复制到应用私有目录，再经认证 HTTP 流返回；Renderer 只持有
不透明 asset ID 和可撤销 Blob URL，不能得到源路径或 Runtime 私有路径。文字背景及 opacity、
blur、brightness、grayscale、contrast 均使用有界 Contract，xterm theme 在原会话内即时更新。

H-05 使用一份包含 23 个固定 Legacy Prototype 动作的类型化 Action Registry。Registry 定义 macOS 与
Windows/Linux 默认组合、应用/终端作用域和只读组合；设置只保存稀疏覆盖，并通过 Settings ETag
并发更新。编辑器按物理键位捕获键盘或带修饰键的滚轮，每个动作最多两个组合，保存前必须检查
其他有效动作、Quick Command 和 Axterm 保留导航组合。应用和终端都从同一 Registry 分发，
禁止在组件中保留会绕过用户覆盖的业务快捷键。普通缓冲区快照、字体缩放和 SFTP 路径跟随继续
遵守有界数据、活动会话 owner 和 Renderer/Runtime 边界。

H-06 的全局窗口显隐热键属于 Desktop Host 原生能力。默认值固定为 Legacy Prototype 的 `Control+2`，
保存于应用本地 window preferences；Main 在 `app.whenReady()` 后通过 Electron
`globalShortcut` 注册，并在 Host 关闭时确定性注销。更换组合必须先成功注册新组合再注销旧组合，
操作系统拒绝时返回类型化冲突并保留旧配置；清空表示显式关闭。窗口聚焦且可最小化时触发会最小化，
其余状态触发会恢复、显示并聚焦当前窗口。Renderer 只经 Runtime 转发的 Host REST Contract
读取注册状态和更新配置，不得 import Electron 或新增业务 IPC。

H-07 将 title bar、opacity、zoom、bounds、退出确认和 `allowMultiInstance` 保存在同一严格的
应用本地 window preferences 文档。Main 必须在申请 Electron 单实例锁前只读加载多实例策略；
修改该策略或标题栏时明确返回需要重启，opacity/zoom/bounds 可即时应用。普通窗口 move/resize
使用首尾节流持久化，退出前 flush；最大化和全屏几何不得覆盖普通 bounds。恢复时保留当前左右/
上方显示器的 DIP 坐标和负坐标，限制到目标 work area，已断开的显示器回到主显示器中央；首次启动
仍为 1440×900。`run.ts` 启动的非 packaged Main 必须使用 `Axterm Dev` 产品名、独立 userData
目录、单实例锁和 Windows AppUserModelID；显式 `--user-data-dir` 仍优先，用于隔离测试。开发版
不得激活、读取或覆盖已安装 Axterm 的进程和数据。启用退出确认时，Desktop Host 串行显示一个
原生确认框，取消无副作用，确认只放行一次关闭，应用 shutdown 不重复提示。

H-08 复用 B-10 的有界产品数据通道并升级为 Axterm 便携格式 v2。导出文件可以包含
Runtime 设置、应用本地 window preferences，以及 Host Vault 中的凭据类型、标签和创建/更新时间；
不得包含凭据原文、`credentialRef`、窗口 bounds、代理凭据引用、工作区实体引用或背景图片资产。
预览必须逐项显示 create/unchanged/skip、映射字段和省略字段；凭据元数据只用于报告，不能据此
创建空凭据，携带 secret/password/private-key/token/ref 一类字段的元数据必须拒绝。提交前复核
书签树 ETag、Settings ETag 和完整 window-preferences 快照；数据库业务项、设置和持久事件同事务
写入，若此前已应用 Desktop preference patch 而事务失败，必须补偿恢复原偏好。由 Axterm 导出的
目标实体 ID 在回导时解析为现有对象，不能重复创建。导入取消、预览过期和成功结束都释放 File Grant
与预览状态。

H-09/H-10 使用 ADR-014 定义的 Runtime-owned 同步域。SQLite 只保存 Provider 类型、服务地址、
远端 ID、用户名、八类数据选择、自动同步间隔/方向、运行状态和不透明远端 revision；访问凭据与
可选加密密码只保存于 application-local Host Vault，业务数据库和公开资源只保存/返回
`credentialRef` 的内部引用或 configured 布尔值。不得探测、调用或提示系统钥匙串。同步类别固定为
Settings、Bookmarks、Terminal Themes、Quick Commands、Profiles、文件地址书签、命名工作区和
Triggers，每类文档包含有界值、数量和内容哈希。下载先生成十分钟有效的可恢复预览，手动和自动
下载都必须显式确认；Runtime generation 变化会使预览失效，修改操作不会自动重放。

Provider Adapter 固定覆盖 GitHub/Gitee Gist、WebDAV 和 Legacy Prototype-compatible custom server。
GitHub/Gitee 使用 `axterm-sync.json` Gist 文件；WebDAV 使用服务根下的 `/legacy-prototype/` 集合；custom
server 使用五分钟 HS256 JWT。凭据只进入认证 Header，endpoint 禁止内嵌用户名、密码、query 和
fragment。JSON 明文上限 16 MiB，Provider response/envelope 上限 24 MiB；传输使用流式有界读取、
30 秒超时和 `AbortSignal`。上传在写入前重新读取 revision，并通过 ETag/内容哈希拒绝并发覆盖。
可选远端文档加密使用 AES-256-GCM 与 scrypt 派生键，派生键在每次操作结束时清零。Renderer 只用
生成 REST Client 进行配置、比较、上传、下载、取消、预览和提交，不直接访问网络 Provider。

> The following fixed-source/410-key language description is historical
> first-version context only. The current independent language policy appears
> immediately after it.

H-11 的语言资源固定来源为 pinned Legacy Prototype 使用的
`@legacy-prototype/legacy-prototype-locales@2.3.16` MIT 数据。项目提交生成后的 15 语言、每语言 410 个同序键
快照；生成脚本在 Legacy Prototype 开发依赖可用时逐字验证漂移，在干净检出中至少校验固定版本、许可、
语言顺序、键顺序和字符串类型。`Settings.appearance.language` 是唯一持久事实源，Renderer 的
Query Provider 订阅同一 Settings cache 并即时设置 `document.documentElement.lang`、`dir` 和
可见文案，不要求重启，也不在 localStorage/Zustand 保存第二份语言状态。阿拉伯语使用 RTL；
缺失翻译按“所选 Legacy Prototype 文案 → English Legacy Prototype 文案 → 显式 fallback/key”解析。Axterm
专有文案至少提供 English，其他语言缺失时回退 English。插值只返回由 React 渲染的文本字符串，
不得返回 HTML、使用 `dangerouslySetInnerHTML` 或通过 DOM 扫描替换文本。H-11 只有在所有可见
Renderer surface 迁移、未编目文字审计为零且 LTR/RTL 三档布局与三平台证据通过后才能 Certified。
迁移期间 `locales:audit` 使用 TypeScript AST 对 `renderer/src/i18n` 之外的 CJK string、template
和 JSX text 做精确库存比较；任何新增或意外变化都使门禁失败。该非零基线只能证明差距没有
回退，必须随迁移单调下降，并在 H-11 Certified 前归零。终端等纯模型返回稳定语义代码，由
React surface 按当前语言翻译，避免把某一种语言固化进协议、状态机或资源生命周期。

以上 H-11 的固定上游快照、410 键和 Legacy Prototype 回退顺序只记录首版 parity 实施，已由
ADR-016 取代为历史依据。当前独立产品使用 Axterm 自有的 English、Japanese、Simplified
Chinese 和 Traditional Chinese 四个语言目录、45 个实际导航键的确定性源文件与生成校验，
不得再读取或打包上游语言快照；语言切换、单一 Settings 事实源、当前所有保留语言的 LTR
方向、纯文本插值及所有可见文案接入等架构和安全要求继续有效。已移除语言的已保存设置必须
安全回退到 English。译文人工审校、其他 Axterm 文案的 English fallback 范围及三平台发行
证据仍按 P-04/IR-05 验收，不因生成器通过而视为完成。

Acceptance：Parity Matrix H-01 至 H-11 全部 Certified；设置键未映射报告为零。

## Phase 20 — AI / MCP Parity

复刻 AI config、OpenAI Chat/OpenAI Responses/Anthropic adapter、chat session/history、selection explain、suggestion/cache、bookmark/theme creation、attachment、agent tool card 和 MCP server widget。继续使用 bounded/redacted context、Tool Registry、Risk Policy、exact-args Approval 和 Audit。

Acceptance：Parity Matrix I 组全部 Certified；MCP 不绕过任何 Application Service 或 Approval Policy。

## Phase 21 — Parity Certification / Reliability / Distribution

完成长期运行、网络/休眠/Runtime fault、10k tree/directory/queue 性能、keyboard/accessibility、全量视觉 corpus、macOS/Windows/Linux packaged golden journey 和 upgrade。所有视觉场景必须达到固定的 95% 相似度且通过硬伤审查；不得针对单个失败场景继续提高阈值或用“已知问题”关闭条目。

Acceptance：常规目标为矩阵不存在 Missing/Partial/Implemented/Blocked，只有 Certified 或
ADR 批准的 Not applicable；若采用第 48.1 节的实施收口规则，则至少 121/122 达到上述状态，
唯一剩余行必须有完整 Blocker Register。Phase 10 和第 49 节 Distribution 未完成时，Phase 21
正式发行认证继续 open；`bun run check` 与所有当前可执行 packaged suites 必须通过。

## Phase 22 — Headless / Remote Runtime（Parity 后）

增加 Node 24 headless config/CLI、TLS/reverse proxy、durable user/device auth、session revocation、rate limit、audit 和 remote policy。禁止把 Desktop Local token 直接暴露到 LAN/Internet。

## Phase 23 — Expo 57 Mobile（Parity 后）

Mobile 第一版连接 Remote Runtime，共享 contracts/client/schemas/pure types/utils/design token，不强行共享 shadcn Web Component。

## Phase 24 — Extension Ecosystem（按真实需求）

只有 Level 1 产品和内部 Tool/Permission/Approval 验证可靠、且有真实第三方扩展需求后，才评估 Level 2/3、Extension Host 和 Marketplace。升级必须另写 ADR。

---

# 49. Desktop 1.0 Definition of Done

本节中架构、安全、功能真实可用与三平台发行条件继续有效，不承担实时进度记录。
本节是**完整三平台 Desktop 1.0** 的完成定义；ADR-022 的后续首次商业发行须按
`docs/implementation/MINIMUM_COMMERCIAL_RELEASE.md` 单独验收，不将下列 Windows/Linux
条目标记完成或删除。
旧 parity 专属的相似度/矩阵认证条件按 ADR-016 转为历史证据；新来源、许可、迁移和
独立产品条件由商业化清理计划补充。当前状态只在 `STATUS.md` 更新；不要通过修改
本节的文字宣称完成。

## Architecture

- Electron Main 没有业务 Domain/Repository/Workflow。
- Runtime 不 import Electron。
- Renderer 不 import Node/Electron/Drizzle/ssh2/node-pty。
- 没有 Electron Business IPC。
- Formal API versioned + OpenAPI。
- Terminal 使用独立 WS Protocol。
- Runtime 可独立 Integration Test。

## Function

- Local Terminal。
- SSH Terminal。
- Password/Key/Passphrase/Keyboard Interactive。
- Host Key verification。
- SFTP。
- Upload/Download/Cancel/Retry。
- Host/Group persistence。
- Tabs/Split。
- Quick Commands。
- Jump Host。
- Local/Remote/Dynamic Tunnel。
- AI Explain/Generate/Diagnose。
- AI read tools。
- AI mutation approval。

## Security

- Desktop Runtime loopback only。
- Explicit CORS/Origin。
- Per-generation Runtime auth。
- Credential Vault。
- Secret 不进日志。
- Renderer 不保存 Secret。
- Terminal history 默认不持久。
- External URL Host validation。
- CSP production-safe。

## Reliability

- Runtime restart test。
- stale generation test。
- SSE reconnect/replay test。
- migration failure/recovery test。
- transfer cancellation cleanup。
- terminal leak test。
- repeated open/close test。

## Distribution

- macOS packaged smoke。
- Windows packaged smoke。
- Linux packaged smoke。
- node-pty packaged works。
- fresh install/upgrade smoke。

## Historical Legacy Prototype parity release gate

This retired gate is retained only to explain the first-version evidence. It
does not apply to the independent product or override ADR-016.

- `vendor/legacy-prototype` baseline 与 ADR-003 一致。
- Parity Matrix 常规状态不存在 Missing / Partial / Implemented / Blocked 条目；允许按 §48.1
  报告至少 121/122 的复刻实施交付，但剩余行及对应阶段必须保持 open。
- Shell、Bookmarks、Terminal、SSH、Files、Protocols、Automation、Settings、AI/MCP 达到
  122/122 Certified/approved N/A，或以至少 121/122 加唯一登记 Blocked 项达到实施交付线。
- 参考视口视觉 corpus 达到 §36 阈值。
- 鼠标、键盘、拖放、context menu、focus 和 recovery golden workflows 通过。
- macOS / Windows / Linux packaged parity journey 通过。
- Legacy Prototype data migration 报告完整且 secret 安全。
- 所有新增 adapter 仍通过 Architecture / Contract / lifecycle / redaction gate。

---

# 50. Root Scripts

目标 DX：

```text
bun install
bun run dev
bun run lint
bun run typecheck
bun run test
bun run test:integration
bun run test:e2e
bun run architecture:check
bun run openapi:generate
bun run client:generate
bun run contracts:check
bun run build
bun run package
bun run check
```

`bun run check` 至少：

```text
lint
+ typecheck
+ unit/integration suitable set
+ architecture check
+ OpenAPI/client drift
```

不要求每次 `check` 都构建签名 Installer。

---

# 51. 初始化 Dependency 分配

不要全部装 root。

## apps/desktop

```text
electron
electron-vite
electron-builder
react
react-dom
@vitejs/plugin-react
tailwindcss
@tailwindcss/vite
shadcn required primitives
lucide-react
@tanstack/react-query
zustand
react-hook-form
@xterm/xterm
@xterm/addon-fit
@xterm/addon-search
@xterm/addon-serialize
@xterm/addon-web-links
@xterm/addon-webgl
@xterm/addon-unicode11
@xterm/addon-ligatures
@xterm/addon-image
@codemirror/state
@codemirror/view
@codemirror/commands
```

## packages/runtime

```text
hono
@hono/node-server
@hono/zod-openapi
zod
ws
ssh2
node-pty
drizzle-orm
pino
```

## packages/db-schema

```text
drizzle-orm
```

Dev：

```text
drizzle-kit
```

## packages/client

```text
openapi-fetch
```

Codegen：

```text
openapi-typescript
```

原则：平台标准 API 足够时不再引入额外框架。

---

# 52. 首版 Legacy Prototype 复刻执行流程（历史）

以下流程记录首版 parity 实施方法，不再是 ADR-016 之后的新任务队列。本仓库已经完成
初始化；当前必须按商业化清理计划执行，同时继续遵守本文件的架构和安全不变量。
原流程为：

1. 完整阅读 `AGENTS.md`、本文件和 `docs/implementation/STATUS.md`；
2. 阅读 `LEGACY_PROTOTYPE_PARITY_ROADMAP.md` 的当前执行队列和对应 Matrix 行；
3. 校验 `vendor/legacy-prototype` 仍固定在 ADR-003 指定提交；
4. 运行或阅读固定 Legacy Prototype 的页面、交互、默认设置、服务逻辑和测试，记录可观察结果；
5. 为该条目定义功能、交互、视觉、配置、数据、失败和平台证据；
6. 按 Contract → Application/Adapter/Host → Renderer 的边界完成一个可用垂直切片；
7. 补充成功、失败、取消、重试、资源释放、真实协议和桌面交互测试；
8. 在适用的固定视口和打包平台执行对照，不扩大 mask 或放宽阈值掩盖差异；
9. 更新 Matrix、`STATUS.md` 和 `UPSTREAM.md`，依赖变化同时更新 `VERSIONS.md`；
10. 运行 `bun run check`，证据不足时保持 Partial 或 Implemented，再领取下一项。

如果当前条目只剩 Windows/Linux 实机、旧版本升级或 Matrix 明确标注的后续 Phase 依赖，
保留 open 并继续下一个能解除依赖的条目。不得用 disabled 控件、mock、静态页面或开发模式
演示代替实现。

---

# 53. Codex 当前执行 Prompt

后续任务使用下面的目标声明，不再使用旧的 1:1 或空仓库初始化 Prompt：

```text
完整阅读 AGENTS.md、docs/architecture/MASTER_SPEC.md、docs/implementation/STATUS.md、
docs/adr/ADR-016-independent-open-source-product.md 和
docs/implementation/COMMERCIALIZATION_CLEANUP_PLAN.md；涉及旧能力时查阅历史 Matrix 行。

当前目标是保持 Apache-2.0 和 Level 1 技术栈，按 P-01–P-08 完成独立来源、用户数据
迁移、适度 UI/UX 优化、第三方声明与可审计商业发行。不要从 Phase 0 重做，不要把
入口、mock 或 disabled 控件标成完成，也不要把旧 1:1 像素分数当成新产品门禁。

凭据固定保存到 application-local Host Credential Vault，不探测、调用或询问任何系统
凭据服务。首次无已保存 bounds 的窗口必须为 1440×900。

保持 Zero Business IPC、utilityProcess Runtime、REST/OpenAPI、SSE、Binary WS、streaming
和资源确定性清理。运行 bun run check；同步 STATUS、商业化工作包及来源台账，并在
依赖变化时更新 VERSIONS。只在新计划的全部证据满足时标记工作包完成。
```

---

# 54. AGENTS.md 要求

根目录 `AGENTS.md` 必须至少包含：

```text
Level 1 only
Electron Main != Backend
Runtime = utilityProcess
Runtime must not import Electron
Renderer no Node/Electron/backend vendor access
Zero Business IPC
REST/OpenAPI + SSE + WS + HTTP Stream
Runtime owns SQLite
Host owns Credential/File Grant/Native capability
Pinned Legacy Prototype 5.5.0 is the parity reference
Application-local Vault only; never system credential stores
First window defaults to 1440x900
Matrix Certified evidence defines parity completion
AI in Runtime
AI Tool + Risk + Approval
Every long-lived resource cleanup
Run bun run check
Update STATUS.md
```

---

# 55. Architecture Gate

CI 至少拒绝：

```text
renderer/** -> electron
renderer/** -> node:*
renderer/** -> ssh2
renderer/** -> node-pty
renderer/** -> drizzle-orm
renderer/** -> packages/runtime/**

runtime/domain/** -> hono
runtime/domain/** -> drizzle-orm
runtime/domain/** -> ssh2
runtime/domain/** -> node-pty
runtime/** -> electron
```

还要检查：

```text
duplicate OpenAPI operationId
generated client drift
migration drift
forbidden business IPC channel
packaged source/workspace path dependency
```

---

# 56. Performance

优先保证输入延迟和 Terminal Stream。

规则：

- Terminal bytes 绕过 React State；
- Binary WS；
- UI metadata 才 batch；
- 大文件 stream；
- AI context 限制大小；
- AI/SFTP panel lazy load；
- WebGL addon 可失败回退；
- 不把同步 crypto/大查询放 UI hot path；
- 不整文件读入内存。

先测量再复杂优化。

---

# 57. Privacy Defaults

默认：

```text
Terminal history 不持久
AI 未配置时关闭
AI context 最小必要
Saved Secret → application-local encrypted Host Vault
Diagnostics sanitize
Telemetry 默认关闭
Cloud Sync 默认关闭；Legacy Prototype parity 的手动/自动同步在 Phase 19 实现
```

---

# 58. Future Remote Server Mode

Remote Mode 不是：

```text
127.0.0.1 → 0.0.0.0
```

然后继续用 Desktop random token。

必须重新设计：

```text
bind policy
TLS / trusted reverse proxy
durable user/device auth
session revocation
CORS/origin
rate/request limits
audit
credential scope
remote capability policy
```

Remote Runtime 默认不能控制 Client 所在 Desktop Host。

未来需要 Remote Host Capability 时，必须：

```text
Desktop 主动建立
用户可见
可撤销
capability scoped
```

---

# 59. Future Expo 57

移动端：

```text
Expo SDK 57
React Native 0.86 line
NativeWind 5
gluestack-ui v5
Reanimated
```

通信：

```text
HTTPS REST
fetch-SSE
WebSocket
```

共享：

```text
@workspace/contracts
@workspace/client
platform-neutral schema
pure utilities
design tokens
```

不共享：

```text
shadcn Web components
Electron-specific logic
Desktop Host implementation
```

Mobile SQLite + Drizzle 只能作为 Client cache/local state，Remote Runtime 仍是事实源。

---

# 60. Protocol Adapter Policy

Phase 17 按 Legacy Prototype parity matrix 逐个加入：

```text
Serial
Telnet
RDP
VNC
SCP
Zmodem/trzsz
FTP
```

每个协议必须：

```text
Domain/Application contract
Vendor Adapter
Lifecycle owner
Typed API
Tests
Cleanup
```

终端内文件协议使用 ADR-013/ADR-018 的窄化拦截边界：`TerminalService` 在 replay、录制和 Renderer
广播前将输出交给 Runtime Adapter；普通输出继续走原有 Binary WebSocket，协议帧由 Adapter
消费并通过同一终端 Channel 回写。ZMODEM/trzsz 自动检测，XMODEM 由显式菜单动作启动。
本地文件选择只能使用 generation-bound File Grant 和 REST action。Renderer 只可接收当前授权
目录用于地址栏展示的规范化绝对 `rootPath`；具体文件目标、临时文件和保存目标的绝对路径不得
暴露，所有协议传输仍使用 `grantId + relativePath`。
公开进度只包含协议、方向、安全文件名、字节数、速度、状态和错误码。每个终端最多一个活动
传输，等待选择、缓冲、重试、流和临时文件都有固定上限与 owner；下载完成后才将同目录
`.part` 文件提交，取消、错误、终端关闭或 Runtime 退出必须清理。

不得直接把 vendor object 暴露到 Renderer。

---

# 61. MCP Adapter Policy

内部先成熟：

```text
Tool Registry
Risk Policy
Approval
Audit
```

然后才能：

```text
Internal Tool Layer
       ↓
MCP Adapter
       ↓
External AI Client
```

MCP 不能绕过：

```text
Credential policy
Host scope
Risk classify
Approval
Audit
```

---

# 62. Level 2 / Level 3 升级兼容

若未来 Runtime 变成大型封闭平台：

```text
Level 1 ordinary modules
        ↓
Level 2 Internal Plugin Runtime
```

Client / Runtime HTTP 边界保持不变。

若真实需要第三方：

```text
Core Runtime
+
Capability Broker
+
Isolated Extension Host
```

第三方代码不能因为“插件方便”直接进入 Core 或 Main Renderer。

---

# 63. ADR Policy

以下变更必须写 ADR：

```text
process boundary
Client/Runtime transport
Runtime ownership
database engine
credential storage
public API versioning
AI approval policy
plugin architecture
Node/Bun/Electron runtime policy
packaging system
```

模板：

```text
# ADR-NNN: Title

Status: Proposed | Accepted | Superseded
Date:

## Context
## Decision
## Consequences
## Alternatives considered
## Migration / rollback
```

---

# 64. 最终技术结论

```text
Electron
= Desktop Host

React 19
= Desktop Client UI

Hono
= Independent Core Runtime HTTP Server

OpenAPI
= Formal Client Contract

REST/JSON
= CRUD / command business API

SSE
= Domain + realtime one-way events / AI stream

WebSocket
= Terminal interactive byte stream

HTTP Stream
= Large file transfer

SQLite + Drizzle
= Local-first persistent business truth

ssh2
= SSH / SFTP / Tunnel adapter

node-pty
= Local Terminal adapter

node:crypto AES-256-GCM
= Desktop Host application-local credential encryption primitive

AI Domain
= Provider + Context + Tool + Risk + Approval + Run

Bun
= Workspace/package/build tooling

Expo 57
= Future Mobile Client
```

项目最核心的不变量：

> Electron Main 不是业务 Backend；Renderer 不是 Runtime；任何功能都不能因为“大家都在同一台机器”就绕过正式 Runtime Contract。
