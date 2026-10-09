import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function document(path: string) {
  return readFileSync(resolve(path), 'utf8');
}

describe('independent-release documentation boundaries', () => {
  it('uses ADR-021 immediate removal in the current release matrix and task board', () => {
    const matrix = document('docs/implementation/INDEPENDENT_RELEASE_MATRIX.md');
    const board = document('docs/implementation/REMAINING_RELEASE_WORK.md');

    expect(matrix).toContain('ADR-021');
    expect(matrix).toContain('IR-08 | P-06 Existing-data safety');
    expect(matrix).toContain('IR-09 | P-06 Immediate compatibility removal');
    expect(matrix).not.toContain('Migration window has elapsed');
    expect(matrix).not.toContain(
      'Public stable build warns of Legacy Prototype-specific entry deprecation',
    );
    expect(board).toContain('W-08-04｜已取消（ADR-021）');
    expect(board).toContain('W-09-01｜已取消（ADR-021）');
    expect(board).toContain('39 项未完成、2 项由 ADR-021 取消');
    expect(board).not.toContain('迁移窗口达标 → M3');
  });

  it('gives unpublished prototype users a usable exit path without promising retired imports', () => {
    const guide = document('docs/implementation/UNPUBLISHED_PROTOTYPE_DATA_EXIT.md');
    const index = document('docs/README.md');

    expect(index).toContain('UNPUBLISHED_PROTOTYPE_DATA_EXIT.md');
    expect(guide).toContain('将其整个用户数据目录');
    expect(guide).toContain('当前 Axterm 不会读取或覆盖旧格式');
    expect(guide).toContain('不要**把旧便携 JSON 或单独主题文件');
    expect(guide).toContain('重新输入密码');
    expect(guide).toContain('重新选择背景图片');
    expect(guide).toContain('它不会替用户恢复已省略的 secret 或图片');
    expect(guide).toContain('不会原位打开或升级旧数据库/Vault');
  });

  it('documents the Axterm configuration API instead of the removed Legacy Prototype migration API', () => {
    const masterSpec = document('docs/architecture/MASTER_SPEC.md');

    expect(masterSpec).toContain('## 20.17 Axterm Configuration Snapshot');
    expect(masterSpec).toContain('/api/v1/data/axterm-configuration/previews');
    expect(masterSpec).toContain('commitAxtermConfigurationImport');
    expect(masterSpec).not.toContain('/api/v1/data/legacy-prototype/');
    expect(masterSpec).not.toContain('previewLegacy PrototypeData');
  });

  it('marks the former public migration guide as historical and unusable', () => {
    const guide = document('docs/implementation/MIGRATION_GUIDE.md');
    const coverage = document('docs/implementation/P06_MIGRATION_COVERAGE.md');

    expect(guide).toContain('历史草案：Legacy Prototype 兼容功能迁移指南');
    expect(guide).toContain('ADR-021');
    expect(guide).toContain('在当前产品中不可用，不得用于发布说明或指导用户');
    expect(coverage).toContain('Historical audit, superseded by [ADR-021]');
  });

  it('presents current release gates in the public README without advertising historical parity metrics', () => {
    const readme = document('README.md');

    expect(readme).toContain('## 当前独立发行状态');
    expect(readme).toContain('docs/implementation/INDEPENDENT_RELEASE_MATRIX.md');
    expect(readme).toContain('docs/implementation/HISTORICAL_REFERENCE_ARCHIVE.md');
    expect(readme).toContain('旧原型的来源与对照证据保留在受控的先前仓库');
    expect(readme).not.toContain('## 首版 1:1 历史证据');
    expect(readme).not.toContain('95% 相似度');
    expect(readme).not.toContain('Arabic RTL');
  });

  it('keeps retired submodule and parity records historical rather than current instructions', () => {
    const upstream = document('docs/implementation/UPSTREAM.md');
    const parityHarness = document('docs/implementation/PARITY_HARNESS.md');
    const versions = document('docs/implementation/VERSIONS.md');
    const documentationIndex = document('docs/README.md');
    const rootReadme = document('README.md');
    const masterSpec = document('docs/architecture/MASTER_SPEC.md');
    const agents = document('AGENTS.md');
    const status = document('docs/implementation/STATUS.md');
    const independentAdr = document('docs/adr/ADR-016-independent-open-source-product.md');
    const transferReplacementAdr = document(
      'docs/adr/ADR-018-independent-terminal-transfer-implementations.md',
    );
    const historicalTransferAdr = document(
      'docs/adr/ADR-013-terminal-transfer-protocol-adapters.md',
    );
    const retiredParityAdr = document('docs/adr/ADR-003-legacy-prototype-parity-program.md');
    const retiredParitySpec = document('docs/product/LEGACY_PROTOTYPE_PARITY_SPEC.md');
    const retiredParityRoadmap = document('docs/implementation/LEGACY_PROTOTYPE_PARITY_ROADMAP.md');
    const retiredParityMatrix = document('docs/implementation/LEGACY_PROTOTYPE_PARITY_MATRIX.md');
    const independentMatrix = document('docs/implementation/INDEPENDENT_RELEASE_MATRIX.md');
    const cleanupPlan = document('docs/implementation/COMMERCIALIZATION_CLEANUP_PLAN.md');
    const workflow = document('.github/workflows/check.yml');
    const contributing = document('CONTRIBUTING.md');
    const pullRequestTemplate = document('.github/pull_request_template.md');
    const migrationGuide = document('docs/implementation/MIGRATION_GUIDE.md');
    const migrationCoverage = document('docs/implementation/P06_MIGRATION_COVERAGE.md');
    const oldReleaseAudit = document(
      'docs/implementation/evidence/IR08-OLD-RELEASE-AVAILABILITY-2026-09-21.md',
    );
    const historicalPackageUpgrade = document(
      'docs/implementation/evidence/IR08-HISTORICAL-PACKAGE-UPGRADE-2026-09-23.md',
    );
    const legacyFieldLossEvidence = document(
      'docs/implementation/evidence/IR08-LEGACY-FIELD-LOSS-REPORT-2026-09-22.md',
    );
    const legacyBatchWorkflowEvidence = document(
      'docs/implementation/evidence/IR08-LEGACY-BATCH-WORKFLOW-2026-09-22.md',
    );
    const ephemeralCandidate = document(
      'docs/implementation/evidence/IR12-EPHEMERAL-GIT-CANDIDATE-2026-09-21.md',
    );
    const packagedOpenSsh = document(
      'docs/implementation/evidence/IR03-MACOS-PACKAGED-OPENSSH-2026-09-21.md',
    );
    const externalTransferPeerAvailability = document(
      'docs/implementation/evidence/IR03-EXTERNAL-TRANSFER-PEER-AVAILABILITY-2026-09-21.md',
    );
    const macosDmgEvidence = document('docs/implementation/evidence/IR13-MACOS-DMG-2026-09-21.md');
    const packagedSbomEvidence = document(
      'docs/implementation/evidence/IR11-PACKAGED-ARTIFACT-SBOM-2026-09-21.md',
    );
    const linuxInstallAttempt = document(
      'docs/implementation/evidence/IR13-LINUX-X64-INSTALL-ATTEMPT-2026-09-22.md',
    );
    const linuxFtpEvidence = document(
      'docs/implementation/evidence/IR04-LINUX-ARM64-CONTAINER-2026-09-21.md',
    );
    const ftpFilesystemIdentityEvidence = document(
      'docs/implementation/evidence/IR04-FTP-FILESYSTEM-IDENTITY-2026-09-22.md',
    );
    const ftpRestStreamEvidence = document(
      'docs/implementation/evidence/IR04-FTP-REST-STREAM-2026-09-22.md',
    );
    const ftpFeatureRenameEvidence = document(
      'docs/implementation/evidence/IR04-FTP-FEATURE-RENAME-SEQUENCE-2026-09-22.md',
    );
    const visualBaseline = document('docs/implementation/AXTERM_VISUAL_BASELINE.md');
    const assetReviewLedger = document('compliance/PRODUCT_ASSET_REVIEW_LEDGER.json');
    const assetProvenance = document('docs/implementation/PRODUCT_ASSET_PROVENANCE.md');
    const releaseOwnerHandoff = document('docs/implementation/RELEASE_OWNER_HANDOFF.md');
    const finalSnapshotExceptionGuide = document(
      'docs/implementation/PUBLIC_SNAPSHOT_EXCEPTION_TEMPLATE.md',
    );
    const finalSnapshotExceptionTemplate = document(
      'docs/implementation/PUBLIC_SNAPSHOT_EXCEPTION_TEMPLATE.json',
    );
    const localizationScopeAudit = document('docs/implementation/LOCALIZATION_SCOPE_AUDIT.md');
    const localizationFallbackPolicy = document(
      'docs/implementation/LOCALIZATION_FALLBACK_POLICY.md',
    );
    const coreReviewLedger = document('scripts/localization/axterm-core-review-ledger.json');
    const migrationReleaseRecord = document('compliance/MIGRATION_RELEASE_RECORD.json');
    const releaseServiceRecord = document('compliance/RELEASE_SERVICE_RECORD.json');
    const rootPackage = JSON.parse(document('package.json')) as {
      scripts: Record<string, string>;
    };
    const privacy = document('PRIVACY.md');
    const security = document('SECURITY.md');
    const support = document('SUPPORT.md');
    const sourceAudit = document('docs/implementation/COMMERCIALIZATION_SOURCE_AUDIT.md');
    const packaging = document('docs/implementation/PACKAGING.md');
    const vitestConfig = document('vitest.config.ts');

    expect(upstream.slice(0, 2_400)).toContain('# Historical upstream reuse ledger');
    expect(upstream.slice(0, 2_400)).toMatch(/\*\*not\*\* a current implementation/u);
    expect(upstream).not.toContain('It is retained as the Git submodule');
    const ftpServerRow = upstream
      .split('\n')
      .find((line) => line.startsWith('| `src/app/widgets/widget-local-ftp-server.js`'));
    expect(ftpServerRow).toContain('Axterm-authored implementation');
    expect(ftpServerRow).toContain('not the FTP server runtime');
    expect(ftpServerRow).not.toContain('retained the same MIT FTP server engine');
    expect(ftpServerRow).not.toContain('legacy-prototype-local-ftp-server.ts');
    expect(parityHarness.slice(0, 2_400)).toContain('not runnable from the current worktree');
    expect(parityHarness.slice(0, 2_400)).toContain('Do not initialize a submodule');
    expect(versions).toContain('## Historical upstream submodule');
    expect(documentationIndex).toContain(
      '当前工作树、构建和发行门禁不使用 `vendor/legacy-prototype`',
    );
    expect(documentationIndex).toContain('当前工作树不可运行，也不得复制进新公开仓库');
    expect(rootReadme).toContain('不参与当前构建或未来发布验收');
    expect(contributing).toContain('Apache License 2.0 第 5 节');
    expect(contributing).toContain('它不构成新的 CLA');
    expect(contributing).toContain('不得把本文件表述为已取得历史贡献者的追溯授权');
    expect(sourceAudit).toContain('local contributor-history scope check');
    expect(sourceAudit).toMatch(/No\s+contributor-rights sign-off is recorded here\./u);
    expect(releaseOwnerHandoff).toContain('受控历史来源审计');
    expect(releaseOwnerHandoff).toContain('贡献者历史范围核对');
    expect(releaseOwnerHandoff).toContain('IR-02 保持 **In progress**');
    expect(releaseOwnerHandoff).toContain('source:review:reviewed-check');
    expect(cleanupPlan).toContain('AXTERM_SOURCE_FILE_REVIEW_LEDGER.json');
    expect(pullRequestTemplate).toContain('来源与贡献授权');
    expect(pullRequestTemplate).toContain('我已披露所有非原创代码');
    expect(documentationIndex).toContain('MIGRATION_GUIDE');
    expect(documentationIndex).toContain('迁移发布记录');
    expect(documentationIndex).toContain('RELEASE_OWNER_HANDOFF');
    expect(migrationGuide).toContain('尚未公开发布，不构成迁移期公告');
    expect(migrationGuide).toContain('公开发布日期');
    expect(migrationGuide).toContain('Export Axterm configuration');
    expect(migrationGuide).toContain('Import Axterm configuration');
    expect(migrationGuide).toContain('Back up legacy remote and create Axterm profile');
    expect(migrationGuide).toMatch(
      /SSH、Local、Telnet、Serial、RDP、VNC、FTP、SPICE 和 Web 书签形状/u,
    );
    expect(migrationGuide).toMatch(/脱敏样例，派生自 Legacy Prototype v1\.101\.16/u);
    expect(migrationGuide).toMatch(/空用户名的 RDP 书签[\s\S]*?预览中显示 `Skip`/u);
    expect(migrationGuide).toMatch(/SPICE 仍由公开字段参考和合成样例/u);
    expect(migrationGuide).toMatch(/`runScripts` 会明确省略，绝不会执行/u);
    expect(migrationGuide).toMatch(/`credentialMetadata` 只是凭据清单，不含 secret/u);
    expect(migrationGuide).toMatch(/application-local Vault/u);
    expect(migrationGuide).toMatch(/预览或产品\s+SQLite 中/u);
    expect(migrationGuide).toMatch(/来源文件可能含有内嵌\s+secret/u);
    expect(migrationGuide).toContain('`legacy-prototype://`');
    expect(migrationGuide).toContain('`axterm://`');
    expect(migrationGuide).toContain('不会为了“清理”而删除任何远端用户数据');
    expect(migrationGuide).toMatch(/便携\s+配置文件描述为包含 Vault secret 的完整系统备份/u);
    expect(migrationGuide).toContain('冷备份整个应用数据目录');
    expect(migrationGuide).toContain('Axterm 目前没有一键完整本机备份');
    expect(migrationGuide).toContain('`master.key`');
    expect(migrationGuide).toContain('在 Axterm 仍关闭时核对');
    expect(migrationGuide).toContain('MIGRATION_RELEASE_RECORD.json');
    expect(migrationGuide).toContain('migration:record:active-check');
    expect(migrationGuide).toContain('migration:record:removal-check');
    expect(rootReadme).toContain('不再发布公开迁移版本');
    expect(rootReadme).toContain('ADR-021-immediate-legacy-prototype-compatibility-removal.md');
    expect(rootReadme).toContain('发行服务记录');
    expect(rootReadme).toContain('仅保留简体中文、繁体中文、英文和日文');
    expect(rootReadme).toContain('ADR-023-clean-local-source-root-and-data-profile.md');
    expect(rootReadme).toContain('名称零命中不替代实际发行内容的权利审查');
    expect(agents).toContain('ADR-023 决定新本地源码根与新数据目录');
    expect(masterSpec).toContain('ADR-016 已取代 ADR-003 的 Legacy Prototype 1:1 产品目标');
    expect(independentAdr).toContain(
      'Only English, Japanese, Simplified Chinese and Traditional Chinese are retained',
    );
    expect(independentAdr).toContain('Status: Accepted');
    expect(transferReplacementAdr).toContain('Status: Accepted for implementation');
    expect(transferReplacementAdr).toContain("Axterm's `xmodem.ts`");
    expect(transferReplacementAdr).toMatch(/source-rights\s+review remains required/u);
    expect(historicalTransferAdr).toContain('Superseded in part');
    expect(historicalTransferAdr).toContain('ADR-018 replaces this record');
    expect(packaging).toContain("Axterm's `xmodem.ts`");
    expect(packaging).not.toContain('adapted Legacy Prototype XMODEM state machine');
    expect(versions).toContain("Axterm's separately authored `xmodem.ts`");
    expect(versions).not.toContain('adapted XMODEM state machine');
    expect(retiredParityAdr.slice(0, 1_000)).toContain('Status: Historical');
    expect(retiredParityAdr.slice(0, 1_000)).toContain('not a current work queue');
    expect(retiredParitySpec.slice(0, 1_000)).toContain('Status: Historical');
    expect(retiredParityRoadmap.slice(0, 1_000)).toContain('状态：Historical');
    expect(retiredParityMatrix.slice(0, 1_000)).toContain('Historical evidence only');
    expect(independentMatrix).toMatch(
      /\| IR-01 \| P-01 Product and governance[\s\S]*?\| Accepted\s+\|/u,
    );
    expect(cleanupPlan).toContain('仅保留简体中文、繁体中文、英文和日文');
    expect(cleanupPlan).toContain('立即移除 Legacy Prototype 专属导入、协议链接和旧同步格式');
    expect(cleanupPlan).toContain('取消公开迁移期');
    expect(cleanupPlan).toContain('内置主题精简为 Axterm 自有集合');
    expect(cleanupPlan).toContain('按品牌和可用性目标适当修改、美化 UI/UX');
    expect(cleanupPlan).toContain('### 已锁定的语言发布范围');
    expect(cleanupPlan).toMatch(/\| `en`\s+\| English\s+\|/u);
    expect(cleanupPlan).toMatch(/\| `ja`\s+\| 日本語\s+\|/u);
    expect(cleanupPlan).toMatch(/\| `zh-CN`\s+\| 简体中文\s+\|/u);
    expect(cleanupPlan).toMatch(/\| `zh-TW`\s+\| 繁體中文\s+\|/u);
    expect(cleanupPlan).toContain('不能仅隐藏入口或保留为未发布的 catalog');
    expect(status).toContain(
      'only `en`, `ja`, `zh-CN` and `zh-TW` are selectable product/Contract',
    );
    expect(status).toContain('an additional locale or catalog');
    expect(oldReleaseAudit).toContain('no qualifying older public artifact located');
    expect(oldReleaseAudit).toContain('legacy-legacy-prototype-data-v1.json');
    expect(oldReleaseAudit).toMatch(/not\s+evidence of an\s+older published binary/u);
    expect(oldReleaseAudit).toContain('2026-09-23 historical-source follow-up');
    expect(oldReleaseAudit).toContain('IR08-HISTORICAL-PACKAGE-UPGRADE-2026-09-23');
    expect(migrationCoverage).toContain('old-release fixture availability audit');
    expect(migrationCoverage).toContain('historical package evidence');
    expect(migrationCoverage).toContain('byte-identical to the database produced');
    expect(migrationCoverage).toMatch(/changes the\s+remote\s+Axterm appearance setting/u);
    expect(migrationCoverage).toMatch(/reviewed commit restores all eight independent categories/u);
    expect(migrationCoverage).toMatch(/newly\s+mapped folder ID/u);
    expect(migrationCoverage).toMatch(/preserves both steps, delays,\s+description, tags/u);
    expect(migrationCoverage).toMatch(/custom terminal\s+theme referenced by/u);
    expect(migrationCoverage).toMatch(/custom theme to have a\s+new ID/u);
    expect(migrationCoverage).toMatch(/become the\s+restored terminal\s+setting's selected theme/u);
    expect(migrationCoverage).toMatch(/all three Profile\s+collections/u);
    expect(historicalPackageUpgrade).toContain('657b3cc1552cd3b0dc3b0f73df1c1a4a5a8a6a6e');
    expect(historicalPackageUpgrade).toContain(
      '5dc53bcc5997016a33e8fa41d588462a7b441cde759b181c95e4df6f91c916b0',
    );
    expect(historicalPackageUpgrade).toContain(
      'bed4a296707d50eb18abc52c71c2d8bb3c62e3cfb9454f97387117259954da3b',
    );
    expect(historicalPackageUpgrade).toContain('migrations 34–38');
    expect(historicalPackageUpgrade).toContain('3024 Day');
    expect(historicalPackageUpgrade).toContain('`…0003` to stable Axterm `Default` (`…0001`)');
    expect(historicalPackageUpgrade).toContain('legacy-legacy-prototype-v1');
    expect(historicalPackageUpgrade).toContain('WebDAV access and sync-encryption passwords');
    expect(historicalPackageUpgrade).toContain('byte-identical');
    expect(historicalPackageUpgrade).toContain(
      'a43d5bc9dbcbde23c66123f3a066e75483348f5a6ca278d0006e0cdcc0347a58',
    );
    expect(historicalPackageUpgrade).toContain(
      '1a7ef3993f6a8a0764a18e3a27930bae48e3cf1d8fc764b724b1da1dcb136008',
    );
    expect(historicalPackageUpgrade).toContain(
      'bc6d2df61b46a77c1cb97b9edf2122026f98c2794fb40d99467f940c4bad8851',
    );
    expect(historicalPackageUpgrade).toContain(
      'fe628bea9ace9acc8aae5e9fcfdce05bdaa50822b4d49f95e287a64859e15e6b',
    );
    expect(historicalPackageUpgrade).toMatch(/three authenticated reads and only the one/u);
    expect(historicalPackageUpgrade).toMatch(/explicit\s+`Confirm apply` commit/u);
    expect(historicalPackageUpgrade).toContain('Historical package command');
    expect(historicalPackageUpgrade).toContain('IR-08 remains **In progress**');
    expect(historicalPackageUpgrade).toContain('actual historical-package portable-file handoff');
    expect(historicalPackageUpgrade).toContain('11,477-byte legacy portable JSON file');
    expect(historicalPackageUpgrade).toContain('three credential-metadata records');
    expect(historicalPackageUpgrade).toContain('five creates');
    expect(historicalPackageUpgrade).toContain(
      'second Bookmark pointing to the imported connection Profile',
    );
    expect(historicalPackageUpgrade).toContain('commands[].id');
    expect(migrationCoverage).toContain('historical-source package now also exercises');
    expect(status).toContain('historical-package **portable-file** handoff');
    expect(status).toContain('real historical-source package transition');
    expect(status).toContain('pre-migration-34');
    expect(migrationCoverage).toMatch(/bookmark, default-terminal setting and tunnel/u);
    expect(migrationCoverage).toMatch(/credential references remain null/u);
    expect(migrationCoverage).toMatch(/all eight independent categories/u);
    expect(migrationCoverage).toMatch(/dedicated `addressBookmarks` and `workspaces` categories/u);
    expect(migrationCoverage).toMatch(/trigger must retain its matching\/action\/cooldown/u);
    expect(migrationCoverage).toMatch(/legacy remote\s+object and\s+write count remain unchanged/u);
    expect(migrationCoverage).toMatch(/real old-version fixtures and historical-format recovery/u);
    expect(migrationCoverage).toMatch(
      /writes an encrypted independent\s+document only to `\/axterm\/`/u,
    );
    expect(migrationCoverage).toMatch(/packaged download preview plus\s+explicit commit/u);
    expect(migrationCoverage).toMatch(/restores all eight independent\s+categories/u);
    expect(migrationCoverage).toMatch(/current\/named workspace layouts and startup selection/u);
    expect(migrationCoverage).toContain('AES-256-GCM+scrypt envelope');
    expect(migrationCoverage).toMatch(
      /contains neither the\s+Host name\/address[\s\S]*?encryption password/u,
    );
    expect(migrationCoverage).toMatch(/two\s+reads and zero\s+writes/u);
    expect(migrationCoverage).toMatch(/missing Axterm\s+target/u);
    expect(migrationCoverage).toMatch(/Custom merges the old and new files/u);
    expect(migrationCoverage).toMatch(/rejected before any Axterm `PUT`/u);
    expect(migrationCoverage).toMatch(/packaged macOS controlled-provider/u);
    expect(migrationCoverage).toMatch(/non-overwrite coverage for all four providers/u);
    expect(migrationCoverage).toMatch(/packaged preview plus explicit\s+commit/u);
    expect(migrationCoverage).toMatch(/recovery is read-only/u);
    expect(migrationCoverage).toMatch(
      /SSH plus the documented Legacy Prototype Local, Telnet, Serial, RDP, VNC, FTP, SPICE and Web bookmark shapes/u,
    );
    expect(migrationCoverage).toMatch(
      /Group\/Profile\/Quick Command and bookmark field reports show mapped and omitted fields/u,
    );
    expect(migrationCoverage).toMatch(
      /synthetic field fixtures cover all eight non-SSH protocols/u,
    );
    expect(status).toContain('actual Group, Profile and Quick\nCommand conversion rules');
    expect(sourceAudit).toContain('P-06 legacy field-loss reporting');
    expect(sourceAudit).toContain('P-08 current P-06 legacy-field-loss candidate');
    expect(legacyFieldLossEvidence).toContain('same conversion');
    expect(status).toContain('8342f5b137bbb8d3a89de044f37a200b0f73c22bdef857b2e29f47c76354ef92');
    expect(legacyFieldLossEvidence).toContain('IR-08 remains **In progress**');
    expect(legacyFieldLossEvidence).toContain('IR-09 remains **Open**');
    expect(legacyFieldLossEvidence).toContain('partially converted field may deliberately appear');
    expect(legacyFieldLossEvidence).toContain('application-local Credential Vault');
    expect(legacyFieldLossEvidence).toContain('623416e58a98e377577d7419ea3112b3c6db2f62');
    expect(vitestConfig).toContain('maxWorkers: 2');
    expect(vitestConfig).toContain('testTimeout: 10_000');
    expect(vitestConfig).toContain('hookTimeout: 10_000');
    expect(legacyFieldLossEvidence).toMatch(
      /synthetic current test data[\s\S]*?not[\s\S]*?older public/u,
    );
    expect(migrationCoverage).toContain('actual unsupported/shadowed source paths');
    expect(migrationCoverage).toContain('lost-wakeup race');
    expect(status).toContain('The migration-period `--batch-op` translator');
    expect(sourceAudit).toContain('P-06 legacy batch-workflow reporting');
    expect(legacyBatchWorkflowEvidence).toContain('IR-08 remains **In progress**');
    expect(legacyBatchWorkflowEvidence).toContain('IR-09 remains **Open**');
    expect(legacyBatchWorkflowEvidence).toContain('SYNTHETIC_LEGACY_WORKFLOW_SECRET');
    expect(legacyBatchWorkflowEvidence).toContain('passed three consecutive runs');
    expect(legacyBatchWorkflowEvidence).toContain(
      'def175cc7f9995102b6e4536be2379e8ceedab07f0b8ac2f220c44bb4e34c5d4',
    );
    expect(legacyBatchWorkflowEvidence).toMatch(
      /not[\s\S]*?older public Legacy Prototype or Axterm release/u,
    );
    expect(ephemeralCandidate).toContain('Current all-control candidate');
    expect(ephemeralCandidate).toContain('P-06 release-record replacement candidate');
    expect(ephemeralCandidate).toContain(
      'Current P-06 packaged encrypted-recovery and IR-12 source candidate',
    );
    expect(ephemeralCandidate).toContain(
      'Current P-06 packaged encrypted eight-category recovery and IR-12 source candidate',
    );
    expect(ephemeralCandidate).toContain(
      'Current P-06 packaged all-provider non-overwrite and IR-12 source candidate',
    );
    expect(ephemeralCandidate).toContain(
      'Current P-06 packaged all-provider reviewed recovery and IR-12 source candidate',
    );
    expect(ephemeralCandidate).toContain(
      'Current P-02 three-protocol Runtime-destruction and IR-12 source candidate',
    );
    expect(ephemeralCandidate).toContain(
      '28de9a7f5f7fb874d3c96d1d0dbd6b25a9520aca5e68bc1939e565a179ceb08a',
    );
    expect(ephemeralCandidate).toContain('cf9b0c059398edc83e44930becdab1d7e530b3d3');
    expect(ephemeralCandidate).toContain(
      'a27b04b9542fbdc93bf6d21d02c922f34680b9c7f5d83494d39f228cfd30d47e',
    );
    expect(ephemeralCandidate).toContain('cbb002685dc376319baae5d09d7be0415696926e');
    expect(ephemeralCandidate).toContain(
      '616cab1d3210ac7a33d4e4a1568cc70485b8cd4c471b67875a48a81769885550',
    );
    expect(ephemeralCandidate).toContain('d837e24dd834a5e4ef9204b4a8bc3bb6595457a1');
    expect(ephemeralCandidate).toContain(
      'd9bffaf962e6512161527eea4c18879c9b7623425481848ed676f7c5ac6c953e',
    );
    expect(ephemeralCandidate).toContain('6e881f4f101d9d74684f17a7a5198de403382da7');
    expect(ephemeralCandidate).toContain(
      'ab6d0909f8509b286123b15a3327050840327cf0448da18e207a4ed57cc078b7',
    );
    expect(ephemeralCandidate).toContain('0da5a66941e95e30ee8b5fb67fda828754e15a69');
    expect(ephemeralCandidate).toContain(
      'P-03 image-pinned Linux arm64/x64 and IR-03 peer-boundary candidate',
    );
    expect(ephemeralCandidate).toContain('2b5d622ec204dbdbe6fb01fee8ea02402958769e');
    expect(ephemeralCandidate).toContain('721 files, 15,291,010 bytes');
    expect(ephemeralCandidate).toContain('trace/HAR');
    expect(sourceAudit).toContain('P-08 current automated candidate');
    expect(sourceAudit).toContain('P-08 current P-04 command-history/bookmark-trigger candidate');
    expect(sourceAudit).toContain('P-08 current P-04 complete-core-draft candidate');
    expect(sourceAudit).toContain('P-08 current P-02 external-peer candidate');
    expect(sourceAudit).toContain('P-08 current P-02 dual-architecture external-peer candidate');
    expect(sourceAudit).toContain('P-08 current P-02 external-peer-through-SSH candidate');
    expect(sourceAudit).toContain('P-08 current P-02 external-peer-through-SSH XMODEM candidate');
    expect(sourceAudit).toContain('P-08 current P-02 external-peer-through-SSH TRZSZ candidate');
    expect(sourceAudit).toContain(
      'P-08 current P-02 external-peer-through-SSH cancellation-direction candidate',
    );
    expect(sourceAudit).toContain(
      'P-08 current P-02 external-peer-through-SSH all-protocol-cancellation candidate',
    );
    expect(sourceAudit).toContain(
      'P-08 current P-02 selection-timeout and P-07 mint-shell candidate',
    );
    expect(sourceAudit).toContain('P-08 current P-02 staged-publication portability candidate');
    expect(sourceAudit).toContain('P-08 current P-02 selected-transfer data-loss candidate');
    expect(sourceAudit).toContain('P-08 current P-02 selected-transfer peer-exit candidate');
    expect(sourceAudit).toContain('P-08 current P-02 staged-partial peer-exit candidate');
    expect(sourceAudit).toContain('P-08 current P-02 malformed-selected-frame candidate');
    expect(sourceAudit).toContain('P-08 current P-02 TRZSZ staged-peer-exit candidate');
    expect(sourceAudit).toContain('P-08 current P-02 XMODEM staged-peer-exit candidate');
    expect(sourceAudit).toContain('P-08 current patch-notice/final-removal-gate candidate');
    expect(sourceAudit).toContain('P-08 current P-03 FTP stream-cancellation candidate');
    expect(sourceAudit).toContain('P-08 current P-03 FTP control-session-limit candidate');
    expect(sourceAudit).toContain('P-08 current P-03 FTP filesystem-identity candidate');
    expect(sourceAudit).toContain('P-08 current P-03 FTP `REST STREAM` candidate');
    expect(sourceAudit).toContain('P-08 current P-03 FTP feature/rename-sequence candidate');
    expect(sourceAudit).toContain('P-08 current P-05 product-asset-scope candidate');
    expect(sourceAudit).toContain('P-08 current P-05 documentation-asset-boundary candidate');
    expect(sourceAudit).toContain('P-08 current P-07 connection-profile mint-focus candidate');
    expect(sourceAudit).toContain('P-08 current P-01 governance and P-07 rendered-mint candidate');
    expect(sourceAudit).toContain(
      'P-08 current P-02 selected-XMODEM-silence and P-07 Runtime-recovery-mint candidate',
    );
    expect(sourceAudit).toContain('P-08 current P-02 fixed-package external-peer candidate');
    expect(sourceAudit).toContain('P-08 current P-02 controlled-XMODEM-malformed-frame candidate');
    expect(sourceAudit).toContain(
      'P-08 current P-02 all-protocol-controlled-malformed-frame candidate',
    );
    expect(sourceAudit).toContain('P-08 current P-03 FTP `ABOR` candidate');
    expect(sourceAudit).toContain('P-08 current P-03 pending-PASV `ABOR` candidate');
    expect(sourceAudit).toContain('P-08 current P-03 same-peer PASV candidate');
    expect(sourceAudit).toContain('P-08 current P-03 Linux PASV-lifecycle candidate');
    expect(sourceAudit).toContain('P-08 current P-03 loopback-only FTP candidate');
    expect(sourceAudit).toContain('P-08 current IR-12 release-handoff candidate');
    expect(sourceAudit).toContain('P-08 current P-02 ADR-018 provenance candidate');
    expect(sourceAudit).toContain('P-08 current retired-source snapshot guard candidate');
    expect(sourceAudit).toContain('P-08 current final-public promotion-gate candidate');
    expect(sourceAudit).toContain('P-08 current P-06 local-recovery candidate');
    expect(sourceAudit).toContain(
      'c8e52b546858a24d54d276d3c2f560beccf1c124540f1668849e9ba27b597d98',
    );
    expect(sourceAudit).toContain('49b44312f397a1ccd27fa0943ba244f9cca5e52d');
    expect(sourceAudit).toContain('P-08 current P-06 setting/bookmark-recovery candidate');
    expect(sourceAudit).toContain(
      'd6cb2857696de4136ea7abce9fdcf0d2f20ed1f664dff811d89f43d1c2f7cd11',
    );
    expect(sourceAudit).toContain('2a948efd55672288dcfc8745a35db7c53770479a');
    expect(sourceAudit).toContain('P-08 current P-06 Quick Command-recovery candidate');
    expect(sourceAudit).toContain(
      'be6bdb33cd9e49b0a1045541659d668b5e70f21473c52b0d0e5dd15df2edb7c7',
    );
    expect(sourceAudit).toContain('1dcb993efd4c80cd8887788155c3cd6d924b9382');
    expect(sourceAudit).toContain('P-08 current P-06 custom-theme-remap candidate');
    expect(sourceAudit).toContain(
      '65736e3a2cbc0980f868aba1676c92aebcaad6241ece43a6da5d2dd6f648cfe9',
    );
    expect(sourceAudit).toContain('086edfe3cbccc85d63dd4d875282a5a24609bad5');
    expect(sourceAudit).toContain('P-08 current P-06 Profile-reference-recovery candidate');
    expect(sourceAudit).toContain(
      '0cd8a61e359a23d1d7c408f1c753bdaa4ead48c5d0c0015afc585d57cc615e22',
    );
    expect(sourceAudit).toContain('0e46f871dff0b122ebc24a53a0a088c48a32caba');
    expect(sourceAudit).toContain('P-08 current P-06 eight-category-recovery candidate');
    expect(sourceAudit).toContain(
      '9e0198e9880d7c2cda8a54546b3ede66f3567859d69c14abf981efb9488187b5',
    );
    expect(sourceAudit).toContain('32e4ed08fb41bc13e7e7c789c2003223033054be');
    expect(sourceAudit).toContain('P-08 current P-06 packaged-independent-recovery candidate');
    expect(sourceAudit).toContain(
      'dd73ad42aa0982228ac562852ac5da93b8f0b40a2e663a6884c7e24f42ae167b',
    );
    expect(sourceAudit).toContain('7cee857023cf3af9e904894bbef142982cdd9dee');
    expect(sourceAudit).toContain('P-08 current P-06 packaged-encrypted-recovery candidate');
    expect(sourceAudit).toContain(
      'P-08 current P-06 packaged-encrypted-eight-category-recovery candidate',
    );
    expect(sourceAudit).toContain(
      'P-08 current P-06 packaged-all-provider-non-overwrite candidate',
    );
    expect(sourceAudit).toContain(
      'P-08 current P-06 packaged-all-provider-reviewed-recovery candidate',
    );
    expect(sourceAudit).toContain('P-08 current P-02 three-protocol-Runtime-destruction candidate');
    expect(sourceAudit).toContain(
      '28de9a7f5f7fb874d3c96d1d0dbd6b25a9520aca5e68bc1939e565a179ceb08a',
    );
    expect(sourceAudit).toContain('cf9b0c059398edc83e44930becdab1d7e530b3d3');
    expect(sourceAudit).toContain(
      'a27b04b9542fbdc93bf6d21d02c922f34680b9c7f5d83494d39f228cfd30d47e',
    );
    expect(sourceAudit).toContain('cbb002685dc376319baae5d09d7be0415696926e');
    expect(sourceAudit).toContain(
      '616cab1d3210ac7a33d4e4a1568cc70485b8cd4c471b67875a48a81769885550',
    );
    expect(sourceAudit).toContain('d837e24dd834a5e4ef9204b4a8bc3bb6595457a1');
    expect(sourceAudit).toContain(
      'a627e04edbbc81137820f3347c37593cfbbca8858281a1464841b8cbfb7448f6',
    );
    expect(sourceAudit).toContain(
      'd9bffaf962e6512161527eea4c18879c9b7623425481848ed676f7c5ac6c953e',
    );
    expect(sourceAudit).toContain('6e881f4f101d9d74684f17a7a5198de403382da7');
    expect(sourceAudit).toContain(
      'ab6d0909f8509b286123b15a3327050840327cf0448da18e207a4ed57cc078b7',
    );
    expect(sourceAudit).toContain('0da5a66941e95e30ee8b5fb67fda828754e15a69');
    expect(sourceAudit).toContain(
      'ecc1aa6ee4f949e4ace0bf3e852ffe5e2576706eef04c6c486f3c534d0dca8a1',
    );
    expect(sourceAudit).toContain(
      '5eb4f57f7260a6000cf21a641bb2c032cd49860c18769aef54ab0a3cf3a5cf82',
    );
    expect(sourceAudit).toContain('89292d97f2d50b5b5ab5b89a30760946fc4e941e');
    expect(sourceAudit).toContain(
      'abfa7b097fdd6ca449cac6b4a42bf4f380fad1999e9c696dbf13258d79836b34',
    );
    expect(sourceAudit).toContain('6146cb61388ef62a3097c56301367347a8b2a686');
    expect(sourceAudit).toContain(
      '13c8deb354b795b6a38f5ee0173a14790fe5face9ae258a42c4f9ef6ceb4c4de',
    );
    expect(sourceAudit).toContain('3b62aa542bade2b0a9e48114ecd0b9776f19e233');
    expect(sourceAudit).toContain(
      '4fce07c1f62e1d99d2025f29011807a2bba0f2e402015bd984d4737d1ab57567',
    );
    expect(sourceAudit).toContain('1226a26feef79119baef2ebc24dd2d72a0da0072');
    expect(sourceAudit).toContain(
      'e28ac8fe6c737df4bcd15ab2a27c81d3e2e4e06a59ef2bb52752bba6f5ba0cb4',
    );
    expect(sourceAudit).toContain('39410efdb142887ca78afd19818dd65d00849e53');
    expect(sourceAudit).toContain(
      '6d5c06760ef5e68b47f8dac6d51dbb3f47726998bf4dd7b3486bca20d8b7a6e2',
    );
    expect(sourceAudit).toContain('b3a3fa3b52f10f098ab39468a9ed0ecc46d162d0');
    expect(sourceAudit).toContain(
      '09effef707f4ace084eaebe622d348637dc316bd46a6eb039ac62e5bfeccef0a',
    );
    expect(sourceAudit).toContain('3de0e227bf95e82ea48677b099886bfceb026831');
    expect(sourceAudit).toContain(
      'badf40ee2f558df2d5c580b531519b0f1ce33bd72f03a716c9cd02ea0a3b8bfe',
    );
    expect(sourceAudit).toContain('8bc499847ee91ad3c38fdd37097614586914d80b');
    expect(sourceAudit).toContain(
      '047df9275e37c2128adcf9d6479aaef279140ca4582d0704d5fa85920f05c8e3',
    );
    expect(sourceAudit).toContain('8d8173c7c07240a178b1ea7a7749063b5b2f8ae8');
    expect(sourceAudit).toContain('thirteen hash-pinned Debian `lrzsz` tests');
    expect(sourceAudit).toContain('incoming-data-loss and peer-exit cleanup evidence');
    expect(status).toContain('post-selection external ZMODEM transport-loss case');
    expect(status).toMatch(
      /direct Runtime-destruction cleanup regressions across XMODEM,\s+ZMODEM and TRZSZ/u,
    );
    expect(status).toMatch(/leave neither a published destination nor a\s+`.part` file/u);
    expect(externalTransferPeerAvailability).toMatch(
      /XMODEM, ZMODEM and TRZSZ selected-\s+transfer peer-exit cleanup after staged bytes and ZMODEM incoming-data-loss\s+cleanup/,
    );
    expect(externalTransferPeerAvailability).toMatch(
      /controlled peer-exit cleanup\s*coverage for partial staged output/,
    );
    expect(externalTransferPeerAvailability).toContain(
      'Runtime-destruction cleanup symmetry — 2026-09-22',
    );
    expect(externalTransferPeerAvailability).toMatch(
      /XMODEM, ZMODEM and TRZSZ[\s\S]*?publishes no destination and emits no file\/session-completion event/u,
    );
    expect(externalTransferPeerAvailability).toContain(
      'Deterministic partial-write failure cleanup — 2026-09-23',
    );
    expect(externalTransferPeerAvailability).toMatch(
      /nine protocol\/error pairs[\s\S]*?first 64 bytes[\s\S]*?selected error code[\s\S]*?remove the partially written staging file/u,
    );
    expect(status).toContain('true partial filesystem write');
    expect(status).toContain('three focused protocol files pass 43 tests');
    expect(sourceAudit).toContain('Current P-02 partial-write failure candidate');
    expect(ephemeralCandidate).toContain(
      'Current P-02 partial-write failure and IR-12 source candidate',
    );
    expect(ephemeralCandidate).toContain('762 files / 16,469,993 bytes');
    expect(ephemeralCandidate).toContain(
      'e8627f6a8054e6c2ce5348690f5dfe3b662c1179058930a49fcd0887a528da4e',
    );
    expect(ephemeralCandidate).toContain('0ee610d831faf1e033c7f9bcbfae40332564802e');
    expect(ephemeralCandidate).toContain('762 files, 16,479,416 bytes');
    expect(ephemeralCandidate).toContain(
      '580b98847b5669534b0edc734d4d177caddd80b898a52f9bedf6fcfde826eff7',
    );
    expect(ephemeralCandidate).toContain('93d0711fff4ac89a5d5c641872dbb5e6c2c123c9');
    expect(ephemeralCandidate).toContain('Current P-03 FTP partial-write failure candidate');
    expect(ephemeralCandidate).toContain(
      '82ed1a3de4bc2de83877c4734123fe76735a081e37e2d9be8f90ee6e8525001b',
    );
    expect(ephemeralCandidate).toContain('55a2f430810b98dc3ba8fb3201676918c1189e7f');
    expect(sourceAudit).toContain('Current P-03 FTP partial-write failure candidate');
    expect(status).toContain('P-03 now also has deterministic partial-write cleanup evidence');
    expect(sourceAudit).toContain('bun run candidate:check');
    expect(sourceAudit).toContain('Historical P-04 first replacement');
    expect(sourceAudit).toContain('7f6209df5c818b0f06226c8052a840296d07726f');
    expect(sourceAudit).toContain('729 files / 15,586,052 bytes');
    expect(ephemeralCandidate).toContain(
      '395b6e5afa45a9d3ede561a00730cfc5bc7fb0c495d0199b7a44f1301f8e4ba2',
    );
    expect(ephemeralCandidate).toContain(
      'Current P-04 command-history and bookmark-trigger candidate',
    );
    expect(ephemeralCandidate).toContain('Current P-04 complete-core-draft candidate');
    expect(ephemeralCandidate).toContain('Current P-02 external-peer candidate');
    expect(ephemeralCandidate).toContain('Current P-02 dual-architecture external-peer candidate');
    expect(ephemeralCandidate).toContain('Current P-02 external-peer-through-SSH candidate');
    expect(ephemeralCandidate).toContain('Current P-02 external-peer-through-SSH XMODEM candidate');
    expect(ephemeralCandidate).toContain('Current P-02 external-peer-through-SSH TRZSZ candidate');
    expect(ephemeralCandidate).toContain(
      'Current P-02 external-peer-through-SSH cancellation-direction candidate',
    );
    expect(ephemeralCandidate).toContain(
      'Current P-02 external-peer-through-SSH all-protocol-cancellation candidate',
    );
    expect(ephemeralCandidate).toContain(
      'Current P-02 selection-timeout and P-07 mint-shell candidate',
    );
    expect(ephemeralCandidate).toContain('Current P-02 staged-publication portability candidate');
    expect(ephemeralCandidate).toContain('Current P-02 selected-transfer data-loss candidate');
    expect(ephemeralCandidate).toContain('Historical P-02 selected-transfer peer-exit candidate');
    expect(ephemeralCandidate).toContain('Current P-02 staged-partial peer-exit candidate');
    expect(ephemeralCandidate).toContain('Current P-02 malformed-selected-frame candidate');
    expect(ephemeralCandidate).toContain('Current P-02 TRZSZ staged-peer-exit candidate');
    expect(ephemeralCandidate).toContain('Current P-02 XMODEM staged-peer-exit candidate');
    expect(ephemeralCandidate).toContain('Current P-03 FTP stream-cancellation candidate');
    expect(ephemeralCandidate).toContain('Current P-03 FTP control-session-limit candidate');
    expect(ephemeralCandidate).toContain('Current P-03 FTP filesystem-identity candidate');
    expect(ephemeralCandidate).toContain(
      '6d3a2cbecb2a2921fb4c8fc3a5d57a800f4625d113b9c9b9cd3cb3223595f83f',
    );
    expect(ephemeralCandidate).toContain('26b8c13fa1232b36ff5a736103dc2f9443e2b419');
    expect(ephemeralCandidate).toContain('Current P-03 FTP REST STREAM candidate');
    expect(ephemeralCandidate).toContain(
      '75521c0b29cc3d40e90bdda600374b51d0b4289207c1934427e490ff07f3755a',
    );
    expect(ephemeralCandidate).toContain('c302a43c31ac55ed2688348dc282ff34de19da22');
    expect(ephemeralCandidate).toContain('Current P-03 FTP feature and rename-sequence candidate');
    expect(ephemeralCandidate).toContain(
      '60792bf2057c2e76a7be3ad12f03822b4086a0b4a6e2a6bd7f0fd6e68e56276e',
    );
    expect(ephemeralCandidate).toContain('36c7bb3cd10286c1d7b861db89e3c4b255af91e2');
    expect(ephemeralCandidate).toContain('Current P-06 legacy field-loss-reporting candidate');
    expect(ephemeralCandidate).toContain(
      '8342f5b137bbb8d3a89de044f37a200b0f73c22bdef857b2e29f47c76354ef92',
    );
    expect(ephemeralCandidate).toContain('623416e58a98e377577d7419ea3112b3c6db2f62');
    expect(ephemeralCandidate).toContain('no test was\nskipped and no timeout was extended');
    expect(ephemeralCandidate).toContain('Current P-06 legacy batch-workflow candidate');
    expect(ephemeralCandidate).toContain(
      'a6e0f1062276ea489943236952d09454df0df24f4c984cd29c6a1f64c64acac0',
    );
    expect(ephemeralCandidate).toContain('cda5ad67740d3dfc0b82cc0415fd4401b07d490e');
    expect(status).toContain('current P-08 local independent-build candidate now supersedes');
    expect(sourceAudit).toContain('current P-06 legacy batch-workflow candidate');
    expect(ephemeralCandidate).toContain('Current P-05 product-asset-scope candidate');
    expect(ephemeralCandidate).toContain('Current P-05 documentation-asset-boundary candidate');
    expect(ephemeralCandidate).toContain('Current P-07 connection-profile mint-focus candidate');
    expect(ephemeralCandidate).toContain(
      'Current P-01 governance and P-07 rendered-mint candidate',
    );
    expect(ephemeralCandidate).toContain(
      '932406c746c194389560e83eea3adc5d7f5e472eab401612bb6e6a9e578f9835',
    );
    expect(ephemeralCandidate).toContain(
      'Current P-02 selected-XMODEM-silence and P-07 Runtime-recovery-mint candidate',
    );
    expect(ephemeralCandidate).toContain(
      '2d6faf61fc400a8a290957092af8437b399f96701c12dc918a98cba5f277343b',
    );
    expect(ephemeralCandidate).toContain('fa8799b72d5071913565fa9ae10364820a486d83');
    expect(ephemeralCandidate).toContain('Current P-02 fixed-package external-peer candidate');
    expect(ephemeralCandidate).toContain(
      '89009fd18e5bbf6d70e608e45f11571164cef598033e0f1cfb6f4c6e24763e6b',
    );
    expect(ephemeralCandidate).toContain('15669fdf794f97a6546b1b0e5cac36d9aa72f875');
    expect(ephemeralCandidate).toContain(
      'Current P-02 controlled-XMODEM-malformed-frame candidate',
    );
    expect(ephemeralCandidate).toContain(
      'Current P-02 all-protocol-controlled-malformed-frame candidate',
    );
    expect(ephemeralCandidate).toContain(
      'f690145a04a2dbcc6707c314bf32742bec54107673e455797a1ed1b08e46bea2',
    );
    expect(ephemeralCandidate).toContain('01a11f905a025baa04da8013af2c1a3be9baff6d');
    expect(ephemeralCandidate).toContain(
      'b88551dc87d57250e32787a97d72e8a957a1dd21ee044d6388096938eb99760f',
    );
    expect(ephemeralCandidate).toContain('1df70dae5eaddcd58dd6511ca325ba0673384fd8');
    expect(ephemeralCandidate).toContain('Current P-03 FTP ABOR candidate');
    expect(ephemeralCandidate).toContain('Current P-03 pending-PASV ABOR candidate');
    expect(ephemeralCandidate).toContain('Current P-03 same-peer PASV candidate');
    expect(ephemeralCandidate).toContain('Current P-03 Linux PASV-lifecycle candidate');
    expect(ephemeralCandidate).toContain('Current P-03 loopback-only FTP candidate');
    expect(ephemeralCandidate).toContain('Current P-08 release-handoff candidate');
    expect(ephemeralCandidate).toContain('Current P-02 ADR-018 provenance candidate');
    expect(ephemeralCandidate).toContain(
      '5eb4f57f7260a6000cf21a641bb2c032cd49860c18769aef54ab0a3cf3a5cf82',
    );
    expect(ephemeralCandidate).toContain('89292d97f2d50b5b5ab5b89a30760946fc4e941e');
    expect(ephemeralCandidate).toContain(
      'abfa7b097fdd6ca449cac6b4a42bf4f380fad1999e9c696dbf13258d79836b34',
    );
    expect(ephemeralCandidate).toContain('6146cb61388ef62a3097c56301367347a8b2a686');
    expect(ephemeralCandidate).toContain(
      '13c8deb354b795b6a38f5ee0173a14790fe5face9ae258a42c4f9ef6ceb4c4de',
    );
    expect(ephemeralCandidate).toContain('3b62aa542bade2b0a9e48114ecd0b9776f19e233');
    expect(ephemeralCandidate).toContain(
      '4fce07c1f62e1d99d2025f29011807a2bba0f2e402015bd984d4737d1ab57567',
    );
    expect(ephemeralCandidate).toContain('1226a26feef79119baef2ebc24dd2d72a0da0072');
    expect(ephemeralCandidate).toContain(
      'e28ac8fe6c737df4bcd15ab2a27c81d3e2e4e06a59ef2bb52752bba6f5ba0cb4',
    );
    expect(ephemeralCandidate).toContain('39410efdb142887ca78afd19818dd65d00849e53');
    expect(ephemeralCandidate).toContain(
      '6d5c06760ef5e68b47f8dac6d51dbb3f47726998bf4dd7b3486bca20d8b7a6e2',
    );
    expect(ephemeralCandidate).toContain('b3a3fa3b52f10f098ab39468a9ed0ecc46d162d0');
    expect(ephemeralCandidate).toContain(
      '09effef707f4ace084eaebe622d348637dc316bd46a6eb039ac62e5bfeccef0a',
    );
    expect(ephemeralCandidate).toContain('3de0e227bf95e82ea48677b099886bfceb026831');
    expect(ephemeralCandidate).toContain('Current P-08 retired-source snapshot guard candidate');
    expect(ephemeralCandidate).toContain(
      'badf40ee2f558df2d5c580b531519b0f1ce33bd72f03a716c9cd02ea0a3b8bfe',
    );
    expect(ephemeralCandidate).toContain('8bc499847ee91ad3c38fdd37097614586914d80b');
    expect(ephemeralCandidate).toContain('Current P-08 final-public promotion-gate candidate');
    expect(ephemeralCandidate).toContain(
      '047df9275e37c2128adcf9d6479aaef279140ca4582d0704d5fa85920f05c8e3',
    );
    expect(ephemeralCandidate).toContain('8d8173c7c07240a178b1ea7a7749063b5b2f8ae8');
    expect(ephemeralCandidate).toContain(
      'cf0806d6998def5c512bfaed6a8b3c6d4c451bb4c13c61cd32c7c5bf4b3a5ece',
    );
    expect(ephemeralCandidate).toContain(
      '8a37667f5e8e055c00f788884f6013231933536607f7f9066c5e7bfdcd21a07d',
    );
    expect(ephemeralCandidate).toContain(
      'db09e5caf09be94530e6b46513c684d0efee05f137b6e043ee2980a1c3b0559e',
    );
    expect(ephemeralCandidate).toContain(
      'e2db7f4ed6dc2cd726234ca18f8c6617e71c9db436393222b21160cb9fb4885a',
    );
    expect(ephemeralCandidate).toContain(
      '1f5509cc9124995b5b42c517c96793da1c851987d7b3d23b1bbc0e6759b6dc99',
    );
    expect(ephemeralCandidate).toContain(
      'd02115c9284fc41f10d9a362fbaef17575210044178fe9653b133912c2cda3b5',
    );
    expect(ephemeralCandidate).toContain(
      'fa6763a2e677639625083defecbfae83503f28f86107d91290fad7356115778a',
    );
    expect(ephemeralCandidate).toContain(
      'e8ec8bc68e9d8441dc1f32ba8b397de98a89b864e989423316e41ad0a9dad7a5',
    );
    expect(ephemeralCandidate).toContain(
      '2189b0657b06a524baf1a062f6dc34a39f83ab9000219a8613f552b1954538f7',
    );
    expect(ephemeralCandidate).toContain('2e0856496430c296b73f7d473c180cef1cf53a76');
    expect(ephemeralCandidate).toContain(
      '2b6d4d19aa3fe7b3a5a7e6d091e6b776e22f717d8a7c748561f737e9e41cc8a5',
    );
    expect(ephemeralCandidate).toContain('6203e7d4b24648d035ef303932918cdb94d62530');
    expect(ephemeralCandidate).toContain(
      '4b71fd22cc9811db2854a2cf5cf9cfc3f5251a9df4756a1937d51581817d68e2',
    );
    expect(ephemeralCandidate).toContain('49ef6cc1471f34cf7b4bdbca1456d0ad82481125');
    expect(ephemeralCandidate).toContain(
      '6154eae2061f5cacebc8f6f043b28018fa7b3943b03cf78fc9f1fd6f2c6f1516',
    );
    expect(ephemeralCandidate).toContain('d7afd586b593699a8768a4c4bb60fbfbff7d7a40');
    expect(ephemeralCandidate).toContain(
      'd96efb07da4d618ddebe2e15c04280d19de579c17903565509a879b1d9779bf0',
    );
    expect(ephemeralCandidate).toContain('443bd4c41f5beb39f1f9752cf93a3b3dedd895e2');
    expect(ephemeralCandidate).toContain(
      '844806b85a35e47e92f7959adeb5828ea160c6698649b2b8a34c0b22b26c27b8',
    );
    expect(ephemeralCandidate).toContain('95baa599bfd5929a9d7d542fae0288123dde91f7');
    expect(ephemeralCandidate).toContain(
      'e51ec11d6e76aa7f666e186822ad608f9d82ee1942890e66c1759dc6d8dbb3b2',
    );
    expect(ephemeralCandidate).toContain('212b1e88f131efb2a958d5bbb4eec302a6a41041');
    expect(ephemeralCandidate).toContain(
      '1a4452f85b1a8fb37ea9c3c9928b0ef5bb595571159930b9707d9a3664eaaa3c',
    );
    expect(ephemeralCandidate).toContain('668939c63c11bf8f181867ba30ca61c0f57810ec');
    expect(ephemeralCandidate).toContain(
      'e9a29ab81ac6179d6f4a87f03013951182bb3dc254264cfda2e7ad7b2a391cd9',
    );
    expect(ephemeralCandidate).toContain('762fa981026af5cd565bcb31e802be9c4c81e8ba');
    expect(ephemeralCandidate).toContain(
      'a2a9a0e7663cc2b75aac9c2578b2d4ee74fdfb2de4f054532082415cf6a58f68',
    );
    expect(ephemeralCandidate).toContain('2b62b01c2d06c51d7989c0cba2cbbf5e6502d7a9');
    expect(ephemeralCandidate).toContain(
      'e4312293be5990ae40cbeafeb2542d79adf66859ee781b7dc42e5af9575c7aab',
    );
    expect(ephemeralCandidate).toContain('8a8055a6cf27eeec90c7f7904bc80c089ffdd67f');
    expect(ephemeralCandidate).toContain(
      'bfe80f28f79715a083a182d881f502a1a3fbbf1f2776c7d3268d9601bb996050',
    );
    expect(ephemeralCandidate).toContain('f288c0589ad9289d2ccbeac3ed5199125b0bf894');
    expect(ephemeralCandidate).toContain(
      '32534ce012e0146d55a3a62e03b40c973069c9cb56271be364d82f215e44f4d0',
    );
    expect(ephemeralCandidate).toContain('2,386 Japanese and 2,386 Traditional-Chinese');
    expect(ephemeralCandidate).toContain(
      '36f8b910497067c9f4737d5d70437e32a806081f779a69e6c112f7d266eded39',
    );
    expect(ephemeralCandidate).toContain('Current P-06 local-recovery and IR-12 source candidate');
    expect(ephemeralCandidate).toContain('746 files, 15,442,880 bytes');
    expect(ephemeralCandidate).toContain(
      'c8e52b546858a24d54d276d3c2f560beccf1c124540f1668849e9ba27b597d98',
    );
    expect(ephemeralCandidate).toContain('49b44312f397a1ccd27fa0943ba244f9cca5e52d');
    expect(ephemeralCandidate).toContain(
      'default candidate gate does not run the broader `desktop`',
    );
    expect(ephemeralCandidate).toContain(
      'Current P-06 setting/bookmark-recovery and IR-12 source candidate',
    );
    expect(ephemeralCandidate).toContain('746 files, 15,452,442 bytes');
    expect(ephemeralCandidate).toContain(
      'd6cb2857696de4136ea7abce9fdcf0d2f20ed1f664dff811d89f43d1c2f7cd11',
    );
    expect(ephemeralCandidate).toContain('2a948efd55672288dcfc8745a35db7c53770479a');
    expect(ephemeralCandidate).toMatch(/restore the setting,\s+host and SSH bookmark/u);
    expect(ephemeralCandidate).toContain(
      'Current P-06 Quick Command-recovery and IR-12 source candidate',
    );
    expect(ephemeralCandidate).toContain('746 files, 15,463,826 bytes');
    expect(ephemeralCandidate).toContain(
      'be6bdb33cd9e49b0a1045541659d668b5e70f21473c52b0d0e5dd15df2edb7c7',
    );
    expect(ephemeralCandidate).toContain('1dcb993efd4c80cd8887788155c3cd6d924b9382');
    expect(ephemeralCandidate).toMatch(/reference the newly generated folder ID/u);
    expect(ephemeralCandidate).toMatch(/retain both steps and metadata/u);
    expect(ephemeralCandidate).toContain(
      'Current P-06 custom-theme remap and IR-12 source candidate',
    );
    expect(ephemeralCandidate).toContain('746 files, 15,475,343 bytes');
    expect(ephemeralCandidate).toContain(
      '65736e3a2cbc0980f868aba1676c92aebcaad6241ece43a6da5d2dd6f648cfe9',
    );
    expect(ephemeralCandidate).toContain('086edfe3cbccc85d63dd4d875282a5a24609bad5');
    expect(ephemeralCandidate).toMatch(/recreate the theme under a different ID/u);
    expect(ephemeralCandidate).toMatch(/remap the restored terminal setting to that new ID/u);
    expect(ephemeralCandidate).toContain(
      'Current P-06 Profile-reference recovery and IR-12 source candidate',
    );
    expect(ephemeralCandidate).toContain('746 files, 15,492,019 bytes');
    expect(ephemeralCandidate).toContain(
      '0cd8a61e359a23d1d7c408f1c753bdaa4ead48c5d0c0015afc585d57cc615e22',
    );
    expect(ephemeralCandidate).toContain('0e46f871dff0b122ebc24a53a0a088c48a32caba');
    expect(ephemeralCandidate).toMatch(/recreate every Profile and the Host under new IDs/u);
    expect(ephemeralCandidate).toMatch(/keep all credential references null/u);
    expect(ephemeralCandidate).toContain(
      'Current P-06 eight-category recovery and IR-12 source candidate',
    );
    expect(ephemeralCandidate).toContain('746 files, 15,511,811 bytes');
    expect(ephemeralCandidate).toContain(
      '9e0198e9880d7c2cda8a54546b3ede66f3567859d69c14abf981efb9488187b5',
    );
    expect(ephemeralCandidate).toContain('32e4ed08fb41bc13e7e7c789c2003223033054be');
    expect(ephemeralCandidate).toMatch(/all eight independent Axterm sync categories/u);
    expect(ephemeralCandidate).toMatch(/remap every Host\/bookmark\/Profile\/theme reference/u);
    expect(ephemeralCandidate).toContain(
      'Current P-06 packaged independent-recovery and IR-12 source candidate',
    );
    expect(ephemeralCandidate).toContain('746 files, 15,526,426 bytes');
    expect(ephemeralCandidate).toContain(
      'dd73ad42aa0982228ac562852ac5da93b8f0b40a2e663a6884c7e24f42ae167b',
    );
    expect(ephemeralCandidate).toContain('7cee857023cf3af9e904894bbef142982cdd9dee');
    expect(ephemeralCandidate).toContain(
      'ecc1aa6ee4f949e4ace0bf3e852ffe5e2576706eef04c6c486f3c534d0dca8a1',
    );
    expect(ephemeralCandidate).toMatch(/old `\/legacy-prototype\/` bytes\s+remain exact/u);
    expect(ephemeralCandidate).toMatch(
      /IR-12\s+\*\*In progress\*\*,\s+IR-13\s+\*\*Open\*\*\s+and\s+IR-14\s+\*\*Open\*\*/u,
    );
    expect(packagedOpenSsh).toContain('controlled local OpenSSH fixture');
    expect(packagedOpenSsh).toContain('IR-03 remains **In progress**');
    expect(packagedOpenSsh).toMatch(/Fixture cleanup check[\s\S]*zero.*networks remained/u);
    expect(externalTransferPeerAvailability).toContain(
      'rz, sz, rx, sx, rb, sb, lrz, lsz, trz, tsz: absent',
    );
    expect(externalTransferPeerAvailability).toContain('rather than relabeling an Axterm fixture');
    expect(externalTransferPeerAvailability).toContain('Container peer discovery result');
    expect(externalTransferPeerAvailability).toContain('more than 60 seconds');
    expect(externalTransferPeerAvailability).toContain('base-image digest');
    expect(externalTransferPeerAvailability).toContain('Reproducible external `lrzsz` Docker peer');
    expect(externalTransferPeerAvailability).toContain('0.12.21-10');
    expect(externalTransferPeerAvailability).toContain(
      'e2935271e50ca6d53cd6b6daa2a7251aad136e8b2b193aedbf4570eaf3dc5c31',
    );
    expect(externalTransferPeerAvailability).toContain(
      '60c15258a977b837671f99f60a7876b1dfa7cebd9ed1a7dcd16d922b6e1b9cfe',
    );
    expect(externalTransferPeerAvailability).toContain('linux/amd64');
    expect(externalTransferPeerAvailability).toContain(
      'four 16,389-byte binary transfer directions',
    );
    expect(externalTransferPeerAvailability).toContain('six passing tests');
    expect(externalTransferPeerAvailability).toContain('peer exits nonzero');
    expect(externalTransferPeerAvailability).toContain('external-lrzsz-ssh-pty.test.ts');
    expect(externalTransferPeerAvailability).toContain('production `Ssh2Transport`');
    expect(externalTransferPeerAvailability).toContain('controlled loopback fixture');
    expect(externalTransferPeerAvailability).toContain(
      'Each platform-selected run passed sixteen tests',
    );
    expect(externalTransferPeerAvailability).toContain('AXTERM_EXTERNAL_LRZSZ_DEB');
    expect(externalTransferPeerAvailability).toContain(
      'controlled external XMODEM selected-transfer\nsilence coverage',
    );
    expect(externalTransferPeerAvailability).toContain(
      'controlled external XMODEM malformed-frame\ncoverage through a real Debian peer',
    );
    expect(externalTransferPeerAvailability).toContain(
      'controlled external ZMODEM\nmalformed-frame coverage through a real Debian peer',
    );
    expect(externalTransferPeerAvailability).toContain(
      'Reproducible external `trzsz-go` Docker peer',
    );
    expect(externalTransferPeerAvailability).toContain('GitHub v1.2.0 release');
    expect(externalTransferPeerAvailability).toContain(
      '9a73c237b6b12af267e878591ff22a01c97ca9d1cd8125f9ff4ffd6df4fea97c',
    );
    expect(externalTransferPeerAvailability).toContain(
      '70e3e0847177d4c7b681a8ec19fa00092e422a6c628ef9d8a5db6dfbf4612add',
    );
    expect(externalTransferPeerAvailability).toContain('upstream `tsz` exits with status 0');
    expect(externalTransferPeerAvailability).toContain('external-trzsz-ssh-pty.test.ts');
    expect(externalTransferPeerAvailability).toContain(
      'Reproducible external `trzsz-go` peer through an SSH PTY',
    );
    expect(externalTransferPeerAvailability).toContain(
      'Each platform-selected run passed seven tests',
    );
    expect(externalTransferPeerAvailability).toContain('destination-selection timeout');
    expect(externalTransferPeerAvailability).toContain('staged-byte peer\nexit');
    expect(externalTransferPeerAvailability).toContain('External-peer malformed-frame');
    expect(externalTransferPeerAvailability).toContain(
      'controlled external TRZSZ malformed-frame coverage',
    );
    expect(externalTransferPeerAvailability).toMatch(
      /an arbitrary\s+non-channel-close\s+partial-file failure after a selection/u,
    );
    expect(status).toContain('selected-destination malformed-frame cleanup regression');
    expect(status).toContain('standard FTP `ABOR` semantics on a live control/data\npair');
    expect(status).toContain('still awaiting its PASV data connection');
    expect(status).toContain('15-second data-connect timeout');
    expect(status).toContain('one accepted same-peer data\nsocket');
    expect(status).toContain('binds filesystem mutations to the entries selected');
    expect(sourceAudit).toContain('P-03 FTP filesystem-identity hardening');
    expect(sourceAudit).toContain('P-03 FTP `REST STREAM` conformance');
    expect(sourceAudit).toContain('P-03 FTP feature/rename-sequence conformance');
    expect(ftpFilesystemIdentityEvidence).toMatch(
      /exclusive UUID staging file directly below\s+the canonical File Grant root/u,
    );
    expect(ftpFilesystemIdentityEvidence).toContain('IR-04 remains **In progress**');
    expect(ftpFilesystemIdentityEvidence).toContain('different\nmounted filesystem fails safely');
    expect(ftpRestStreamEvidence).toContain('exact `FEAT` line');
    expect(ftpRestStreamEvidence).toContain('IR-04 remains **In progress**');
    expect(ftpRestStreamEvidence).toContain('path-based APIs');
    expect(ftpRestStreamEvidence).toContain(
      'Deterministic partial-write failure cleanup — 2026-09-23',
    );
    expect(ftpRestStreamEvidence).toContain('All six raw TCP regressions');
    expect(ftpRestStreamEvidence).toContain('Current packaged macOS FTP default-path regression');
    expect(ftpRestStreamEvidence).toContain(
      '339af8aa667f87d106d473d4c8e30b0fe50e1e5e671d3489fd11d6b82746875e',
    );
    expect(ftpRestStreamEvidence).toContain('17 macOS-applicable');
    expect(macosDmgEvidence).toContain('2026-09-23 current directory-app regression');
    expect(packagedSbomEvidence).toContain('Current macOS arm64 directory-app sidecar');
    expect(packagedSbomEvidence).toContain(
      '8a265b96757208767ab63adc3189c3444253bfadf134f50099ddbbadf1c5020a',
    );
    expect(macosDmgEvidence).toContain(
      '8a265b96757208767ab63adc3189c3444253bfadf134f50099ddbbadf1c5020a',
    );
    expect(macosDmgEvidence).toContain('2026-09-23 isolated current DMG installation');
    expect(macosDmgEvidence).toContain(
      '0952be8d4405412bd1bc9fcf494ee4c85564b5ae1020d5a5be537bd3a0598980',
    );
    expect(packagedSbomEvidence).toContain(
      '7fbe37e96b849ed9ed241ca6361ac87858777fa4e8b10cbc92e76f498ec05de2',
    );
    expect(status).toContain('A separate current unsigned\nDMG candidate');
    expect(ftpFeatureRenameEvidence).toContain('one-space-indented `MDTM` line');
    expect(ftpFeatureRenameEvidence).toContain('`RNFR` → `NOOP` → `RNTO`');
    expect(ftpFeatureRenameEvidence).toContain('IR-04 remains **In progress**');
    expect(ftpFeatureRenameEvidence).toContain(
      '60792bf2057c2e76a7be3ad12f03822b4086a0b4a6e2a6bd7f0fd6e68e56276e',
    );
    expect(externalTransferPeerAvailability).toContain('IR-03 remains **In progress**');
    expect(externalTransferPeerAvailability).toContain('Still-open-channel staging-path loss');
    expect(externalTransferPeerAvailability).toContain(
      'three focused files pass 34\ntests together',
    );
    expect(status).toContain('still-open-channel staging-namespace-loss');
    expect(macosDmgEvidence).toContain('IR-13 remains Open');
    expect(macosDmgEvidence).toContain(
      'e6cf5b448fa1c29405876330408d38fe8b423d116bfb2936f27674146831694c',
    );
    expect(macosDmgEvidence).toMatch(/passed 15 applicable\s+packaged Playwright journeys/u);
    expect(macosDmgEvidence).toContain('system `curl`');
    expect(macosDmgEvidence).toContain('PASV list/binary-upload/binary-download path');
    expect(macosDmgEvidence).toMatch(/an active\s+`--ftp-port -` byte-exact `STOR`\/`RETR` path/u);
    expect(status).toContain('e6cf5b448fa1c29405876330408d38fe8b423d116bfb2936f27674146831694c');
    expect(status).toContain('70ad8565f30ba7767c561a48182dbec83e07f1a3');
    expect(status).toContain('f2f1750bb210c262c96ae572d6be41e049d7bc9b');
    expect(status).toContain('f6e4aa4a2f63532128eb0f1b23645def6c477e42');
    expect(status).toMatch(/active\s+`--ftp-port -`\s+byte-exact `STOR`\/`RETR`/u);
    expect(macosDmgEvidence).toContain('iOS Simulator Runtime image');
    expect(linuxInstallAttempt).toContain(
      'Emulated Linux x64 DEB install gate passed; IR-13 remains Open',
    );
    expect(linuxInstallAttempt).toContain('748 files');
    expect(linuxInstallAttempt).toContain(
      '78729c8a949c223363dc71fcb43685b4fe729250993837b814b3f622d81c3dcc',
    );
    expect(linuxInstallAttempt).toContain('18 passed');
    expect(linuxInstallAttempt).toContain('7 skipped');
    expect(linuxInstallAttempt).toContain(
      'b265b30ba7ecb590a8dd58ab56b5e7400e5334b777f6d360418b6399d674943c',
    );
    expect(linuxInstallAttempt).toContain('not native Linux hardware');
    expect(linuxInstallAttempt).toContain('Current-source refresh — 2026-09-23');
    expect(linuxInstallAttempt).toContain('19 passed, 8 skipped, exit 0');
    expect(linuxInstallAttempt).toContain(
      '784940945bbf84708a19cbd395465c07564b3418ab1d4508a67bded277894479',
    );
    expect(linuxInstallAttempt).toContain('standard Linux `bun run check` remains unproven');
    expect(linuxInstallAttempt).toContain('test:appimage:linux');
    expect(linuxInstallAttempt).toContain(
      'SquashFS superblock was independently validated at byte',
    );
    expect(packaging).toContain('IR-13 Linux x64 installed-package evidence');
    expect(packaging).toMatch(/CI runs\s+this before artifact upload and again/u);
    expect(packaging).toContain('18f6391c5af758d07a636714d2d8f2d6ca7f4acc3b24b8b04185c69202bd8cd4');
    expect(packaging).toContain('5344b22216905c6e02e30d9ef6056389b0949b641f3ba60e0592b7c59b755a4d');
    expect(releaseOwnerHandoff).toContain('Linux x64 已安装包证据');
    expect(releaseOwnerHandoff).toContain('使用 `release:hashes:check` 重新核验实际制品字节');
    expect(releaseOwnerHandoff).toContain('AXTERM_UPLOAD_ROUNDTRIP.<platform>.json');
    expect(versions).toContain('primary npm registry on 2026-09-22');
    expect(versions).toContain('contains no stable `27.x` semver');
    expect(versions).toContain('--registry=https://registry.npmjs.org/');
    expect(status).toContain('IR-13 Linux installed-package evidence');
    expect(status).toContain('passed all 18\nLinux-applicable journeys');
    expect(ephemeralCandidate).toContain('Current post-Linux-fix ephemeral Git candidate');
    expect(ephemeralCandidate).toContain('current UI/AppImage-gate clean-clone candidate');
    expect(ephemeralCandidate).toContain('f6ac1f9b9d4d419c2ca62add88bea684394c8c24');
    expect(ephemeralCandidate).toContain('controlled OpenSSH in the same clean clone');
    expect(ephemeralCandidate).toContain('bun run candidate:ssh:check');
    expect(ephemeralCandidate).toContain('7ba6ecb6b67142a338f9822e88beb0f68d278a21');
    expect(status).toContain('The clean-clone gate now has an explicit Docker-backed variant');
    expect(ephemeralCandidate).toContain('bun run candidate:protocol:check');
    expect(ephemeralCandidate).toContain('6b39e328f00c92671425aef415fb68148d94f847');
    expect(ephemeralCandidate).toContain('16/16 Debian `lrzsz` cases');
    expect(ephemeralCandidate).toContain('7/7');
    expect(externalTransferPeerAvailability).toContain('Same-clone external-peer candidate');
    expect(externalTransferPeerAvailability).toContain('unchanged pinned SHA-256 check');
    expect(status).toContain('The opt-in `bun run candidate:protocol:check`');
    expect(workflow).toContain('Prepare pinned independent transfer peers');
    expect(workflow).toContain('Test independent lrzsz over SSH PTY');
    expect(workflow).toContain('Test independent trzsz-go over SSH PTY');
    expect(workflow).toContain('AXTERM_EXTERNAL_LRZSZ_DEB: ${{ runner.temp }}');
    expect(externalTransferPeerAvailability).toContain('Linux CI peer-gate preparation');
    expect(externalTransferPeerAvailability).toContain('not yet a remote CI result');
    expect(status).toContain('this edited workflow has **not** run on GitHub Actions');
    expect(packagedOpenSsh).toContain('current-source directory-app revalidation');
    expect(packagedOpenSsh).toContain(
      '70da8c8f466c9e691cb0324f488d6b37acc6759f4bdb45279d2a9c0fd77862a1',
    );
    expect(ephemeralCandidate).toContain(
      '672c279d34f5656f3e3106adac21235909c802cfa9160627c68c284d4362ff81',
    );
    expect(ephemeralCandidate).toContain('947 tests with 33 skips');
    expect(ephemeralCandidate).toContain('Current post-install artifact-integrity candidate');
    expect(ephemeralCandidate).toContain(
      '5155e617df187b638b2ddc556d5644f05f0c770056e87cebdd75b0125e7e350e',
    );
    expect(ephemeralCandidate).toContain('950 tests with 33 skips');
    expect(ephemeralCandidate).toContain('Current uploaded-artifact round-trip candidate');
    expect(ephemeralCandidate).toContain(
      'fd3de0afa692e3b5cdb7e10f099fcc113cabd6f94528fb439988b6e7f98131dc',
    );
    expect(ephemeralCandidate).toContain('952 tests with 33 skips');
    expect(ephemeralCandidate).toContain('Current still-open-channel staging-loss candidate');
    expect(ephemeralCandidate).toContain(
      'afaba883048e1bbf47743b98afdc8bfd34a94833d4e55a0e5df4ffe06bfa579a',
    );
    expect(ephemeralCandidate).toContain('955 tests with 33 skips');
    expect(sourceAudit).toContain('current post-Linux-fix ephemeral Git candidate');
    expect(sourceAudit).toContain('current post-install artifact-integrity candidate');
    expect(sourceAudit).toContain('current uploaded-artifact round-trip candidate');
    expect(sourceAudit).toContain('current P-02 still-open-channel staging-loss candidate');
    expect(status).toContain('9db88a7e7245b671299256141c5f1f1698c9e492');
    expect(status).toContain('f39df5eb10e983747c5dc10f34a2e14360d62b55');
    expect(linuxFtpEvidence).toContain('linux-arm64-ftp-pasv-lifecycle-smoke=pass bytes=8196');
    expect(linuxFtpEvidence).toContain('linux-x64-ftp-pasv-lifecycle-smoke=pass bytes=8196');
    expect(linuxFtpEvidence).toContain('PASV lifecycle regressions');
    expect(linuxFtpEvidence).toContain('Four simultaneous same-peer connections');
    expect(linuxFtpEvidence).toContain(
      'sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6',
    );
    expect(linuxFtpEvidence).toContain('not an Electron package build, installed');
    expect(linuxFtpEvidence).toMatch(/P-03\/IR-04 remains\s+\*\*In progress\*\*/u);
    expect(visualBaseline).toContain('data-migration migration-notice refresh');
    expect(visualBaseline).toContain('sync-migration keyboard and 200% zoom regression');
    expect(visualBaseline).toContain('Host-editor redesign and packaged guard');
    expect(visualBaseline).toContain('axterm-host-dialog-1280x800-visual-darwin.png');
    expect(visualBaseline).toContain('connection-configuration copy and layout decoupling');
    expect(visualBaseline).toContain('axterm-connection-profiles-1280x800-visual-darwin.png');
    expect(visualBaseline).toContain('phase12-connection-configuration.png');
    expect(visualBaseline).toContain('shared protocol-editor redesign and packaged guard');
    expect(visualBaseline).toContain('axterm-rdp-dialog-1280x800-visual-darwin.png');
    expect(visualBaseline).toContain('phase12-rdp-dialog.png');
    expect(visualBaseline).toContain(
      '119152a22da8ac994f59f68967e2b26a5979771b4858718f37f1e19422f69f58',
    );
    expect(visualBaseline).toContain(
      '71737e0db4380139d06bdc15fcf0a6696c55ac700190430b70e4412dff0d6297',
    );
    expect(sourceAudit).toContain('P-07 current Host-dialog decoupling');
    expect(sourceAudit).toContain('P-04/P-07 current connection-configuration decoupling');
    expect(sourceAudit).toContain('P-07 current shared protocol-editor decoupling');
    expect(sourceAudit).toContain('P-04/P-07 current SSH-interaction decoupling');
    expect(sourceAudit).toContain('P-08 current P-07 Host-dialog candidate');
    expect(sourceAudit).toContain('P-08 current P-04/P-07 connection-configuration candidate');
    expect(sourceAudit).toContain('P-08 current P-07 shared protocol-editor candidate');
    expect(sourceAudit).toContain('P-08 current P-04/P-07 packaged SSH-interaction candidate');
    expect(sourceAudit).toContain('P-08 current P-06 historical-source upgrade candidate');
    expect(sourceAudit).toContain('Current historical remote-recovery upgrade candidate');
    expect(status).toContain('Axterm-owned Add SSH host dialog');
    expect(status).toContain('high-density connection-configuration');
    expect(status).toContain('all seven non-SSH bookmark editors');
    expect(status).toContain('SSH Host Key and keyboard-interactive presentation');
    expect(status).toContain('session-launch surface');
    expect(status).toContain('exactly 44 live keys');
    expect(status).toContain('93d0711fff4ac89a5d5c641872dbb5e6c2c123c9');
    expect(ephemeralCandidate).toContain('Current P-07 Host-dialog decoupling candidate');
    expect(ephemeralCandidate).toContain(
      'Current P-04/P-07 connection-configuration decoupling candidate',
    );
    expect(ephemeralCandidate).toContain(
      'Current P-07 shared protocol-editor decoupling candidate',
    );
    expect(ephemeralCandidate).toContain(
      'Current P-04/P-07 SSH-interaction localization candidate',
    );
    expect(ephemeralCandidate).toContain('Current P-04/P-07 packaged SSH Host Key candidate');
    expect(ephemeralCandidate).toContain('Current P-07 session-launch empty-state candidate');
    expect(ephemeralCandidate).toContain(
      'Current P-06 historical-source package upgrade candidate',
    );
    expect(ephemeralCandidate).toContain('Current P-05/P-06 historical-theme upgrade candidate');
    expect(ephemeralCandidate).toContain(
      '592215ff4b82ba2de70dcd27770af7b0f3c9d4fbc4564e69160565ca1e5681d1',
    );
    expect(ephemeralCandidate).toContain('91eab559af98e081728edcbf1e3ac5d8abc6263d');
    expect(ephemeralCandidate).toContain(
      'Current P-05/P-06 historical-theme and sync-profile upgrade candidate',
    );
    expect(ephemeralCandidate).toContain(
      '53a12a7c5f32d30fbc96523a36c4080b8722c7de4030e673ed8a0d2f0d2f23ae',
    );
    expect(ephemeralCandidate).toContain('026414392ac3153d2ed1bac439fd49c527ea0867');
    expect(ephemeralCandidate).toContain(
      'Current P-06 historical encrypted/plaintext remote-recovery candidate',
    );
    expect(ephemeralCandidate).toContain(
      '96be2ab858eb7fe11a79a04493d9f2b6c0926b44de4d8f577866fe93f823af09',
    );
    expect(ephemeralCandidate).toContain('efc4dd142932e7cc9380b35ce86b7ba038438cfe');
    expect(ephemeralCandidate).toContain(
      'aa03b105fc33f3769d80d9807564a64f6b675debcb6b1f5d0e38d74ffadf740b',
    );
    expect(ephemeralCandidate).toContain('cbb370612683a48acc0427b44705e0a251089a64');
    expect(ephemeralCandidate).toContain(
      '10a9fbc16be11716790bb2049ef0aa30ed686fd6d95a4927550aed1d3fe45565',
    );
    expect(ephemeralCandidate).toContain(
      '6c62c3fcde2738b46ab5e2292d9c672bd4cb7f75ac5ae8492b84c28b33163664',
    );
    expect(ephemeralCandidate).toContain(
      '527eadd01cf6337e1a9ad540fcf91cb223f3e74317ab34f2cab4875aae741c28',
    );
    expect(ephemeralCandidate).toContain(
      'e376c562c8e1ee4e1cd5a0d848f422455b7543e495aef108b9732ed715a56647',
    );
    expect(ephemeralCandidate).toContain(
      'a3d4797dbaf69eafa57d3ee5270704228569175410162d66e6b0b6e386f3cf4c',
    );
    expect(ephemeralCandidate).toContain(
      '4c34d34b63671063dd42688b2a6957f9a15a520d94457619bb89a2676acb4afb',
    );
    expect(visualBaseline).toContain('session-launch empty-state redesign and packaged guard');
    expect(visualBaseline).toContain('data-migration settings-option alignment');
    expect(visualBaseline).toContain(
      '4247cba9fa99097825b9429d4ff6d303b634be24b8d6dacfd4741d04066b98dc',
    );
    expect(visualBaseline).toContain('axterm-empty-pane-*');
    expect(visualBaseline).toContain('phase12-empty-pane.png');
    expect(visualBaseline).toContain(
      '865d62709fb3599631a86cbadceb871f37ee4d201c22829ea54803cf6b503a81',
    );
    expect(sourceAudit).toContain('P-07 current session-launch empty-state decoupling');
    expect(sourceAudit).toContain('P-08 current P-07 session-launch candidate');
    expect(visualBaseline).toContain('Home/End move to the first/last enabled tab');
    expect(visualBaseline).toContain(
      '7267283751bb21f396b3ac931c55b6d1906bd27a8c339b01216d071ae91e2d51',
    );
    expect(visualBaseline).toContain('not a product/design, trademark, accessibility');
    expect(assetReviewLedger).toContain('declared first-party product-mark assets');
    expect(assetReviewLedger).toContain('not a copyright, trademark, license, authorship');
    expect(assetProvenance).toContain('assets:marks:reviewed-check');
    expect(releaseOwnerHandoff).toContain('不构成任何 IR 项的验收或发布批准');
    expect(releaseOwnerHandoff).toContain('无需虚构公开日期');
    expect(releaseOwnerHandoff).not.toContain('至少 90 天且至少跨过一个稳定版本');
    expect(releaseOwnerHandoff).toContain('不得 mirror-push 旧历史');
    expect(releaseOwnerHandoff).toContain('IR-14` 仍是 **Open**');
    expect(releaseOwnerHandoff).toContain('assets:marks:reviewed-check');
    expect(releaseOwnerHandoff).toContain('locales:core:reviewed-check');
    expect(releaseOwnerHandoff).toContain('snapshot:final-public:check');
    expect(releaseOwnerHandoff).toContain('release:final-public:check');
    expect(releaseOwnerHandoff).toContain('不会因第一项失败而隐藏后续待办');
    expect(cleanupPlan).toContain('snapshot:final-public:check');
    expect(cleanupPlan).toContain('release:final-public:check');
    expect(cleanupPlan).toContain('在一次执行中运行并汇总全部前置门禁');
    expect(sourceAudit).toContain('snapshot:final-public:check');
    expect(rootPackage.scripts['release:final-public:check']).toBe(
      'node scripts/commercialization/check-final-public-release.mjs',
    );
    expect(rootPackage.scripts['licenses:attribution:reviewed-check']).toBe(
      'node scripts/commercialization/license-attribution-review-ledger.mjs --reviewed-check',
    );
    expect(finalSnapshotExceptionGuide).toContain('ADR-021 cancelled the public migration window');
    expect(finalSnapshotExceptionGuide).not.toContain(
      'only after the public migration window has ended',
    );
    expect(finalSnapshotExceptionGuide).toContain('release:final-public:check');
    expect(finalSnapshotExceptionGuide).toContain('independent authorship');
    expect(JSON.parse(finalSnapshotExceptionTemplate)).toMatchObject({
      schemaVersion: 1,
      exceptions: [],
    });
    expect(localizationScopeAudit).toContain('2,574');
    expect(localizationScopeAudit).toContain(
      'English, Japanese, Simplified Chinese and Traditional Chinese',
    );
    expect(localizationScopeAudit).toContain('`en`, `ja`, `zh-CN` and `zh-TW`');
    expect(localizationScopeAudit).toContain('are not independently selectable locales');
    expect(localizationScopeAudit).toContain('2,574 AI-assisted');
    expect(localizationScopeAudit).toContain('keyboard-shortcut configuration surface');
    expect(localizationScopeAudit).toContain('remote-monitor bar and detail');
    expect(localizationScopeAudit).toContain('terminal-information panel');
    expect(localizationScopeAudit).toContain('terminal-interaction and');
    expect(localizationScopeAudit).toContain('batch-input and 16-key command-line');
    expect(localizationScopeAudit).toContain('31-key bookmark-tree');
    expect(localizationScopeAudit).toContain('33-key file-comparison');
    expect(localizationScopeAudit).toContain('33-key command-history');
    expect(localizationScopeAudit).toContain('34-key bookmark-trigger');
    expect(localizationScopeAudit).toContain('17-key external');
    expect(localizationScopeAudit).toMatch(/26-key\s+remote-text-editor/u);
    expect(localizationScopeAudit).toContain('29-key SSH-tunnel');
    expect(localizationScopeAudit).toContain('25-key session-startup');
    expect(localizationScopeAudit).toMatch(/15-key\s+connection-\s+hopping/u);
    expect(localizationScopeAudit).toContain('complete AI-assisted drafts');
    expect(localizationScopeAudit).toContain('13-key legal-and-license');
    expect(localizationScopeAudit).toContain('27-key Web-session');
    expect(localizationFallbackPolicy).toContain('four selectable application languages');
    expect(localizationFallbackPolicy).toContain('locales:core:reviewed-check');
    expect(coreReviewLedger).toContain('"catalog": "core"');
    expect(coreReviewLedger).toContain('"keyCount": 2615');
    expect(coreReviewLedger).toContain('"status": "complete"');
    expect(coreReviewLedger).toContain('"translatedKeyCount": 2615');
    expect(releaseOwnerHandoff).toContain('MIGRATION_RELEASE_RECORD.json');
    expect(releaseOwnerHandoff).toContain('migration:record:active-check');
    expect(releaseOwnerHandoff).toContain('migration:record:removal-check');
    expect(releaseOwnerHandoff).toContain('RELEASE_SERVICE_RECORD.json');
    expect(releaseOwnerHandoff).toContain('release:services:active-check');
    expect(JSON.parse(migrationReleaseRecord)).toMatchObject({
      schemaVersion: 2,
      status: 'immediate-removal-approved',
      publicMigrationRelease: null,
      approvedWindow: null,
      support: null,
      removalApproval: null,
      immediateRemovalApproval: {
        priorPublicDistribution: false,
        localDataPolicy: 'preserve-inert',
        remoteDataPolicy: 'preserve',
      },
    });
    expect(JSON.parse(releaseServiceRecord)).toMatchObject({
      schemaVersion: 1,
      status: 'pending',
      privacyAndDataHandling: null,
      securityReporting: null,
      supportPolicy: null,
    });
    expect(privacy).toContain('not a public commercial privacy notice or legal approval');
    expect(privacy).toContain('release:services:active-check');
    expect(security).toContain('no approved public security-reporting');
    expect(security).toContain('does not invent an email address');
    expect(support).toContain('no public commercial support commitment');
    expect(support).toContain('release:services:active-check');
    expect(workflow.indexOf('bun run snapshot:check')).toBeLessThan(
      workflow.indexOf('bun install --frozen-lockfile'),
    );
    expect(workflow).toContain('name: packaged-installers-${{ matrix.os }}');
    for (const pattern of ['release/*.dmg', 'release/*.exe', 'release/*.AppImage', 'release/*.deb'])
      expect(workflow).toContain(pattern);
    expect(workflow).toContain('name: packaged-sbom-${{ matrix.os }}');
    expect(workflow).toContain('bun run release:hashes -- release --platform macos-arm64');
    expect(workflow).toContain('bun run release:hashes:check -- release --platform macos-arm64');
    expect(workflow).toContain('name: packaged-artifact-hashes-${{ matrix.os }}');
    expect(workflow).toContain(
      'bun run release:hashes:check -- downloaded-release --platform macos-arm64',
    );
    expect(workflow).toContain('name: packaged-upload-roundtrip-${{ matrix.os }}');
    expect(workflow).toContain('run: bun run test:deb:linux');
    expect(workflow).toContain('run: bun run test:nsis:windows');
    expect(packaging).toContain('rather than treating `linux-unpacked` or `win-unpacked`');
    expect(packaging).toContain('closes the build-to-upload mutation gap');
    expect(packaging).toContain('AXTERM_UPLOAD_ROUNDTRIP.<platform>.json');
    expect(packaging).toContain('AXTERM_SPDX_UPLOAD_ROUNDTRIP.<platform>.json');
    expect(packaging).toMatch(/verify a public\s+Release\/CDN download/u);
    expect(status).toContain('still the same bytes after installed-app\ntesting');
    expect(status).toContain('closes the next workflow-defined transport gap');
    expect(migrationCoverage).toContain('APT-installed emulated Linux x64 package');

    const uiSection = masterSpec.slice(
      masterSpec.indexOf('# 36. UI / UX'),
      masterSpec.indexOf('# 37. UI State Ownership'),
    );
    const currentObjectiveSection = masterSpec.slice(
      masterSpec.indexOf('## 0.1 当前交付目标'),
      masterSpec.indexOf('## 0.2 目标、实现与状态的职责边界'),
    );
    const sourceInventorySection = sourceAudit.slice(
      sourceAudit.indexOf('## Direct source/data inventory'),
      sourceAudit.indexOf('## Compatibility, build and release exposure'),
    );
    expect(uiSection).toContain('Historical first-version context');
    expect(uiSection).toContain('independent-release matrix');
    expect(currentObjectiveSection).toContain('简体中文、繁体中文、英文和日文四种语言');
    expect(currentObjectiveSection).not.toContain('15 种\n语言能力继续保留');
    expect(sourceInventorySection).toContain(
      'Independently sourced and reviewed translations for the four retained languages',
    );
    expect(sourceInventorySection).not.toContain('translations for all 15 languages');
    expect(masterSpec).toContain('## Historical Legacy Prototype parity release gate');
  });
});

describe('current release-owner handoff', () => {
  it('uses the active core-review scope and latest installed Linux candidate, not older evidence', () => {
    const handoff = document('docs/implementation/RELEASE_OWNER_HANDOFF.md');
    const packaging = document('docs/implementation/PACKAGING.md');
    const matrix = document('docs/implementation/INDEPENDENT_RELEASE_MATRIX.md');
    const coreLedger = JSON.parse(
      document('scripts/localization/axterm-core-review-ledger.json'),
    ) as { scope: { keyCount: number } };
    const linuxEvidence = document(
      'docs/implementation/evidence/IR04-FTP-READ-HANDLE-LINUX-DEB-2026-09-24.md',
    );
    const appImageEvidence = document(
      'docs/implementation/evidence/IR13-LINUX-X64-APPIMAGE-READ-HANDLE-2026-09-24.md',
    );
    const latestDebSha256 = '46b367054ef986c4b00e548766799ad7927deba7bc20bd0ae76b713634ec51cb';

    expect(handoff).toContain(`${coreLedger.scope.keyCount.toLocaleString('en-US')} 键核心文案`);
    expect(handoff).toContain('23 项适用旅程');
    expect(handoff).toContain('IR04-FTP-READ-HANDLE-LINUX-DEB-2026-09-24.md');
    expect(handoff).toContain('IR13-LINUX-X64-APPIMAGE-READ-HANDLE-2026-09-24.md');
    expect(matrix).toContain('IR13-LINUX-X64-APPIMAGE-READ-HANDLE-2026-09-24.md');
    expect(packaging).toContain('Latest emulated-x64 DEB install: 23 applicable journeys pass');
    expect(packaging).toContain('same audited source snapshot');
    expect(packaging).toContain('IR13-LINUX-X64-APPIMAGE-READ-HANDLE-2026-09-24.md');
    expect(packaging).toContain(latestDebSha256);
    expect(linuxEvidence).toContain(latestDebSha256);
    expect(linuxEvidence).toContain('passed **23 applicable journeys**');
    expect(appImageEvidence).toContain(
      'a5a0b35309e79f1910a92bfd53ec2866b2631ef77969eee1c84fdd2554dcc47d',
    );
    expect(appImageEvidence).toMatch(/ELF file ABI version\s+invalid/u);
  });

  it('points macOS distribution claims to the latest installed DMG bytes', () => {
    const matrix = document('docs/implementation/INDEPENDENT_RELEASE_MATRIX.md');
    const status = document('docs/implementation/STATUS.md');
    const packaging = document('docs/implementation/PACKAGING.md');
    const latestRecord = document(
      'docs/implementation/evidence/IR03-MACOS-ARM64-NATIVE-PUBLICATION-2026-09-24.md',
    );
    const previousRecord = document(
      'docs/implementation/evidence/IR13-MACOS-DMG-UPDATE-FEED-2026-09-24.md',
    );
    const latestDmgSha256 = 'c79b573a90c5ecebe4d269e921f2cb999d450e526915da87fa2a58b3c01e51ab';

    expect(matrix).toContain('IR03-MACOS-ARM64-NATIVE-PUBLICATION-2026-09-24.md');
    expect(status).toContain('IR03-MACOS-ARM64-NATIVE-PUBLICATION-2026-09-24.md');
    expect(packaging).toContain(latestDmgSha256);
    expect(latestRecord).toContain(latestDmgSha256);
    expect(latestRecord).toContain('21 applicable');
    expect(latestRecord).toContain('MS-DOS FAT16');
    expect(latestRecord).toContain('ENOTSUP');
    expect(latestRecord).toContain('All **3/3** passed');
    expect(latestRecord).toContain('passed **1/1**');
    expect(previousRecord).toContain(
      'fd8fe0c5dd4dcdca881d8fde2c321a4fdfb2da10a7a56cd3ba83514bf343c5f9',
    );
  });
});
