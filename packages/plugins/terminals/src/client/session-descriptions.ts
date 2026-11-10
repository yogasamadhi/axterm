import type { Context } from '@deepseek-ai/cordis';
import type { PersistedTerminalTab } from '@axterm/plugin-api/configuration';
import type { TerminalsModel } from './index.ts';
/** Workspace descriptions are read from accepted metadata, never output, environment, grants or temporary secrets. */
export function installTerminalSessionDescriptions(ctx: Context, model: TerminalsModel) {
  ctx.inject(['workspaceSessionDescriptions'], (owner) =>
    owner.effect(() =>
      owner.workspaceSessionDescriptions.register('terminal', {
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
          const connections = ctx.connectionActions.getSnapshot(),
            connection =
              session.connectionId && connections.status === 'ready'
                ? connections.baseline.connections.find((item) => item.id === session.connectionId)
                : undefined;
          return {
            id: session.id,
            title: session.title,
            kind: session.kind,
            pinned: false,
            paneIndex: 0,
            ...(session.bookmarkId ? { bookmarkId: session.bookmarkId } : {}),
            ...(connection ? { hostId: connection.hostId } : {}),
            ...(session.profileId ? { profileId: session.profileId } : {}),
            appearance: structuredClone(session.appearance),
            behavior: structuredClone(session.behavior),
          };
        },
        async restore(input: PersistedTerminalTab, generation, signal) {
          signal.throwIfAborted();
          const state = model.getSnapshot();
          if (state.status !== 'ready' || state.baseline.generation !== generation)
            throw Error('WORKSPACE_TERMINAL_GENERATION_RETIRED');
          const terminal = {
            ...(input.profileId ? { profileId: input.profileId } : {}),
            ...(input.bookmarkId ? { bookmarkId: input.bookmarkId } : {}),
            ...(input.appearance ? { appearance: input.appearance } : {}),
            ...(input.behavior ? { behavior: input.behavior } : {}),
          };
          if (input.kind === 'ssh') {
            const connectionFacts = ctx.connectionActions.getSnapshot();
            if (
              connectionFacts.status !== 'ready' ||
              connectionFacts.baseline.generation !== generation
            )
              throw Error('WORKSPACE_CONNECTION_GENERATION_RETIRED');
            const catalog = ctx.get('catalogActions')?.getSnapshot(),
              bookmark =
                input.bookmarkId && catalog?.status === 'ready'
                  ? catalog.baseline.bookmarks.bookmarks.find(
                      (item) => item.id === input.bookmarkId,
                    )
                  : undefined,
              hostId = input.hostId ?? bookmark?.hostId,
              connections = ctx.get('connectionWorkspaceUi');
            if (!hostId || !connections) throw Error('WORKSPACE_SSH_REFERENCE_UNAVAILABLE');
            return connections.openSsh(
              {
                hostId,
                ...(bookmark?.connectionProfileId
                  ? { connectionProfileId: bookmark.connectionProfileId }
                  : {}),
              },
              { signal, terminal: { ...terminal, title: input.title } },
            );
          }
          if (input.kind !== 'local' && input.kind !== 'telnet' && input.kind !== 'serial')
            throw Error('WORKSPACE_TERMINAL_KIND_UNAVAILABLE');
          return ctx.terminalWorkspaceUi.open(
            { kind: input.kind, cols: 80, rows: 24, ...terminal },
            signal,
            { title: input.title },
          );
        },
      }),
    ),
  );
}
