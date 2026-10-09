# IR-08 / W-08-01 / D4：旧远端同步与独立格式的 Mac 工程证据

日期：2026-09-25。范围为当前 macOS arm64 包和 Runtime 的远端同步迁移安全；不是已公开迁移版、真实云账号或 Windows/Linux 原生验收。

## 制品和检查

- 当前无签名 Mac 包：/tmp/axterm-s5-final.Q0rUE4/mac-arm64/Axterm.app；app.asar SHA-256：08b3edb130dbf616801adfa676a4c97353fbd3507440f4422b6cd8f05b724651。Playwright 在隔离副本和独立 user-data 上运行。
- 历史源码构建包：/Users/h/.codex/worktrees/axterm-initial-release/axterm/release/mac-arm64/Axterm.app；app.asar SHA-256：5dc53bcc5997016a33e8fa41d588462a7b441cde759b181c95e4df6f91c916b0。这是从历史提交重建的包，**不是**已证明公开分发的旧安装包。
- bunx vitest run packages/runtime/src/application/data-sync-service.test.ts packages/runtime/src/adapters/data-sync/http-sync-providers.test.ts packages/runtime/src/adapters/data-sync/webdav-sync-provider.integration.test.ts → 3 文件、44/44 通过。
- 定向当前 Mac 包：WebDAV 迁移与独立八分类恢复 1/1、GitHub/Gitee Gist 与 named-file Custom 迁移及恢复 1/1、历史源码构建包的加密/明文 WebDAV 文档升级恢复 1/1；合计 3/3。WebDAV 包内用例新增备份 503 和新路径上传 412 的失败/重试检查。

## 远端原值、备份、冲突与恢复

| 路径             | 验证结果                                                                                                                                                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebDAV 旧集合    | 旧对象在 /legacy-prototype/desktop.json。备份经 Host 保存授权写入本地，字节与原值相等；另建 /axterm/desktop.json 用于独立加密文档。成功迁移与八分类预览/显式提交后，旧对象字节与 ETag 未变、旧对象写入数为 0。                                                                                             |
| 旧备份请求失败   | 受控 WebDAV GET 返回 503。当前包显示错误，旧对象与 Vault 全部文件哈希未变；没有备份文件、Axterm 格式同步配置或新远端对象。移除故障后同一界面可备份并创建独立配置。源码还核本地备份写失败、取消以及过期 Profile ETag：均不创建新配置或写旧远端。                                                            |
| 新路径上传冲突   | 首次向 /axterm/desktop.json PUT 受控返回 412。界面不报告上传成功，旧对象仍是原值且零写入，新对象未创建；重试后新对象才写入一次，旧对象仍为零写入。真实 WebDAV Adapter 集成测试也核过期条件写入拒绝。                                                                                                       |
| 其他 HTTP 提供方 | 当前包通过真实 HTTP 请求验证 GitHub Gist、Gitee Gist、named-file Custom：迁移时原样备份 axterm-sync.json，只增 axterm-sync-v1.json；上传后预览/显式提交恢复本地设置，恢复不追加远端写入。源码核 stale Gist、截断文件、异常原始 Custom 字节和不安全单对象 Custom 覆盖均 fail-closed；不声称真实云账号已验。 |
| 历史文档         | 历史源码包生成的 AES-256-GCM+scrypt 与明文旧 WebDAV 文档，经当前包预览/提交恢复被删除的 Quick Command 与本地设置；两旧远端对象仍字节相同且没有当前包写入。其哈希和范围详见[历史包证据](IR08-HISTORICAL-PACKAGE-UPGRADE-2026-09-23.md)。                                                                    |

本地备份不是 Vault 备份；独立同步文档也不承载 Vault secret。此轮检查的目标是远端原对象不被静默删除或覆盖，以及备份/新路径失败时不产生误导性的迁移完成状态。

## 结论和剩余范围

D4 Mac 工程格通过。结合[D1 本地 SQLite/Vault 故障恢复](IR08-MACOS-D1-SQLITE-VAULT-FAILURE-2026-09-25.md)、[D2 书签和自建主题](IR08-MACOS-D2-BOOKMARK-USER-THEME-2026-09-25.md)、[D3 旧链接与导入导出](IR08-MACOS-D3-LEGACY-LINK-IMPORT-EXPORT-2026-09-25.md)，W-08-01 的限定工程关闭条件已满足，可关闭该 W 项。

受控 loopback HTTP 不等于真实云账号、签名安装包或原生 Windows/Linux；历史源码包不等于真实旧公开安装包。W-08-02～04 和 IR-08 仍未完成；兼容入口必须留到真实公开迁移期之后。此次 W 关闭 +1，IR Accepted +0，M1 细格 +1；下一格 W-10-02/U1。
