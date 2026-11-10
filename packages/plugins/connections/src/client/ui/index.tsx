import { installConnectionTools } from './tools/index.tsx';
import { ConnectionWorkspaceAdmissions } from './workspace-owner.ts';
import '@axterm/ui/workspace';
import '@axterm/ui/presentation';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import type { ConnectionsModel } from '../index.ts';
import { InteractionResponses } from './response-owner.ts';
import { ConnectionInteractions } from './interactions.tsx';
import { dictionaries } from './locales.ts';
import { cssText } from './ui.module.css';
/** Connections owns this contribution; Workspace is the only renderer root. */
export function installConnectionUi(ctx: Context, model: ConnectionsModel): void {
  installConnectionTools(ctx, model);
  ctx.effect(() => ctx.locale.register('connections', dictionaries));
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.axtermOwner = '@axterm/plugin-connections';
    style.dataset.plugin = '@axterm/plugin-connections';
    style.textContent = cssText;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.inject(['terminalWorkspaceUi'], (scope) => {
    const workspace = new ConnectionWorkspaceAdmissions(
      model,
      scope.terminalWorkspaceUi,
      scope.tunnelWorkspaceUi,
    );
    scope.inject(['filesWorkspaceUi'], (child) => {
      child.effect(() => workspace.attachFiles(child.filesWorkspaceUi));
    });
    scope.provide('connectionWorkspaceUi', {
      openHistory: (id, input, ifMatch, options) =>
        workspace.openHistory(id, input, ifMatch, options?.signal, options?.terminal),
      openSsh: (input, options) =>
        workspace.openSsh(
          input,
          options?.signal,
          options?.terminal,
          options?.filesOnly,
          options?.filesAfterTerminal,
          options?.tunnels,
        ),
    });
    scope.effect(() => () => workspace.dispose());
  });
  const responses = new InteractionResponses(model);
  ctx.effect(() => () => responses.dispose());
  ctx.slots.inject('workspace.overlay', function* () {
    yield ctx.slots.register(
      {
        name: 'workspace.overlay',
        id: 'connections.interactions',
        order: 10,
        locale: 'connections',
      },
      function ConnectionsOverlay(props: PropsLocale<'connections'>) {
        return <ConnectionInteractions {...props} model={model} responses={responses} />;
      },
    );
  });
}
