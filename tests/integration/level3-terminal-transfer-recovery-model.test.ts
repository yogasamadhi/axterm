import { expect, it, vi } from 'vitest';
import type { TerminalsModel } from '../../packages/plugins/terminals/src/client/index.ts';
import { TerminalRecoveryModel } from '../../packages/plugins/terminals/src/client/transfer-recovery.ts';
const generation = crypto.randomUUID(),
  record = {
    id: crypto.randomUUID(),
    protocol: 'xmodem' as const,
    name: 'Interrupted',
    createdAt: 0,
    bytes: 12,
    state: 'verified' as const,
  };
function fixture() {
  let gen = generation;
  const model = {
    getSnapshot: () => ({ status: 'ready', baseline: { generation: gen } }),
    reviewTransferRecovery: vi.fn(async () => [record]),
    changeTransferRecovery: vi.fn(async () => []),
  } as unknown as TerminalsModel;
  return {
    model,
    recovery: new TerminalRecoveryModel(model, generation, 'fresh-grant'),
    replace: () => {
      gen = crypto.randomUUID();
    },
  };
}
it('publishes only complete bounded recovery metadata and replaces accepted results after an explicit command', async () => {
  const f = fixture();
  await f.recovery.load();
  expect(f.recovery.getSnapshot()).toMatchObject({ status: 'ready', records: [record] });
  await f.recovery.change(record.id, 'remove');
  expect(f.recovery.getSnapshot()).toMatchObject({ status: 'ready', records: [] });
  await f.recovery.close();
});
it('reports failed or over-limit reads without fabricating an empty accepted baseline and can reload', async () => {
  const f = fixture();
  vi.mocked(f.model.reviewTransferRecovery).mockRejectedValueOnce(Error('OFFLINE'));
  await expect(f.recovery.load()).rejects.toThrow();
  expect(f.recovery.getSnapshot().status).toBe('error');
  await f.recovery.retry();
  expect(f.recovery.getSnapshot()).toMatchObject({ status: 'ready', records: [record] });
  vi.mocked(f.model.reviewTransferRecovery).mockResolvedValue(
    Array.from({ length: 65 }, () => record),
  );
  await expect(f.recovery.load()).rejects.toThrow();
  expect(f.recovery.getSnapshot().status).toBe('error');
  await f.recovery.close();
});
it('retains uncertain removal and explicitly retries the same key before allowing scope close', async () => {
  const f = fixture();
  await f.recovery.load();
  vi.mocked(f.model.changeTransferRecovery)
    .mockRejectedValueOnce(Error('LOST_ACK'))
    .mockResolvedValue([]);
  await expect(f.recovery.change(record.id, 'remove')).rejects.toThrow();
  await expect(f.recovery.close()).rejects.toThrow('UNCERTAIN');
  const first = vi.mocked(f.model.changeTransferRecovery).mock.calls[0]!;
  await f.recovery.retry();
  expect(vi.mocked(f.model.changeTransferRecovery).mock.calls[1]!.slice(0, 4)).toEqual(
    first.slice(0, 4),
  );
  await f.recovery.close();
});
it('retires old-generation authority and pending intent without sending commands to the replacement Host', async () => {
  const f = fixture();
  await f.recovery.load();
  vi.mocked(f.model.changeTransferRecovery).mockRejectedValueOnce(Error('LOST_ACK'));
  await expect(f.recovery.change(record.id, 'forget')).rejects.toThrow();
  f.replace();
  await f.recovery.close();
  await expect(f.recovery.retry()).rejects.toThrow('RETIRED');
  expect(f.model.changeTransferRecovery).toHaveBeenCalledOnce();
});
