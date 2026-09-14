# 通用桌面软件架构：Level 2 大型封闭项目版

> 文档类型：Future Architecture Reference（不是 Axterm 当前实施规范）
>
> 架构版本：2.1
>
> 更新时间：2026-09-10
>
> 适用对象：多业务域、多团队、长期维护，但不加载第三方代码的专业桌面软件
>
> 共享基线：[DESKTOP_ARCHITECTURE_BASELINE.md](./DESKTOP_ARCHITECTURE_BASELINE.md)
>
> 第三方插件：不支持

> 本文件是未来架构参考，不是 Axterm 当前实施计划。Axterm 在 Electerm 复刻期间保持
> Level 1；没有新 ADR 不得据此引入 Plugin Kernel 或第一方 Plugin Runtime。

---

# 1. 定位

Level 2 在共享 C/S 基线上增加第一方 Internal Plugin Runtime，用于防止大型 Core Runtime 演化为 God Server。

```text
Clients
   │ HTTP
   ▼
Core Runtime
├── Runtime Gateway
├── Minimal Kernel
├── Effective Core Graph
└── First-party Plugins
```

插件在本 Level 中是内部软件工程机制，不是用户生态。用户不能安装任意代码，平台不承担公共 SDK、Permission、Trust、Marketplace 或第三方兼容承诺。

---

# 2. 适用条件

适合：

- 多个稳定 Bounded Context；
- 多团队并行维护；
- 需要 safe/test/e2e/enterprise 等产品形态；
- 路由、服务、事件、迁移和 UI Contribution 需要统一生命周期；
- 需要清晰的数据所有权；
- 所有运行代码均由同一官方信任域构建和签名。

不适合仅因为“插件听起来先进”而使用。业务规模不足时应选择 Level 1。

---

# 3. 组合模型

正式组合层级：

```text
Plugin
  ↓
Bundle
  ↓
Product Profile
  ↓
Effective Core Graph Revision
```

## 3.1 Plugin

插件粒度是：

```text
Bounded Context
或
Replaceable Platform Capability
```

插件可以贡献：

```text
stable contracts
typed services
HTTP routes
domain / realtime events
UI metadata
migrations
background work
diagnostics
```

普通 Entity、React Component、Utility 或单个按钮不是插件。

## 3.2 Bundle

Bundle 只负责：

```text
composition
dependency declaration
configuration defaults
product-oriented grouping
```

Bundle 不拥有表、迁移、业务状态、事件或领域逻辑。

## 3.3 Product Profile

Profile 只引用 Bundle 和少量显式配置，不复制长插件列表。

```text
studio
server
safe
test
e2e
enterprise
```

Profile 是官方发布的产品形态，不是用户扩展集合。

以上名称只是通用示例。若 Axterm 未来升级到 Level 2，Profile 名称、组合格式和配置覆盖
规则必须由升级 ADR 定义；配置只接受受信任的第一方装配，不能借此加载用户提供的代码。

---

# 4. Minimal Kernel

Kernel 只负责平台机制：

```text
graph resolution and validation
lifecycle
effect tracking
typed services and capabilities
event infrastructure
migration coordination
contribution staging
diagnostics
```

Kernel 不负责具体业务域，也不应成为跨插件万能 Service Locator。

通用 Level 2 不限定具体 microkernel；第一方实现可以直接使用选定框架的 Context 和生命周期 API。框架类型不得越过 Client、公开 Plugin API 或 Agent Runtime 等公共契约边界。

具体 microkernel、生命周期 API 和装配工具必须在升级 ADR 中选择并固定；本参考文档不为
Axterm 预选框架，也不能被当作当前依赖依据。

---

# 5. Plugin Contract 与依赖

插件禁止导入其他插件实现。

允许：

```text
versioned stable contract
typed service
capability
public domain event
explicit read-only projection
```

依赖图必须是 DAG。启动前验证：

```text
unknown plugin
missing dependency
cycle
version conflict
duplicate contribution
missing required capability
```

业务跨域协作优先通过 Service 或 Event。确需跨域查询时，只能通过 owner 提供的只读 projection contract，不能直接访问其他插件 Repository。

注册元数据与插件实现分离：构建期从插件声明生成身份、版本、模块入口、迁移和 contribution 清单；Runtime 静态读取元数据做图预检，再由 Loader 动态导入 ESM。图预检顺序不代替生命周期调度，实际激活由 Cordis `inject` 中的服务可用性决定。

---

# 6. Typed Services

服务访问应使用有类型和归属约束的 API，例如：

```ts
provideService(ctx, contract, implementation);
requireService(ctx, contract);
optionalService(ctx, contract);
```

Contract 至少描述：

```text
id
major
capabilities
input / output type
error type
owner
```

必需服务必须在激活前声明和校验；可选服务只用于契约明确允许降级的能力。服务 ID、owner、
major 和 capability 在发布图前校验，重复提供、错误 owner、版本不匹配或缺失依赖均失败。

HTTP、UnitOfWork、持久事件和 UI contribution 作为基础服务注入。持久业务事件使用 `ctx.domainEvents`，保留 Cordis 的 `ctx.events` 供框架使用。

---

# 7. Graph Revision 与原子激活

每次有效组合必须拥有不可混淆的 revision：

```text
profile
bundle versions
plugin versions
contract versions
configuration fingerprint
```

Level 2 的标准启动流程建议为：

```text
Resolve
→ Validate
→ Migrate
→ Load Modules and Stage Contributions
→ Await Enabled Modules and Owned Resources
→ Validate Effective OpenAPI and Graph
→ Atomic Publish Revision
→ Ready
```

任何阶段失败都必须撤销本次 staging，不得暴露半激活 Runtime。等待生命周期稳定后，所有启用条目、子 Fiber、必需服务与 contributions 必须完整；pending 不是成功启动。

Level 2 默认允许采用更简单、更安全的生产策略：

```text
first-party graph is immutable after boot
profile change requires Runtime restart
```

开发 HMR 与生产策略必须分别定义。若未来支持模块热重载，必须暂停新业务请求、排空已有
handler、暂存路由/UI、重建并校验完整 Graph，再原子发布 Router、Core Graph 和诊断；期间
返回结构化 `RUNTIME_RELOADING`。失败时从上一成功构建恢复或完整重启，不回滚业务数据库，
也不自动重放业务写入。生产默认关闭第一方文件监听。

---

# 8. Reversible Effects

每个长期副作用必须有 owner、plugin version、graph revision 和 label。

一种候选 acquisition API 形态为：

```ts
await ctx.effect(() => ctx.http.register(route), "route:workspace.projects");

await ctx.effect(() => {
  const timer = setInterval(tick, interval);
  return () => clearInterval(timer);
}, "timer:automation.scheduler");
```

平台负责 acquire 和登记，避免插件先创建资源、后登记 cleanup 时发生泄漏。

要求：

- activation 失败清理当前 revision；
- 遵循 DSH 原生并发清理；有顺序依赖的资源放入一个 effect，显式 await 每个释放步骤；
- 重复 dispose 幂等，单个清理异常不阻止其他独立资源回收；
- unload/restart 清理所有长期资源；
- diagnostics 从真实 Fiber/effect 元数据列出活跃 effect，并关联 owner/version/revision；
- 测试结束 effect 数量归零；
- 禁止未登记 timer、listener、watcher、stream、worker 和 child process。

---

# 9. HTTP Route 生命周期

从 Registry 删除 route metadata 不等于从底层 Router 删除已安装 handler。

安全策略二选一：

## 9.1 Immutable Router

生产 Graph 启动后不可动态 unload，Profile 切换通过 Runtime restart 完成。

## 9.2 Atomic Router Swap

```text
Active Router A
     │
gate requests and drain active handlers
     │
stage contributions through native plugin reload
     │
build and validate Router B
     │
atomic publish Router / Graph / UI / diagnostics
     ▼
resume requests with Router B
```

不得依赖修改 Hono、Express 或其他框架的私有路由表实现卸载。

插件清理发生在重载批次中，不能要求卸载旧插件后旧 handler 仍继续使用已释放服务。请求
暂停覆盖这一窗口；失败图不发布，由恢复或完整重启重新建立可服务状态。

---

# 10. 数据所有权与迁移

每张业务表必须有唯一插件 owner。插件导出：

```text
migrations
owned tables / indexes
event schemas
retention policy
read-only projections
```

迁移账本至少记录：

```text
plugin id
migration id
plugin version
dependency
checksum
executedAt
duration / result
```

迁移 forward-only，并支持 preflight、backup、integrity check、timeout 和失败诊断。

业务状态和 Domain Event 在同一事务提交。commit 后唤醒 durable dispatcher；消费者使用 checkpoint、幂等 handler、retry/backoff 和 dead-letter/degraded diagnostics。

---

# 11. UI Contribution

Runtime 只返回启用的 Contribution ID 和 metadata。Renderer 使用构建期生成、随应用签名的 loader registry：

```text
Runtime enabled IDs
       ∩
signed builtin loader registry
       ↓
actual routes / panels / commands
```

未知 ID 不执行任何代码。

UI Shell 只负责：

```text
bootstrap
runtime connection
global navigation host
route outlet
error boundary
contribution registry
```

具体页面按领域拆分和 lazy load。Level 2 没有第三方 UI Sandbox。

---

# 12. Architecture Catalog 与门禁

建议生成以下可审计快照：

```text
table owners
route and operation owners
event owners
UI contribution owners
service contracts
capability contracts
```

这些文件应由 Plugin Descriptor、Migration、OpenAPI 和 Contribution 源生成并在 CI 检查漂移，不能成为第二套手写真相源。

门禁至少拒绝：

```text
cross-plugin implementation import
unowned table / route / event
duplicate operationId
Renderer business IPC / direct fetch / server implementation import
Electron Main domain implementation import
untracked long-lived resource
profile / bundle / graph invalid
migration / OpenAPI drift
```

---

# 13. 测试

除共享基线外增加：

```text
plugin unit / integration
dependency graph
profile and bundle
activation rollback
effect leak
route revision
migration ownership
domain event replay
optional capability degradation
effective OpenAPI
UI contribution resolution
native inject delay / service withdrawal / dependency restart
module and configuration HMR / repeated file events
failed reload recovery / no duplicate routes, consumers, timers or watchers
detached Runtime artifact and framework source provenance
```

故障测试必须覆盖 critical/optional plugin 失败、迁移 checksum 错误、Graph staging 失败和 Runtime 重启。

---

# 14. MUST

1. MUST 遵守共享架构基线。
2. MUST 使用第一方 Internal Plugin Kernel 组织复杂 Runtime。
3. MUST 保持 Kernel 不包含领域业务。
4. MUST 使用 Plugin → Bundle → Profile → Graph Revision。
5. MUST 验证插件依赖 DAG。
6. MUST 禁止跨插件实现 import。
7. MUST 跟踪全部长期 effect，遵循原生清理语义并显式表达资源释放依赖。
8. MUST 原子发布有效 Graph，不能暴露半激活状态。
9. MUST 为表、迁移、路由和事件声明唯一 owner。
10. MUST 区分 Domain Event 与 Realtime Event。
11. MUST 使用受签名的内置 UI loader registry。
12. MUST 保持所有运行代码处于官方信任域。

---

# 15. MUST NOT

1. MUST NOT 加载第三方代码。
2. MUST NOT 为假设中的生态提前建设 Permission、Trust 或 Marketplace。
3. MUST NOT 让 Kernel 变成 God Server。
4. MUST NOT Plugin Everything。
5. MUST NOT 让 Bundle 拥有业务状态。
6. MUST NOT 给插件万能 Context、Raw SQLite 或其他插件 Repository。
7. MUST NOT 在没有真实需求时承诺生产 HMR。
8. MUST NOT 通过修改 HTTP 框架私有状态伪造路由卸载。

---

# 16. 升级到 Level 3 的触发条件

只有出现真实第三方生态需求，并愿意承担以下长期成本时升级：

```text
Public SDK compatibility
manifest and identity
permission UX and enforcement
process / OS isolation
plugin data lifecycle
update and rollback
malicious plugin testing
distribution and signing
```

升级增加独立 Extension Host；第三方代码不得因此进入 Level 2 的 Core Runtime 和主 Renderer。

---

# 17. 最终模型

```text
Clients
   │ HTTP
   ▼
Core Runtime
├── Minimal Kernel
└── Effective Core Graph
    └── First-party Plugins
```

Level 2 的目标是让大型封闭产品拥有可靠的内部组合、生命周期和所有权，而不是提前模拟一个尚不存在的插件市场。
