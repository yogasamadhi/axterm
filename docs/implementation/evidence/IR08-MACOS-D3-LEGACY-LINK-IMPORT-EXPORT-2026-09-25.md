# IR-08 / W-08-01 / D3：旧链接与导入/导出转换的 Mac 工程证据

日期：2026-09-25。范围仅为 D3 的当前 macOS arm64 工程格，不是 IR-08 公开迁移版验收，也不代替 W-08-02 的真实旧公开安装包升级。

## 制品和测试

- 当前无签名 Mac 包：/tmp/axterm-s5-final.Q0rUE4/mac-arm64/Axterm.app；app.asar SHA-256：08b3edb130dbf616801adfa676a4c97353fbd3507440f4422b6cd8f05b724651。每个 Playwright 用例将它复制到隔离临时目录，使用独立 user-data。
- 源码：bunx vitest run packages/runtime/src/application/legacy-prototype-data-service.test.ts packages/runtime/src/application/axterm-configuration-service.test.ts tests/unit/legacy-deep-link-boundary.test.ts → 3 文件、66/66 通过。
- 当前包：AXTERM_PACKAGED_APP 指向上述 Mac 包，定向运行 tests/e2e/packaged.spec.ts 的“packaged migration surfaces preserve legacy data”、“packaged app imports the frozen historical Axterm portable file”和新增的“packaged macOS D3 rolls back a late legacy import failure” → 3/3 通过（分别约 5.4、2.6、4.4 秒）。
- 新增失败用例所在源码：tests/e2e/packaged.spec.ts；原有数据保护断言也补到 packages/runtime/src/application/legacy-prototype-data-service.test.ts 的后期失败用例。完整仓库检查结果另记 STATUS。

## D3 覆盖和停止线

| 路径           | 可复核结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 旧链接         | 当前包以 second-instance 接受 legacy-prototype:// FTP URL，显示迁移提示并填入连接表单；同一 axterm:// URL 不显示旧协议提示。凭据只留在表单，不落 browser storage。源码深链接边界测试也通过。                                                                                                                                                                                                                                                                                   |
| 旧命令工作流   | 当前包读取迁移期 JSON 与 Legacy Prototype CSV 形状，报告被舍弃的字段、提示顺序 Axterm 操作；内联密码不进入 SQLite 或 browser storage，上传/下载无 File Grant 时拒绝。                                                                                                                                                                                                                                                                                                          |
| 旧便携文件导入 | 冻结的历史 Axterm 源码构建包导出文件由当前包预览并显式提交：组、Profile、书签和 Quick Command 关系进入 SQLite，导入映射行数为 5，Vault secret 不从便携文件虚构。文件 SHA-256：250a533d009e2b62ccc3723425584f9fad90efe9849b60ea41e2dcb583f3c0dc。                                                                                                                                                                                                                               |
| 独立格式转换   | 当前包的迁移面板导出 axterm-configuration v1，检查 SHA-256，再预览/导入独立配置；设置恢复须显式勾选，Vault secret 标为 omitted。源码测试涵盖 8–16 MiB 成功与超过 16 MiB 拒绝。                                                                                                                                                                                                                                                                                                 |
| 旧格式导出     | 新增包内旅程在成功恢复后经原生保存对话框导出 Legacy Prototype-compatible v2 便携文件；文件保留既有与新导入条目，声明 credentials omitted，既有和新导入 secret 值均不出现。                                                                                                                                                                                                                                                                                                     |
| 后期失败与恢复 | 在隔离当前 profile 中先保存一个已有 Host 和本地 Vault secret，再用合成旧文件导入含组、Profile、SSH 书签及两项新密码的数据。SQLite trigger 在书签 INSERT 阶段故意中止：已有 Host/credentialRef 原样保留，组、书签、Profile、导入映射均为 0；Vault 全部文件哈希与尝试前相同，旧 secret 仍可解密；界面和 DB 不暴露旧/新 secret。撤销注入后重新启动，同一文件成功导入，得到 2 个 Host、1 个书签、3 条映射，原有 secret 仍可解密。源码测试还证明新建凭据 ref 被删除，原有凭据保留。 |

原有[迁移覆盖台账](../P06_MIGRATION_COVERAGE.md)与[历史包升级记录](IR08-HISTORICAL-PACKAGE-UPGRADE-2026-09-23.md)已有更多旧导出成功路径；本次没有把已过场景重算为新进度。

## 限制与结论

后期失败是受控注入，不代表自然磁盘损坏、断电或所有旧数据形状；旧便携文件来自历史**源码重建包**，不是可验证的旧**公开**安装包。当前 Mac 包无签名，Windows/Linux 原生安装、真实旧公开包和最终公开迁移期限仍分别归 W-08-03、W-08-02、W-08-04；旧 WebDAV/其他同步的完整远端安全矩阵归下一格 D4。

在上述限定范围内，D3 Mac 工程格已通过。W-08-01 仍因 D4 未完成而开放；IR-08 仍 In progress。此次关闭 W 任务 0 项、接受 IR 门禁 0 项；M1 细格由 6/14 变为 7/14，下一格 W-08-01/D4。
