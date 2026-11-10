import type { Context } from '@deepseek-ai/cordis';
import type { RemoteResult } from '@axterm/plugin-api';
import type {
  CredentialCommandReceipt,
  CreateGrantedCredentialInput,
  SavedCredentialsUpdate,
} from '@axterm/plugin-api/saved-credentials';
import {
  RemoteStream,
  type RemoteStreamOptions,
} from '../../packages/infra/gateway/src/client/remote-stream.ts';
import { SavedCredentialsModel } from '../../packages/plugins/configuration/src/client/credentials.ts';
import { expect, it, vi } from 'vitest';
function fixture() {
  const generation = crypto.randomUUID();
  const imported = vi.fn(
    async (
      _id: string,
      _generation: string,
      _input: CreateGrantedCredentialInput,
      _signal: AbortSignal,
    ): Promise<RemoteResult<CredentialCommandReceipt>> => {
      throw new Error('Lost grant ACK');
    },
  );
  const outcome = vi.fn(async (id: string): Promise<RemoteResult<CredentialCommandReceipt>> => ({
    ok: true,
    value: {
      commandId: id,
      generation,
      operation: 'create',
      ref: 'cred_' + crypto.randomUUID(),
      status: 'failed',
      reason: 'invalid-input',
    },
  }));
  const ctx = {
    remote: {
      $stream: (options: RemoteStreamOptions<SavedCredentialsUpdate>) =>
        new RemoteStream(
          { generation: { getSnapshot: () => undefined, subscribe: () => () => {} } },
          options,
        ),
      configuration: {
        watchCredentials: async function* (signal: AbortSignal) {
          yield {
            type: 'begin',
            mode: 'baseline',
            generation,
            cursor: 0,
          } as SavedCredentialsUpdate;
          const text = JSON.stringify({ credentials: [] });
          yield { type: 'chunk', offset: 0, text, final: true } as SavedCredentialsUpdate;
          yield { type: 'commit', cursor: 0 } as SavedCredentialsUpdate;
          await new Promise<void>((done) => {
            signal.addEventListener('abort', () => done(), { once: true });
            if (signal.aborted) done();
          });
        },
        importCredentialFromGrant: imported,
        getCredentialOutcome: outcome,
      },
    },
  } as unknown as Context;
  return { model: new SavedCredentialsModel(ctx), generation, imported, outcome };
}
it('returns captured command/generation for a lost granted-file ACK and only queries the outcome without repeating the read request', async () => {
  const f = fixture();
  try {
    await expect.poll(() => f.model.getSnapshot().status).toBe('ready');
    const input = { kind: 'privateKey' as const, label: 'Selected key', grantId: 'selected-grant' };
    const submitted = f.model.createFromGrant(input);
    input.grantId = 'changed-after-admission';
    await expect(submitted.result).rejects.toThrow('Lost grant ACK');
    expect(submitted.generation).toBe(f.generation);
    expect(f.imported).toHaveBeenCalledExactlyOnceWith(
      submitted.commandId,
      f.generation,
      { kind: 'privateKey', label: 'Selected key', grantId: 'selected-grant' },
      expect.any(AbortSignal),
    );
    expect((await f.model.outcome(submitted.commandId)).commandId).toBe(submitted.commandId);
    expect(f.imported).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.model.getSnapshot())).not.toContain('selected-grant');
  } finally {
    await f.model.dispose();
  }
});
it('aborts in-flight source reads on model disposal and never admits a new command afterwards', async () => {
  const f = fixture();
  let drained = false;
  f.imported.mockImplementation(async (_id, _gen, _input, signal) => {
    await new Promise<void>((done) => {
      signal.addEventListener('abort', () => done(), { once: true });
      if (signal.aborted) done();
    });
    await new Promise((done) => setTimeout(done, 25));
    drained = true;
    throw new Error('Stopped source wait');
  });
  await expect.poll(() => f.model.getSnapshot().status).toBe('ready');
  const submitted = f.model.createFromGrant({
    kind: 'sshCertificate',
    label: 'Certificate',
    grantId: 'selected-grant',
  });
  void submitted.result.catch(() => {});
  await f.model.dispose();
  expect(drained).toBe(true);
  expect(() =>
    f.model.createFromGrant({ kind: 'privateKey', label: 'Closed', grantId: 'opaque' }),
  ).toThrow('CREDENTIALS_CLOSED');
  expect(f.imported).toHaveBeenCalledTimes(1);
});
