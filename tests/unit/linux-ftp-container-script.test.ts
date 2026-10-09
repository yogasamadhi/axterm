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
      'oven/bun@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6',
    );
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
