import type { Context } from '@deepseek-ai/cordis';
import { RemoteError } from '@axterm/plugin-api';
import { terminalVisualSettingsSchema } from '@axterm/plugin-api/terminals';
import type { UpdateSettingsInput, TerminalVisualSettings } from '@axterm/plugin-api/configuration';
const failure = (reason: 'unavailable' | 'invalid-input') =>
  new RemoteError('configuration/failure', 'Visual references are unavailable', { reason });
/** Bounded readonly queries from the actual fact owners, inside their shared transaction. */
export class SettingsVisualReferences {
  constructor(private readonly ctx: Context) {}
  private visuals(input: UpdateSettingsInput | undefined): TerminalVisualSettings[] {
    if (!input) return [];
    return [
      ...(input.terminal?.visual ? [input.terminal.visual] : []),
      ...(input.workspace?.layout?.tabs.flatMap((tab) => (tab.visual ? [tab.visual] : [])) ?? []),
      ...(input.workspace?.namedWorkspaces?.flatMap((workspace) => [
        ...workspace.layout.tabs.flatMap((tab) => (tab.visual ? [tab.visual] : [])),
        ...(workspace.presentation?.tabs.flatMap((tab) =>
          tab.terminalVisual ? [tab.terminalVisual] : [],
        ) ?? []),
      ]) ?? []),
      ...Object.values(input.workspace?.presentations ?? {}).flatMap((record) =>
        record.presentation.tabs.flatMap((tab) => (tab.terminalVisual ? [tab.terminalVisual] : [])),
      ),
    ].map((value) => terminalVisualSettingsSchema.parse(value));
  }
  participants(input: UpdateSettingsInput | undefined) {
    const visuals = this.visuals(input);
    if (!visuals.length) return [];
    const facts = this.ctx.get('terminalFacts');
    if (!facts) throw failure('unavailable');
    if (!visuals.some((value) => value.background.kind === 'image')) return [facts.participant];
    const assets = this.ctx.get('terminalAssetReferences');
    if (!assets) throw failure('unavailable');
    return [facts.participant, assets.participant];
  }
  validate(input: UpdateSettingsInput): void {
    const visuals = this.visuals(input);
    if (!visuals.length) return;
    const facts = this.ctx.get('terminalFacts');
    if (!facts) throw failure('unavailable');
    const themes = new Set(facts.listThemes().map((theme) => theme.id)),
      images = new Set<string>();
    for (const visual of visuals) {
      if (!themes.has(visual.themeId)) throw failure('invalid-input');
      if (visual.background.kind === 'image' && visual.background.assetId)
        images.add(visual.background.assetId);
    }
    if (!images.size) return;
    const assets = this.ctx.get('terminalAssetReferences');
    if (!assets) throw failure('unavailable');
    for (const id of images) {
      try {
        assets.get(id);
      } catch {
        throw failure('invalid-input');
      }
    }
  }
}
