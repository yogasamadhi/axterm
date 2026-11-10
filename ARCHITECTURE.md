# Axterm 架构约定

Axterm 是 Apache-2.0 桌面终端与远程运维工具。采用 Cordis Level 3：
共享基线与 Level 2 组合模型，加同进程外部插件与公开扩展点。

## 进程与调用

- Electron Shell 只拥有窗口、原生能力、Vault、更新与恢复；通过 RunAsNode 启动独立 Host。
- CLI 和 Desktop Host 共用 Profile runner。Host 业务运行在 Cordis 树，不导入 Electron。
- 普通业务经生成 Remote；每个 Controller 配对 Host face、codec 与 Client model。
- 完整 Web 载体在 `axterm-app://app/` 运行。Client 插件通过 Slots 组合，只有 UI renderer 挂载 React 根。
- 浏览器不得访问 Node、Electron、SQLite、SSH、PTY 或 Host 实现；不恢复业务 IPC、REST/OpenAPI 或 Plugin Kernel。

## 所有权与资源

- 每个业务域拥有自己的服务、持久领域、Remote namespace 与 UI 贡献。插件只经公开 Service、事件或只读投影协作。
- Client model 提供 baseline、增量与 command，重连替换 baseline；持久事实和实时事件分开。
- 持久化经 ctx.storage 与领域 facet；复杂 SQL 保留关系模型和不可变迁移校验值。
- 终端/远程桌面走有界 Binary WS；控制帧经 Zod 校验，大文件走 streaming HTTP。终端字节不进入 React/Zustand，不整文件 Base64 JSON。
- 所有注册、PTY、SSH、WS、listener、timer、stream 都有 disposer；卸载先停止接纳并取消/排空任务，数据库与共享底座最后关闭。

## 安全与 AI

- Desktop Host 默认 loopback + 系统分配端口；凭据每 generation 更新，只存 Shell 内存。Web 经无 token URL 的认证页 POST /connect 交换；不使用 wildcard CORS。
- Saved Secret 使用 application-local Host Credential Vault，业务库只存 credentialRef；禁止系统 Keychain/Credential Manager/Keyring/safeStorage。Secret 不进入 UI 状态、浏览器存储、URL 或日志。
- Unknown/Changed SSH Host Key 须用户确认；Changed 必须高风险展示。Terminal history 默认不持久化。
- AI 是 Host 业务域，优先复用固定 vendor/pi 的 Agent 循环和模型协议；Renderer 不调用 Provider SDK，Tool 调 Application Service。
- AI 上下文有界且脱敏；不暴露或持久化隐藏推理。生成命令默认不执行。危险、破坏性、特权与高影响操作要求绑定参数、目标、generation 和有效期的精确一次性批准。自动审核仅限已授权的有界低风险范围；不确定时转人工，其他 Tool/MCP 审批不变。

## 组合、工具链与交付

- 外部插件只经 ctx.pluginManager 与内置 pnpm 安装；与第一方同进程，兼容检查不是沙箱。公开 SDK 不暴露内部实现，故障进入原生恢复。
- DSH 固定 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`；九个 Cordis 框架包源码、原名、版本与许可不得修改，不依赖其他 DSH 产品包。Pi 与其来源校验保持固定。
- Node 24.18.0、pnpm 11.28.5、Electron 44.3.0、strict TypeScript/ESM、tsdown/Vite、React 18.3.1、CSS Modules/Theme token/Radix、Vitest/Playwright。不恢复 Tailwind、Base UI、TanStack Query 业务缓存或 electron-vite。
- 仅支持 en、ja、zh-CN、zh-TW。使用独立 data-v2/vault-v2，不自动改写旧未公开原型数据。
- check 包含架构、安全、Contract、来源、许可、固定历史门禁和真实 UI 回归；不得删除断言或降低阈值换取通过。平台原生、签名、公证与正式发行须独立留证。
- 本目录可独立安装、构建、检查和准备公开源码；私有平台与父仓库完整文档不参与构建或源码分发。固定门禁输入位于 tests/fixtures/engineering/，其历史路径和结论保留原始含义。
