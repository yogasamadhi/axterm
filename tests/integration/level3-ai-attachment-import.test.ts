import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { createManagedImportFixture } from '../support/level3-managed-import-fixture.ts';
import { AiHostCapabilities } from '../../packages/plugins/ai/src/adapters/host-capabilities.ts';
it('reads the bounded AI attachment prefix through an actual imported-file lease and drains its stream before revocation', async () => {
  const f = await createManagedImportFixture();
  f.ctx.provide('files', f.files);
  let host!: AiHostCapabilities;
  await f.ctx.plugin({
    inject: ['files'],
    apply(scope) {
      host = new AiHostCapabilities(scope);
    },
  });
  try {
    const value = 'Visible imported attachment';
    const provisional = await f.ctx.fileImports.prepare(
      { name: 'attachment.txt', size: Buffer.byteLength(value), editable: false },
      new AbortController().signal,
    );
    const lease = await f.files.open(provisional.grantId, 'write');
    await lease.write(lease.path, Readable.from([value]), { overwrite: true });
    await lease.close();
    const grant = await f.ctx.fileImports.commit(provisional.grantId, new AbortController().signal);
    const result = await host.readGrantedTextPrefix(
      grant.grantId,
      50 * 1024,
      100 * 1024,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      name: 'attachment.txt',
      content: value,
      size: Buffer.byteLength(value),
      truncated: false,
    });
    await host.revokeGrant(grant.grantId);
    expect(f.files.resourceCount()).toBe(0);
    await host.close();
  } finally {
    await host.close().catch(() => {});
    await f.close();
  }
});
