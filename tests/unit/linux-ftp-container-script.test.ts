import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = readFileSync(resolve('scripts/test-linux-ftp-widget-container.sh'), 'utf8');
const smoke = readFileSync(resolve('scripts/test-linux-ftp-widget-container.mjs'), 'utf8');
const packageManifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('Linux FTP Widget container smoke', () => {
  it('keeps the optional source smoke isolated from the host and external network', () => {
    expect(packageManifest.scripts['test:ftp:linux-container']).toBe(
      'sh scripts/test-linux-ftp-widget-container.sh',
    );
    expect(script).toContain('--read-only');
    expect(script).toContain('--network none');
    expect(script).toContain('--security-opt no-new-privileges');
    expect(script).toContain(
      'node:24.18.0-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd',
    );
    expect(script).toContain('--entrypoint node');
    expect(script).toContain('--mount "type=bind,src=$source_root,dst=/workspace,readonly"');
    expect(script).toContain('--tmpfs /tmp:rw,nosuid,nodev,size=64m');
    expect(script).toContain('AXTERM_LINUX_FTP_TEST_PLATFORM');
    expect(script).toContain('linux/amd64');
    expect(script).toContain('AXTERM_LINUX_FTP_EXPECT_ARCH');
    expect(smoke).toContain('NodeLocalFtpServer');
    expect(smoke).toContain('Linux FTP Widget container architecture mismatch');
    expect(smoke).toContain('passivePortStart: 50_360');
    expect(smoke).toContain("password: 'wrong-password'");
    expect(smoke).toContain('assertPendingPassiveAbort');
    expect(smoke).toContain('assertSinglePassivePeer');
    expect(smoke).toContain('await assertReadAncestorSwap()');
    expect(smoke).toContain('new NodeLocalFtpServer(undefined, undefined, readOpener)');
    expect(smoke).toContain('linux-${process.arch}-ftp-read-ancestor-swap-denial=pass');
    expect(smoke).toContain('PASV retained more than one same-peer data socket.');
    expect(smoke).toContain("client.rename('rename-stage.txt', 'listed.txt')");
    expect(smoke).toContain("client.rename('link-stage.txt', 'file-link')");
    expect(smoke).toContain('linux-${process.arch}-ftp-rename-overwrite=pass');
    expect(smoke).toContain('linux-${process.arch}-ftp-pasv-lifecycle-smoke=pass');
  });
});
