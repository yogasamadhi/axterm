import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { SavedCredentialsProjection } from '../../packages/plugins/configuration/src/client/credential-projection.ts';
import { CredentialSnapshotObservation } from '../../packages/plugins/configuration/src/credential-observation.ts';
import {
  SavedCredentialStorageError,
  type SavedCredentialMetadata,
} from '@axterm/plugin-api/saved-credentials';
const row = (): SavedCredentialMetadata => ({
  ref: 'cred_' + randomUUID(),
  kind: 'aiApiKey',
  label: 'Model key',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  storage: 'local',
});
it('publishes complete metadata baselines, replaces atomically, and resets across generations', () => {
  const projection = new SavedCredentialsProjection();
  const generation = randomUUID();
  const value = row();
  expect(
    projection.accept({ type: 'begin', mode: 'baseline', generation, cursor: 0 }),
  ).toBeUndefined();
  const text = JSON.stringify({ credentials: [value] });
  expect(projection.accept({ type: 'chunk', offset: 0, text, final: true })).toBeUndefined();
  const baseline = projection.accept({ type: 'commit', cursor: 0 });
  expect(baseline?.credentials).toEqual([value]);
  expect(Object.isFrozen(baseline?.credentials[0])).toBe(true);
  projection.accept({ type: 'begin', mode: 'replace', generation, cursor: 1 });
  projection.accept({ type: 'chunk', offset: 0, text: '{"credentials":[]}', final: true });
  expect(projection.accept({ type: 'commit', cursor: 1 })?.credentials).toEqual([]);
  projection.reset();
  expect(() =>
    projection.accept({ type: 'begin', mode: 'replace', generation, cursor: 2 }),
  ).toThrow();
});
it('rejects secret-bearing fields, duplicates, wrong ordering and incomplete frames', () => {
  for (const credentials of [
    [{ ...row(), secret: 'SECRET' }],
    (() => {
      const value = row();
      return [value, value];
    })(),
  ]) {
    const projection = new SavedCredentialsProjection();
    projection.accept({ type: 'begin', mode: 'baseline', generation: randomUUID(), cursor: 0 });
    projection.accept({
      type: 'chunk',
      offset: 0,
      text: JSON.stringify({ credentials }),
      final: true,
    });
    expect(() => projection.accept({ type: 'commit', cursor: 0 })).toThrow();
  }
  const projection = new SavedCredentialsProjection();
  expect(() => projection.accept({ type: 'commit', cursor: 0 })).toThrow();
  projection.accept({ type: 'begin', mode: 'baseline', generation: randomUUID(), cursor: 0 });
  expect(() => projection.accept({ type: 'chunk', offset: 1, text: '{}', final: true })).toThrow();
});
it('coalesces metadata reads and awaits an in-flight read during unload', async () => {
  const gate = Promise.withResolvers<void>();
  let reads = 0;
  const observation = new CredentialSnapshotObservation(randomUUID(), async () => {
    reads++;
    await gate.promise;
    return { credentials: [row()] };
  });
  const first = observation.watch(new AbortController().signal);
  const second = observation.watch(new AbortController().signal);
  const a = first.next();
  const b = second.next();
  let closed = false;
  const ending = observation.dispose().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(reads).toBe(1);
  gate.resolve();
  await ending;
  expect((await a).done).toBe(true);
  expect((await b).done).toBe(true);
});
it('contains runtime-invalid provider error codes', () => {
  const failure = new SavedCredentialStorageError('SECRET' as 'unavailable');
  expect(failure.code).toBe('unavailable');
  expect(failure.message).not.toContain('SECRET');
});

it('continues observing committed metadata after the system wall clock moves backwards', async () => {
  let value = 'before';
  const observation = new CredentialSnapshotObservation(randomUUID(), async () => ({ value }));
  const stream = observation.watch(new AbortController().signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    expect((await stream.next()).value).toMatchObject({ type: 'begin' });
    await stream.next();
    await stream.next();
    value = 'after';
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1);
    try {
      const next = await Promise.race([
        stream.next(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('METADATA_STALLED_AFTER_CLOCK_ROLLBACK')),
            1200,
          );
        }),
      ]);
      expect(next.value).toMatchObject({ type: 'begin' });
      expect((await stream.next()).value).toMatchObject({ text: expect.stringContaining('after') });
    } finally {
      clock.mockRestore();
    }
  } finally {
    clearTimeout(timer);
    await observation.dispose();
  }
});
