import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { expect, it, vi } from 'vitest';
import {
  RemoteStream,
  type RemoteStreamOptions,
} from '../../packages/infra/gateway/src/client/remote-stream.ts';
import { SyncModel } from '../../packages/plugins/configuration/src/client/sync.ts';
import { syncProfileSchema, type SyncUpdate } from '@axterm/plugin-api/configuration-sync';

it.each(['accepted', 'closed'] as const)(
  'holds accepted Sync commit until canonical profile publication: %s',
  async (mode) => {
    let controller!: ReadableStreamDefaultController<SyncUpdate>;
    const wire = new ReadableStream<SyncUpdate>({
      start(value) {
        controller = value;
      },
    });
    let ended = false;
    const generation = randomUUID();
    const profile = syncProfileSchema.parse({
      id: randomUUID(),
      provider: 'webdav',
      format: 'axterm-sync-v1',
      name: 'reviewed',
      endpointUrl: 'http://127.0.0.1:1/dav',
      remoteId: 'snapshot',
      username: 'operator',
      accessCredentialConfigured: true,
      encryptionConfigured: false,
      selectedCategories: ['bookmarks'],
      autoSyncEnabled: false,
      autoSyncIntervalMinutes: 5,
      autoSyncDirection: 'upload',
      state: 'idle',
      remoteRevision: null,
      lastSyncAt: null,
      lastErrorCode: null,
      pendingPreviewId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });
    const accepted = { ...profile, version: 2 };
    const commitSyncDownload = vi.fn(async () => ({
      ok: true,
      value: {
        profile: accepted,
        result: {
          previewId: randomUUID(),
          entityCount: 0,
          counts: { create: 0, unchanged: 0, conflict: 0, skipped: 0 },
          settings: 'preserved',
        },
      },
    }));
    const connection = {
      generation: { getSnapshot: () => undefined },
    } as unknown as ConstructorParameters<typeof RemoteStream>[0];
    const ctx = {
      get: () => undefined,
      remote: {
        $stream: (options: RemoteStreamOptions<SyncUpdate>) =>
          new RemoteStream(connection, options),
        configuration: {
          commitSyncDownload,
          watchSync: (signal: AbortSignal) => {
            signal.addEventListener(
              'abort',
              () => {
                if (!ended) {
                  ended = true;
                  controller.close();
                }
              },
              { once: true },
            );
            return wire;
          },
        },
      },
    } as unknown as Context;
    const model = new SyncModel(ctx);
    const publish = (version: number, cursor: number, physicalGeneration = generation) => {
      controller.enqueue({
        type: 'begin',
        mode: cursor === 0 ? 'baseline' : 'replace',
        generation: physicalGeneration,
        cursor,
      });
      controller.enqueue({
        type: 'chunk',
        offset: 0,
        final: true,
        text: JSON.stringify({ profiles: [{ ...profile, version }], runs: [] }),
      });
      controller.enqueue({ type: 'commit', cursor });
    };
    try {
      publish(1, 0);
      await vi.waitFor(() => expect(model.getSnapshot().status).toBe('ready'));
      let settled = false;
      const pending = model.commit(profile.id, randomUUID()).finally(() => {
        settled = true;
      });
      const outcome =
        mode === 'accepted'
          ? expect(pending).resolves.toMatchObject({ profile: accepted })
          : expect(pending).rejects.toThrow('SYNC_MODEL_CLOSED');
      await vi.waitFor(() => expect(commitSyncDownload).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      expect(settled).toBe(false);
      if (mode === 'closed') await model.dispose();
      else {
        publish(1, 1);
        await vi.waitFor(() =>
          expect(model.getSnapshot()).toMatchObject({ baseline: { cursor: 1 } }),
        );
        expect(settled).toBe(false);
        publish(2, 2);
      }
      await outcome;
      expect(commitSyncDownload).toHaveBeenCalledTimes(1);
    } finally {
      await model.dispose();
    }
  },
);
