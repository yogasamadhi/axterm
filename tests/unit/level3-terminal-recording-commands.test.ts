import { expect, it, vi } from 'vitest';
import { fileGrantSchema } from '@axterm/plugin-api/files';
import {
  terminalSessionSchema,
  type TerminalRecording,
  type TerminalBaseline,
  type StartTerminalRecordingInput,
} from '@axterm/plugin-api/terminals';
import { TerminalRecordingCommands } from '../../packages/plugins/terminals/src/client/tools/recording.ts';
function fixture() {
  const generation = crypto.randomUUID(),
    id = crypto.randomUUID(),
    session = terminalSessionSchema.parse({
      id,
      title: 'Fixture',
      kind: 'local',
      state: 'ready',
      createdAt: new Date().toISOString(),
    });
  const recording: TerminalRecording = {
    terminalId: id,
    state: 'active',
    fileName: 'fixture.log',
    timestamps: false,
    bytesWritten: 0,
    startedAt: new Date().toISOString(),
  };
  const grant = fileGrantSchema.parse({
    grantId: crypto.randomUUID(),
    kind: 'save-target',
    name: 'fixture.log',
    permissions: ['write'],
    createdAt: new Date().toISOString(),
  });
  const model = {
    getSnapshot: () => ({
      status: 'ready' as const,
      baseline: {
        type: 'baseline',
        generation,
        revision: 1,
        sessions: [session],
      } satisfies TerminalBaseline,
    }),
    startRecording: vi.fn(
      async (_generation: string, _key: string, _id: string, _input: StartTerminalRecordingInput) =>
        recording,
    ),
    stopRecording: vi.fn(async (_generation: string, _key: string, _id: string) => ({
      ...recording,
      state: 'stopped' as const,
    })),
    getRecordingOutcome: vi.fn(async () => ({ status: 'accepted' as const, id })),
  };
  const grants = {
    create: vi.fn(async () => grant),
    createInGeneration: vi.fn(async () => grant),
    revoke: vi.fn(async () => {}),
    revokeInGeneration: vi.fn(async () => {}),
    importFile: vi.fn(async () => grant),
  };
  return {
    generation,
    id,
    session,
    recording,
    grant,
    model,
    grants,
    owner: new TerminalRecordingCommands(model, grants),
  };
}
it('retains the exact recording key/grant/options after a lost response and does not re-open a picker or revoke an accepted log', async () => {
  const f = fixture();
  f.model.startRecording.mockRejectedValueOnce(Error('controlled lost response'));
  await expect(f.owner.run(f.id, true)).rejects.toThrow('lost response');
  expect(f.owner.getSnapshot().uncertain).toEqual([f.id]);
  f.session.behavior.logTimestamps = true;
  await f.owner.retry(f.id);
  expect(f.model.startRecording.mock.calls[1]).toEqual(f.model.startRecording.mock.calls[0]);
  expect(f.grants.createInGeneration).toHaveBeenCalledOnce();
  expect(f.grants.revokeInGeneration).not.toHaveBeenCalled();
  await f.owner.close();
});
it('revokes the exact late picker grant when its UI owner closes before admission', async () => {
  const f = fixture(),
    picked = Promise.withResolvers<typeof f.grant>();
  f.grants.createInGeneration.mockImplementationOnce(() => picked.promise);
  const pending = f.owner.run(f.id),
    rejected = expect(pending).rejects.toThrow();
  const closing = f.owner.close();
  picked.resolve(f.grant);
  await rejected;
  await closing;
  expect(f.grants.revokeInGeneration).toHaveBeenCalledWith(f.grant.grantId, f.generation);
  expect(f.model.startRecording).not.toHaveBeenCalled();
});
it('saves and continues an existing recording using one picked grant and the original unknown stop key before admitting its replacement', async () => {
  const f = fixture();
  f.session.recording = f.recording;
  f.model.stopRecording.mockRejectedValueOnce(Error('controlled lost stop'));
  await expect(f.owner.run(f.id, true)).rejects.toThrow('lost stop');
  await f.owner.retry(f.id);
  expect(f.model.stopRecording.mock.calls[1]).toEqual(f.model.stopRecording.mock.calls[0]);
  expect(f.model.startRecording).toHaveBeenCalledOnce();
  expect(f.model.startRecording.mock.calls[0]?.[3].includeRecent).toBe(true);
  expect(f.grants.createInGeneration).toHaveBeenCalledOnce();
  await f.owner.close();
});

it('does not repeat a native picker whose grant response is unknown', async () => {
  const f = fixture();
  f.grants.createInGeneration.mockRejectedValueOnce(Error('controlled lost picker response'));
  await expect(f.owner.run(f.id)).rejects.toThrow('lost picker');
  await expect(f.owner.retry(f.id)).rejects.toThrow('PICKER_OUTCOME_UNCERTAIN');
  expect(f.grants.createInGeneration).toHaveBeenCalledOnce();
  expect(f.model.startRecording).not.toHaveBeenCalled();
  await expect(f.owner.close()).rejects.toThrow('DRAIN_UNCERTAIN');
});
