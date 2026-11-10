import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import { DEFAULT_TERMINAL_BACKGROUND } from '@axterm/plugin-api/terminals';
import type { TerminalVisualUi } from '@axterm/ui/workspace';
import type {} from '../facts.ts';
import type {} from '../assets.ts';

/** Only metadata and a tokenless owned HTTP descriptor enter rendering state. */
export function useTerminalAppearance(
  ctx: Context,
  previews: TerminalVisualUi,
  id: string,
  track: <T>(task: Promise<T>) => Promise<T>,
  lifetime: AbortSignal,
) {
  const configuration = useSyncExternalStore(
    ctx.configurationActions.subscribe,
    ctx.configurationActions.getSnapshot,
  );
  const facts = useSyncExternalStore(
    ctx.terminalFactsModel.subscribe,
    ctx.terminalFactsModel.getSnapshot,
  );
  const assets = useSyncExternalStore(
    ctx.terminalAssetsModel.subscribe,
    ctx.terminalAssetsModel.getSnapshot,
  );
  const workspace = useSyncExternalStore(ctx.workspaceUi.subscribe, ctx.workspaceUi.getSnapshot);
  const preview = useSyncExternalStore(previews.subscribe, previews.getSnapshot);
  const visual =
    preview.previews[id] ??
    workspace.tabs.find((tab) => tab.id === id)?.terminalVisual ??
    (configuration.status === 'ready'
      ? configuration.baseline.settings.terminal.visual
      : undefined);
  const theme =
    facts.status === 'ready'
      ? facts.baseline.themes.find((theme) => theme.id === visual?.themeId)?.terminal
      : undefined;
  const background = visual?.background ?? DEFAULT_TERMINAL_BACKGROUND;
  const assetId = background.kind === 'image' ? background.assetId : null;
  const generation = assets.status === 'ready' ? assets.baseline.generation : undefined;
  const asset =
    assets.status === 'ready'
      ? assets.baseline.assets.find((asset) => asset.id === assetId)
      : undefined;
  const version = asset?.version;
  const [content, setContent] = useState<{
    id: string;
    generation: string;
    version: number;
    href?: string;
    failed?: boolean;
  }>();
  useEffect(() => {
    let active = true;
    if (!assetId || !generation || version === undefined) return;
    const abort = new AbortController();
    void track(
      ctx.terminalAssetsModel
        .content(assetId, generation, AbortSignal.any([abort.signal, lifetime]))
        .then((descriptor) => {
          // Refuse a descriptor that changes authority, path ownership or resource identity.
          if (
            descriptor.asset.id !== assetId ||
            descriptor.asset.version !== version ||
            descriptor.href !== `terminals/background-assets/${assetId}`
          )
            throw Error('TERMINAL_BACKGROUND_DESCRIPTOR_INVALID');
          if (active) setContent({ id: assetId, generation, version, href: '/' + descriptor.href });
        })
        .catch(() => {
          if (active) setContent({ id: assetId, generation, version, failed: true });
        }),
    );
    return () => {
      active = false;
      abort.abort();
    };
  }, [ctx, assetId, generation, version, track, lifetime]);
  const current =
    content?.id === assetId && content?.generation === generation && content?.version === version
      ? content
      : undefined;
  return {
    theme,
    background,
    imageUrl: current?.href,
    imageFailed:
      !!assetId &&
      (assets.status === 'error' || (assets.status === 'ready' && !asset) || !!current?.failed),
  };
}
