import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import * as Configuration from '../../packages/plugins/configuration/src/index.ts';
import { SettingsProjection } from '../../packages/plugins/configuration/src/client/projection.ts';
import { SettingsModel } from '../../packages/plugins/configuration/src/client/index.ts';
import {
  RemoteStream,
  type RemoteStreamOptions,
} from '../../packages/infra/gateway/src/client/remote-stream.ts';
import type { SettingsUpdate } from '@axterm/plugin-api/configuration';
import { ownedStorage } from '../fixtures/level3-owned-storage.ts';
type Controller = Configuration.ConfigurationController;
async function host() {
  const storage = await ownedStorage();
  storage.ctx.provide('runtimeIdentity', {
    runtimeId: randomUUID(),
    generation: randomUUID(),
    startedAt: new Date().toISOString(),
    pid: process.pid,
    mode: 'headless',
    appVersion: '0.10.0',
  });
  await storage.ctx.plugin(Configuration);
  return { ...storage, controller: storage.ctx.configurationController };
}
function result(controller: Controller, ...args: Parameters<Controller['updateSettings']>) {
  try {
    return { ok: true as const, value: controller.updateSettings(...args) };
  } catch (error) {
    return { ok: false as const, error };
  }
}
async function fixture() {
  const owner = await host();
  let controller = owner.controller;
  const update = vi.fn(async (...args: Parameters<Controller['updateSettings']>) =>
    result(controller, ...args),
  );
  const watch = vi.fn((signal: AbortSignal) => controller.watchSettings(signal));
  const context = {
    remote: {
      $stream: (options: RemoteStreamOptions<SettingsUpdate>) =>
        new RemoteStream(
          { generation: { getSnapshot: () => undefined, subscribe: () => () => {} } },
          options,
        ),
      configuration: { updateSettings: update, watchSettings: watch },
    },
  } as unknown as Context;
  const model = new SettingsModel(context);
  owner.ctx.effect(() => () => model.dispose());
  const settings = () => {
    const value = model.getSnapshot();
    if (value.status !== 'ready') throw Error('Missing fixture baseline');
    return value.baseline.settings;
  };
  await vi.waitFor(() => expect(model.getSnapshot().status).toBe('ready'));
  return {
    owner,
    model,
    update,
    watch,
    settings,
    replace: (value: Controller) => {
      controller = value;
    },
  };
}
it('serializes layout and preference writes against the revision committed by the previous writer', async () => {
  const f = await fixture(),
    release = Promise.withResolvers<void>(),
    controller = f.owner.controller;
  f.update.mockImplementationOnce(async (...args) => {
    await release.promise;
    return result(controller, ...args);
  });
  const first = f.model.writeObservedSettings({ workspace: { aiInspectorOpen: true } });
  await vi.waitFor(() => expect(f.update).toHaveBeenCalledOnce());
  const patch = { workspace: { showTabNumber: false } };
  const second = f.model.writeObservedSettings(patch);
  patch.workspace.showTabNumber = true;
  await Promise.resolve();
  expect(f.update).toHaveBeenCalledOnce();
  release.resolve();
  await Promise.all([first, second]);
  expect(f.update.mock.calls.map(([, input, version]) => ({ input, version }))).toEqual([
    { input: { workspace: { aiInspectorOpen: true } }, version: '"v1"' },
    { input: { workspace: { showTabNumber: false } }, version: '"v2"' },
  ]);
  expect(f.settings()).toMatchObject({
    workspace: { aiInspectorOpen: true, showTabNumber: false },
    version: 3,
  });
  await f.model.dispose();
});
it('uses the latest observed revision rather than a previously captured UI snapshot', async () => {
  const f = await fixture(),
    previous = f.settings();
  f.owner.controller.updateSettings(randomUUID(), { workspace: { aiInspectorOpen: true } }, '"v1"');
  await vi.waitFor(() => expect(f.settings().version).toBe(2));
  await f.model.writeObservedSettings({ workspace: { showTabNumber: false } });
  expect(f.update.mock.calls[0]?.[2]).toBe('"v2"');
  expect(previous.version).toBe(1);
  expect(f.settings()).toMatchObject({
    workspace: { aiInspectorOpen: true, showTabNumber: false },
    version: 3,
  });
  await f.model.dispose();
});
it('refreshes after a rejected write without silently retrying it', async () => {
  const f = await fixture();
  f.update.mockImplementationOnce(async (...args) => {
    f.owner.controller.updateSettings(
      randomUUID(),
      { workspace: { aiInspectorOpen: true } },
      '"v1"',
    );
    return result(f.owner.controller, ...args);
  });
  await expect(
    f.model.writeObservedSettings({ workspace: { showTabNumber: false } }),
  ).rejects.toMatchObject({
    code: 'configuration/failure',
    details: { reason: 'precondition-failed' },
  });
  expect(f.update).toHaveBeenCalledOnce();
  expect(f.watch).toHaveBeenCalledTimes(2);
  expect(f.settings().version).toBe(2);
  await f.model.writeObservedSettings({ workspace: { showTabNumber: false } });
  expect(f.update.mock.calls[1]?.[2]).toBe('"v2"');
  expect(f.settings()).toMatchObject({
    workspace: { aiInspectorOpen: true, showTabNumber: false },
    version: 3,
  });
  await f.model.dispose();
});
it('retains a newer revision delivered while the write was in flight', async () => {
  const f = await fixture(),
    ack = Promise.withResolvers<void>(),
    committed = Promise.withResolvers<void>();
  f.update.mockImplementationOnce(async (...args) => {
    const receipt = result(f.owner.controller, ...args);
    committed.resolve();
    await ack.promise;
    return receipt;
  });
  const pending = f.model.writeObservedSettings({ workspace: { aiInspectorOpen: true } });
  await committed.promise;
  f.owner.controller.updateSettings(randomUUID(), { workspace: { showTabNumber: false } }, '"v2"');
  await vi.waitFor(() => expect(f.settings().version).toBe(3));
  ack.resolve();
  await pending;
  expect(f.settings()).toMatchObject({
    workspace: { aiInspectorOpen: true, showTabNumber: false },
    version: 3,
  });
  expect(f.update).toHaveBeenCalledOnce();
  await f.model.dispose();
});
it('retires queued UI writes on generation replacement without applying them to the new owner', async () => {
  const f = await fixture(),
    next = await host(),
    release = Promise.withResolvers<void>(),
    old = f.owner.controller;
  f.update.mockImplementationOnce(async (...args) => {
    await release.promise;
    return result(old, ...args);
  });
  const first = f.model.writeObservedSettings({ workspace: { aiInspectorOpen: true } });
  const firstRejected = expect(first).rejects.toThrow('SETTINGS_GENERATION_CHANGED');
  await vi.waitFor(() => expect(f.update).toHaveBeenCalledOnce());
  const queued = f.model.writeObservedSettings({ workspace: { showTabNumber: false } });
  const queuedRejected = expect(queued).rejects.toThrow('SETTINGS_GENERATION_CHANGED');
  f.replace(next.controller);
  await f.model.retry();
  await vi.waitFor(() => {
    const value = f.model.getSnapshot();
    expect(value.status === 'ready' && value.baseline.generation).toBe(
      next.ctx.runtimeIdentity.generation,
    );
  });
  release.resolve();
  await Promise.all([firstRejected, queuedRejected]);
  expect(f.update).toHaveBeenCalledOnce();
  expect(next.controller.getSettings()).toMatchObject({
    version: 1,
    workspace: { aiInspectorOpen: false, showTabNumber: true },
  });
  await f.model.dispose();
});

it('joins an issued write on unload and revokes queued UI work without awaiting a retired observation', async () => {
  const f = await fixture(),
    release = Promise.withResolvers<void>(),
    controller = f.owner.controller;
  f.update.mockImplementationOnce(async (...args) => {
    await release.promise;
    return result(controller, ...args);
  });
  const first = f.model.writeObservedSettings({ workspace: { aiInspectorOpen: true } });
  const firstRejected = expect(first).rejects.toThrow('SETTINGS_MODEL_CLOSED');
  await vi.waitFor(() => expect(f.update).toHaveBeenCalledOnce());
  const queued = f.model.writeObservedSettings({ workspace: { showTabNumber: false } });
  const queuedRejected = expect(queued).rejects.toThrow('SETTINGS_MODEL_CLOSED');
  let closed = false;
  const closing = f.model.dispose().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release.resolve();
  await Promise.all([firstRejected, queuedRejected, closing]);
  expect(f.update).toHaveBeenCalledOnce();
  expect(controller.getSettings()).toMatchObject({
    workspace: { aiInspectorOpen: true, showTabNumber: true },
    version: 2,
  });
  expect(f.watch).toHaveBeenCalledOnce();
  expect(() => f.model.writeObservedSettings({})).toThrow('SETTINGS_MODEL_CLOSED');
});

it('rejects a delayed earlier settings replacement instead of overwriting current observed facts', async () => {
  const owner = await host(),
    projection = new SettingsProjection(),
    generation = owner.ctx.runtimeIdentity.generation;
  const saved = owner.controller.updateSettings(
    randomUUID(),
    { workspace: { showTabNumber: false } },
    '"v1"',
  );
  const settings = owner.controller.getSettings();
  projection.accept({ type: 'begin', mode: 'baseline', generation, cursor: saved.cursor });
  projection.accept({ type: 'chunk', offset: 0, text: JSON.stringify(settings), final: true });
  const baseline = projection.accept({ type: 'commit', cursor: saved.cursor });
  expect(baseline?.settings).toEqual(settings);
  expect(() =>
    projection.accept({ type: 'begin', mode: 'replace', generation, cursor: saved.cursor - 1 }),
  ).toThrow('SETTINGS_PROJECTION_INVALID');
  expect(baseline?.settings).toMatchObject({ version: 2, workspace: { showTabNumber: false } });
  expect(Object.isFrozen(baseline?.settings)).toBe(true);
});
