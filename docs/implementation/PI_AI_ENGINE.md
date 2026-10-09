# Pi AI 引擎与配置

Axterm 的模型请求由 Runtime Adapter 调用固定的 Pi AI 与 Agent 源码。
厂商目录来自同一 Pi 提交所固定的模型目录，构建和启动不会自动联网更新目录。
决策与源码边界见 [ADR-027](../adr/ADR-027-pi-ai-source-engine.md)。

## 模式与技能

AI 助手只提供“聊天模式”和“工作模式”，默认聊天模式。聊天只回复内容；工作模式
可以提出当前标签工作区的命令，仍需用户确认后执行。输入 `@` 或点击“技能”即可
选择解释命令、解释输出、生成命令/脚本、诊断。支持按中文名称或英文 ID 过滤，
上下键选择、Enter/Tab 采用、Escape 收起；中文输入法确认不会误发送消息。
已选技能显示在输入框上方，可移除。直接输入 `@explain-command ls -la` 也可调用。
解释和生成技能在两种模式下都只回复，不执行命令；诊断在工作模式可提出审批命令。

技能使用 `packages/pi-engine/skills/*/SKILL.md`，构建直接调用 Pi 的
`loadSkillsFromDir` 和 `stripFrontmatter` 完成发现、校验和正文加载，随引擎打包；
界面通过 REST `/api/v1/ai/skills` 读取元数据。当前只加载这四个内置技能，
不自动扫描用户或项目目录。Pi AI/Agent 和厂商代码继续直接复用，上游源码不修改。

会话直接调用 Pi 的 `runAgentLoop`。后续 Agent、模型协议、技能和资源能力优先
复用 Pi 已有实现；Axterm 只保留桌面交互、标签/SSH 工作区及 Runtime 的凭据、
审批、审计、脱敏和持久化适配，不另行实现等价 Agent 引擎。

聊天文字直接展示 Pi 的 `text_delta`：Runtime 通过已有
`/api/v1/ai/runs/{id}/stream` 提供经过 Contract 校验的 SSE，界面逐段显示，
不等待最终消息写入。打开侧栏或切回标签会取得当前有界文本快照，再继续接收
增量；完成后由 SQLite 中的最终消息接替，取消保留已生成内容。该适配只负责
Runtime 到 React 的传输与呈现，厂商流解析和 Agent 循环仍全部使用 Pi。

## 复用检查与保留边界

2026-10-06 再次逐项检查了 Pi Agent、coding-agent 会话/配置和技能源码。
旧 `OpenAiCompatibleProvider` 的请求构造、SSE 解码、三种协议事件解析已删除；
对应回归测试改为直接验证 Pi。Runtime 不再接收自己拼装的模型工具分片，
只接收 Pi 已解析且校验完成的命令提议。

| 部分                         | 实现与保留原因                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| Agent 循环、模型请求与流解析 | 直接编译固定 Pi 源码，使用 `runAgentLoop` 和 Pi API 实现。                                         |
| 厂商与内置模型目录           | 直接使用 Pi 的 provider factories 和固定离线目录；自定义模型只做数据库配置到 Pi `Model` 的窄适配。 |
| 技能发现、校验、frontmatter  | 直接调用 Pi `loadSkillsFromDir`、`stripFrontmatter`；四份技能正文是 Axterm 特有任务配置。          |
| `@` 菜单与聊天/工作模式      | React 桌面输入适配；Pi 的交互界面是 TUI，不能直接放入 Renderer。                                   |
| 会话、上下文、工具与审批     | 保存到 Runtime SQLite，提供 REST/SSE，并执行有界脱敏与明确审批；这是仓库要求的应用事实源。         |
| 凭据导入                     | Pi `models.json` 形状映射到 Host Vault 引用；不调用 Pi 文件凭据或表达式执行。                      |
| HTTP 与代理                  | `model-http.ts` 仅保留桌面代理传输及旧网关 `/models` 兼容发现；协议请求及响应由 Pi 处理。          |
| 系统提示词                   | 保留模式/SSH/审批规则与书签、主题结构化输出要求；专用命令任务的正文只存在标准 `SKILL.md` 中。      |

完整 `createAgentSession` 默认会创建 Pi 文件会话、settings/auth 与资源加载器，
`AgentSession` 还绑定 TUI、扩展及本地工具。当前复用其独立 Agent 引擎与技能加载器，
使桌面仍满足 Runtime SQLite、Vault、SSH 和审批约束。Pi `ModelConfig` 当前只提供
文件加载入口，完整 provider composer 还带凭据表达式解析；现有数据库配置映射
保留为薄适配。Pi 通用事件队列没有背压，现有单事件通道负责输出上限与取消清理。

## 桌面配置

右侧打开 AI 助手后默认显示聊天输入框。点击厂商配置，选择 Pi 厂商、填写
API Key 并选择模型，保存后即可发送消息；普通聊天无需再打开完整工作区或确认
上下文预览。附件和命令解释等专用任务继续提供发送前的上下文审阅。
基础 URL 可以改为自己的网关；需要账户 ID 等占位符的端点须填写实际 URL。
厂商连接测试会使用已配置的模型发起一个简短请求，会产生模型 API 用量。
原有 OpenAI Chat、Responses 和 Anthropic 端点配置继续有效，模型请求也使用 Pi。

也可以在配置窗口粘贴 Pi 的 `models.json`。导入可以创建多个厂商和模型，例如：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        {
          "id": "qwen2.5-coder:7b",
          "name": "Local Qwen",
          "contextWindow": 32768,
          "maxTokens": 4096,
          "compat": { "maxTokensField": "max_tokens" }
        }
      ]
    }
  }
}
```

内置厂商可以省略 `baseUrl` 和 `models`，并通过 `modelOverrides` 修改目录模型。
模型的标量 `compat` 逐项合并，覆盖时保留没有指定的兼容参数。
API Key 可放在导入文本内，也可使用窗口的 API Key 字段作为各厂商的默认值。
导入会新建配置；不会覆盖已有厂商。失败时撤销本次创建的资源；撤销失败时保留
仍被配置引用的 Vault 凭据。导入文本不会写入业务数据库或浏览器存储。

支持的 API 标识为 `openai-completions`、`openai-responses`、
`azure-openai-responses`、`anthropic-messages`、`google-generative-ai`、
`mistral-conversations` 和 `pi-messages`。模型字段支持 `id`、`name`、`api`、
`baseUrl`、`reasoning`、`input`、`cost`、`contextWindow`、`maxTokens` 和标量 `compat`。
每次导入最多 16 个厂商，每个自定义厂商最多 500 个模型，文本最多 256 Ki 字符。
输入经过严格校验；未支持的字段不会被悄悄忽略。

## 凭据与执行

API Key 和 provider `headers` 的值固定保存到应用本地加密 Vault；业务配置只保存
`credentialRef` 和 `headerCredentialRefs`。没有 Pi `auth.json`、系统凭据存储或存储方式选择。
当前支持字面凭据值。`$ENV`、`${ENV}` 与 `!command` 需替换为实际值；导入不会
读取环境凭据或执行命令。OAuth/订阅登录、云环境自动凭据、模型级 headers、嵌套
compat 和额外采样设置尚未接入；需要这些方式的厂商不作为可用登录入口展示。

助手工作目录跟随当前选中的终端标签：本地标签使用当前 shell 目录；SSH 标签
使用本机用户目录下的 `~/.axterm`，命令通过该标签对应的 SSH 连接在远程执行。
已知远程目录时在该目录执行，未知时使用远程登录目录。SSH 断开会明确失败。
界面显示工作目录和执行位置，切换标签会切换聊天并清空未发送的草稿及附件。

请求保留应用的上下文审阅、脱敏、代理、超时、取消、响应与输出上限。
模型私有推理不展示或持久化。按 [ADR-028](../adr/ADR-028-ai-terminal-workspace.md)，
Pi 每轮工作模式可提出一个命令，自己的执行器始终阻止执行；Runtime 将命令、标签、
连接及目录快照记录为待确认操作。点击“仅运行一次”后通过 Application Service
执行，最多 30 秒、合计 128 KiB 输出；确认前切换标签或 `cd` 不会改变已记录的
执行目标。关闭目标会失败。结果回到聊天，可继续提问；没有自主执行循环。
专用“生成命令”任务保持草稿，不自动执行，已有终端插入及 MCP 工具语义保留。

## 源码与构建

Git 检出后先运行 `git submodule update --init --recursive vendor/pi`，再安装依赖。
`bun run pi:build` 校验 `packages/pi-engine/source-manifest.json` 的源码哈希与固定
catalog 哈希，使用 Pi 的离线 hydration helper，并把 SDK 和源码编入私有引擎包。
上游目录数据是忽略的生成输入，子模块的已跟踪文件保持不变。

独立源码快照带上三个必要的 Pi 引擎源码树、技能加载器及其必要依赖源码、
hydration helper、目录 pin 和 MIT 许可证，
排除子模块 Git 元数据、CLI、示例和上游测试。安装包包含引擎代码、SDK 许可清单和
`licenses/pi-LICENSE.txt`，运行时无需源码工作区或系统 Node。
