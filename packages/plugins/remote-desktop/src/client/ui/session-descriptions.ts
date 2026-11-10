import type { Context } from '@deepseek-ai/cordis';
import type { RemoteDesktopModel } from '../index.ts';
import type { WebSessionModel } from '../web-model.ts';
import type { RemoteDesktopWorkspace } from './workspace-owner.ts';
import type { WebSessionWorkspace } from './web-owner.ts';
export function installRemoteDesktopDescriptions(
  ctx: Context,
  model: RemoteDesktopModel,
  workspace: RemoteDesktopWorkspace,
) {
  ctx.inject(['workspaceSessionDescriptions'], (owner) =>
    owner.effect(() =>
      owner.workspaceSessionDescriptions.register('remote-desktop', {
        isReady: (generation) => {
          const state = model.getSnapshot();
          return state.status === 'ready' && state.baseline.generation === generation;
        },
        subscribe: model.subscribe,
        describe(id) {
          const state = model.getSnapshot();
          if (state.status !== 'ready') return;
          const session = state.baseline.sessions.find((item) => item.id === id);
          if (!session) return;
          return {
            id: session.id,
            title: session.title,
            kind: session.protocol,
            bookmarkId: session.bookmarkId,
            pinned: false,
            paneIndex: 0,
          };
        },
        restore(input, generation, signal) {
          const state = model.getSnapshot();
          if (state.status !== 'ready' || state.baseline.generation !== generation)
            throw Error('WORKSPACE_REMOTE_GENERATION_RETIRED');
          if (!input.bookmarkId || !['rdp', 'vnc', 'spice'].includes(input.kind))
            throw Error('WORKSPACE_REMOTE_REFERENCE_UNAVAILABLE');
          return workspace.open(
            { protocol: input.kind as 'rdp' | 'vnc' | 'spice', bookmarkId: input.bookmarkId },
            signal,
          );
        },
      }),
    ),
  );
}
export function installWebSessionDescriptions(
  ctx: Context,
  model: WebSessionModel,
  workspace: WebSessionWorkspace,
) {
  ctx.inject(['workspaceSessionDescriptions'], (owner) =>
    owner.effect(() =>
      owner.workspaceSessionDescriptions.register('web-session', {
        isReady: (generation) => {
          const state = model.getSnapshot();
          return state.status === 'ready' && state.baseline.generation === generation;
        },
        subscribe: model.subscribe,
        describe(id) {
          const state = model.getSnapshot();
          if (state.status !== 'ready') return;
          const session = state.baseline.sessions.find((item) => item.id === id);
          if (!session) return;
          return {
            id: session.id,
            title: session.title,
            kind: 'web',
            bookmarkId: session.bookmarkId,
            pinned: false,
            paneIndex: 0,
          };
        },
        restore(input, generation, signal) {
          const state = model.getSnapshot();
          if (state.status !== 'ready' || state.baseline.generation !== generation)
            throw Error('WORKSPACE_WEB_GENERATION_RETIRED');
          if (input.kind !== 'web' || !input.bookmarkId)
            throw Error('WORKSPACE_WEB_REFERENCE_UNAVAILABLE');
          return workspace.open({ bookmarkId: input.bookmarkId }, signal);
        },
      }),
    ),
  );
}
