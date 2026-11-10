# Desktop contribution instructions

本目录是独立开源桌面工程，安装、开发、检查与打包命令均从本目录运行。
先阅读 [架构约定](ARCHITECTURE.md)、README.md 和 CONTRIBUTING.md。

- 严守 Host/Client、Shell/native、公开 SDK 与内部实现边界，不放松架构或安全门禁。
- 修改对应层的实现与测试；先跑相关短检查，源码完成后统一运行 pnpm run check。
- 依赖版本固定；安装不得静默运行新的依赖脚本。第三方版权与许可必须保留。
- 注册和资源都有确定性 cleanup；Secret 只经应用本地 Vault，禁止系统凭据服务。
- Windows/Linux 原生测试未执行时保持待验证；源码检查不代替安装、签名或正式发行。
- 私有平台不进入源码、workspace、锁文件、构建或公开快照。

父项目的完整设计、ADR、产品约束和实施记录是维护资料，不随本开源目录分发。
本目录 tests/fixtures/engineering/ 仅保留可复验门禁所需的固定机器输入，
历史记录不表示当前平台验证或发布签收已经执行。
