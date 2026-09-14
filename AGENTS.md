# AGENTS.md

本仓库由 `docs/architecture/MASTER_SPEC.md` 约束。开始工作前必须完整阅读该文件和
`docs/implementation/STATUS.md`，再按 `docs/implementation/ELECTERM_PARITY_ROADMAP.md`
与 `docs/implementation/ELECTERM_PARITY_MATRIX.md` 领取当前复刻项。

## 架构不变量

- 初始只使用 Level 1；没有明确 ADR 不得引入 Plugin Kernel / Extension Host。
- Electron Main = Desktop Host，不是业务 Backend。
- Desktop Core Runtime 必须运行在独立 Electron `utilityProcess`。
- Core Runtime 不得 import Electron，并保留独立 Node Headless 入口。
- Renderer 不得直接访问 Node、Electron、SQLite、Drizzle、`ssh2`、`node-pty` 或 Runtime implementation。
- 禁止 Electron Business IPC。
- Renderer/Main 唯一允许的 IPC 为窄化的 `desktop:bootstrap`，只用于 Runtime discovery/bootstrap；禁止添加业务动词。
- Main/Runtime 的 process message 只用于 startup/ready/shutdown/crash supervision，不得作为业务 RPC。
- 正式业务边界：REST/JSON/OpenAPI。
- 持久 Domain Event 与 Realtime Event：fetch-based SSE，语义分开。
- Terminal stdin/stdout：Binary WebSocket。
- 大文件：HTTP/FS/SFTP streaming，禁止整文件 Base64 JSON。
- Runtime 是产品 SQLite 事实源。
- Desktop Host 拥有 Credential Vault、File Grant、Native Dialog、Updater、External URL Validation、Runtime Supervision。

## 技术基线

- Bun Workspaces
- TypeScript strict
- Electron 44.x stable
- electron-vite 5.x stable
- React 19
- Tailwind CSS v4
- shadcn/ui
- TanStack Query + Zustand（仅 UI/workspace state）
- xterm.js
- Hono + `@hono/node-server` + `@hono/zod-openapi`
- Zod
- SQLite + Drizzle，Desktop Runtime 默认 `node:sqlite`
- `ssh2`
- `node-pty`
- Vitest + Playwright
- electron-builder 27.x

Core Runtime 运行于 Electron embedded Node / Headless Node，不得依赖 `bun:*` runtime-only API。

## 依赖边界

禁止：

```text
Renderer → electron
Renderer → node:*
Renderer → ssh2
Renderer → node-pty
Renderer → drizzle-orm
Renderer → Runtime implementation

Runtime domain → hono
Runtime domain → drizzle-orm
Runtime domain → ssh2
Runtime domain → node-pty
Runtime → electron

Electron Main → Runtime Domain/Repository/Workflow implementation
```

必须通过 Application interface / Adapter / Contract 协作。

## 安全

- Desktop Runtime 只绑定 loopback + OS-assigned port。
- 禁止 wildcard CORS。
- Runtime auth 每 generation 变化。
- Token 不进入 URL、日志或 persistent browser storage。
- Secret 不进入 Zustand、TanStack Query、localStorage、日志。
- Saved Secret 固定使用 application-local Host Credential Vault，只向业务 DB 保存
  `credentialRef`；不得探测、调用或提示使用系统 Keychain、Credential Manager、
  Keyring、Secret Service 或 Electron `safeStorage`，也不得提供存储方式选择。
- Unknown/Changed SSH Host Key 必须用户确认，Changed 必须高风险展示。
- Terminal history 默认不持久化。
- AI Context 必须 bounded + redacted。
- AI mutating/destructive/privileged Tool 必须遵守 MASTER_SPEC Approval Policy。

## Terminal

- Terminal bytes 不进入 React State/Zustand。
- stdin/stdout 使用 Binary WS frame。
- Text WS frame 只做控制信息并使用 Zod 校验。
- 每个 PTY/SSH/WS/SSE/listener/timer/stream 都必须有确定性 cleanup。
- 禁止 unbounded output buffer。

## AI

- AI 是 Runtime Domain。
- Renderer 不直接调用 Model Provider SDK。
- AI Tool 调 Application Service，不直接调用 `ssh2`/PTY vendor object。
- Generate Command 默认只生成，不 silent execute。
- 不暴露或持久化隐藏 Chain-of-Thought。
- 持久化 Tool/Approval/Audit 状态，而不是模型私有推理。

## 工作流程

1. 完整阅读 `MASTER_SPEC.md`、`STATUS.md`、`ELECTERM_PARITY_ROADMAP.md` 和当前阶段的 Matrix 行。
2. 按 Roadmap 执行队列找到第一项可执行的未完成 Phase/Item。
3. 如果该项只剩外部平台证据或矩阵中明确记录的后续阶段依赖，保持它 open，
   继续实现能解除该依赖的下一项；不得用占位或 disabled 入口冒充完成。
4. 实现满足架构的最小完整修改。
5. 同步增加对应测试。
6. 运行相关检查；结束前运行 `bun run check`。
7. 失败时修代码，不删测试、不放松 Architecture Gate。
8. 更新 `STATUS.md`；依赖发生变化时更新 `VERSIONS.md`。
9. 架构级变化先写 `docs/adr/ADR-NNN-*.md`。
10. 所有 Acceptance Criteria 未通过前不得把 Phase 标记完成。

## 完成质量

一个 Feature 如果只在 dev 能跑，但存在以下任一情况，则不算完成：

- 绕过 Contract；
- 资源泄漏；
- Packaged App 不工作；
- Secret 存储不安全；
- 错误语义不完整；
- 缺少对应层级测试；
- 破坏 generation/restart 语义；
- 引入未经 ADR 批准的架构漂移。
