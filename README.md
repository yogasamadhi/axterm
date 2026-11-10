# Axterm

Apache-2.0 开源桌面终端与远程运维工作台，包含 CLI、独立 Host、Web 载体和插件 SDK。
第三方代码与素材保留原许可，见 [LICENSE](LICENSE)、THIRD_PARTY_NOTICES.txt 与 licenses/。
架构与安全边界见 [架构约定](ARCHITECTURE.md)，贡献规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开发与检查

需要 Node 24.18.0 和 pnpm 11.28.5；所有命令均从本目录运行。
父项目中已有固定 vendor 源码；独立 Git 检出需先初始化本目录 .gitmodules 中的上游。
源码快照保留实际构建需要的固定源文件。

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm run check
pnpm run package
pnpm snapshot:check
```

本项目不需要私有平台源码、依赖或服务。terminal history 默认不持久化，
保存的凭据只使用应用本地 Host Credential Vault。
当前工程迁移已有本机验收；正式发行仍需权利签收、macOS 签名公证与公开下载验证。
Windows/Linux 原生验收待实际执行，不把源码构建结果视为已通过。
