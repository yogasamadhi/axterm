// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted registry/override/media lifecycle from packages/client/ui-theme/src/client/index.ts
// at 8bd073392eef6f54e921a093b95076248eb08cbb. Axterm owns its tokens and accepted preference port.
import type { Context } from '@deepseek-ai/cordis';
import { PresentationPreference } from '@axterm/ui/preference';
import type {
  ThemeService,
  ThemeSnapshot,
  ThemeDefinition,
  ThemeTokenOverrides,
  PresentationPreferencePort,
} from '@axterm/ui/presentation';
import { cssText } from './tokens.module.css';
import { cssText as semanticRoles } from './semantic-roles.module.css';
const BUILTIN_THEMES: readonly ThemeDefinition[] = Object.freeze([
  Object.freeze({ id: 'light', colorScheme: 'light', tokens: Object.freeze({}) }),
  Object.freeze({ id: 'dark', colorScheme: 'dark', tokens: Object.freeze({}) }),
]);
function validateTokens(
  tokens: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens))
    throw new Error('THEME_TOKENS_INVALID');
  const entries = Object.entries(tokens);
  if (entries.length > 256) throw new Error('THEME_CAPACITY');
  for (const [key, value] of entries)
    if (
      !/^--ax-[a-z0-9-]{1,96}$/u.test(key) ||
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > 1024 ||
      /[;{}\0]|@import|url\s*\(/iu.test(value)
    )
      throw new Error('THEME_TOKENS_INVALID');
  return Object.freeze(Object.fromEntries(entries));
}
/** Registry, immutable token layers and media observation; DOM effects belong to apply. */
export class ThemeRuntime implements ThemeService {
  private themes: readonly ThemeDefinition[] = BUILTIN_THEMES;
  private preference = 'dark';
  private transient: string | undefined;
  private readonly overrides = new Map<string, { seq: number; tokens: ThemeTokenOverrides }>();
  private sequence = 0;
  private snapshot: ThemeSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly durable: PresentationPreference<string>;
  private readonly media: MediaQueryList | undefined;
  private readonly stopMedia: () => void;
  private closed = false;
  constructor(private readonly ctx: Context) {
    this.media =
      typeof matchMedia === 'undefined' ? undefined : matchMedia('(prefers-color-scheme: dark)');
    this.snapshot = this.buildSnapshot();
    const onChange = () => {
      if (this.preference === 'system' && !this.transient) this.publish();
    };
    this.media?.addEventListener('change', onChange);
    this.stopMedia = () => this.media?.removeEventListener('change', onChange);
    this.durable = new PresentationPreference((value) => {
      if (value !== undefined && !['light', 'dark', 'system'].includes(value))
        throw new Error('THEME_PREFERENCE_INVALID');
      const preference = value ?? 'dark';
      if (this.preference === preference && !this.transient) return;
      this.preference = preference;
      this.transient = undefined;
      this.publish();
    });
  }
  getTheme(): ThemeSnapshot {
    return this.snapshot;
  }
  getSnapshot = (): ThemeSnapshot => this.snapshot;
  subscribe = (fn: () => void): (() => void) => {
    this.assertOpen();
    if (this.listeners.size >= 256) throw new Error('THEME_CAPACITY');
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  attachPreference(port: PresentationPreferencePort<string>): () => Promise<void> {
    this.assertOpen();
    return this.durable.attach(port);
  }
  async setTheme(id: string): Promise<void> {
    this.assertOpen();
    if (id === 'system' || id === 'light' || id === 'dark') {
      await this.durable.write(id);
      return;
    }
    if (!this.themes.some((theme) => theme.id === id)) throw new Error('THEME_NOT_REGISTERED');
    // As in the selected DSH contract, third-party theme selection is transient.
    this.transient = id;
    this.publish();
  }
  register(definition: ThemeDefinition): () => void {
    this.assertOpen();
    if (
      !/^[a-zA-Z][\w.-]{0,127}$/u.test(definition.id) ||
      definition.id === 'system' ||
      !['light', 'dark'].includes(definition.colorScheme)
    )
      throw new Error('THEME_INVALID');
    if (this.themes.some((theme) => theme.id === definition.id)) throw new Error('THEME_DUPLICATE');
    if (this.themes.length >= 128) throw new Error('THEME_CAPACITY');
    const theme = Object.freeze({
      id: definition.id,
      colorScheme: definition.colorScheme,
      tokens: validateTokens(definition.tokens),
    });
    this.themes = Object.freeze([...this.themes, theme]);
    this.publish();
    return () => {
      if (!this.themes.includes(theme)) return;
      this.themes = Object.freeze(this.themes.filter((candidate) => candidate !== theme));
      if (this.transient === theme.id) this.transient = undefined;
      this.publish();
    };
  }
  overrideTokens(source: string, tokens: ThemeTokenOverrides): () => void {
    this.assertOpen();
    if (
      !source ||
      source.length > 256 ||
      (!this.overrides.has(source) && this.overrides.size >= 128)
    )
      throw new Error('THEME_CAPACITY');
    const light: Record<string, string> = Object.create(null);
    const dark: Record<string, string> = Object.create(null);
    if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens))
      throw new Error('THEME_OVERRIDE_INVALID');
    for (const [key, value] of Object.entries(tokens)) {
      if (
        !value ||
        typeof value !== 'object' ||
        typeof value.light !== 'string' ||
        typeof value.dark !== 'string'
      )
        throw new Error('THEME_OVERRIDE_REQUIRES_BOTH_MODES');
      light[key] = value.light;
      dark[key] = value.dark;
    }
    const lightCopy = validateTokens(light);
    const darkCopy = validateTokens(dark);
    const copy = Object.freeze(
      Object.fromEntries(
        Object.keys(lightCopy).map((key) => [
          key,
          Object.freeze({ light: lightCopy[key]!, dark: darkCopy[key]! }),
        ]),
      ),
    );
    const layer = { seq: this.sequence++, tokens: copy };
    this.overrides.set(source, layer);
    this.publish();
    return () => {
      if (this.overrides.get(source) !== layer) return;
      this.overrides.delete(source);
      this.publish();
    };
  }
  async dispose(): Promise<void> {
    this.closed = true;
    this.stopMedia();
    await this.durable.dispose();
    this.listeners.clear();
    this.overrides.clear();
    this.themes = BUILTIN_THEMES;
  }
  private assertOpen(): void {
    if (this.closed) throw new Error('THEME_CLOSED');
  }
  private buildSnapshot(): ThemeSnapshot {
    const preference = this.transient ?? this.preference;
    const id = preference === 'system' ? (this.media?.matches ? 'dark' : 'light') : preference;
    const definition = this.themes.find((theme) => theme.id === id);
    if (!definition) throw new Error('THEME_REGISTRY_INCOMPLETE');
    const tokens: Record<string, string> = { ...definition.tokens };
    for (const layer of [...this.overrides.values()].sort((a, b) => a.seq - b.seq))
      for (const [name, modes] of Object.entries(layer.tokens))
        tokens[name] = modes[definition.colorScheme];
    return Object.freeze({
      preference,
      active: Object.freeze({ ...definition, tokens: Object.freeze(tokens) }),
      themes: this.themes,
      revision: this.snapshot ? this.snapshot.revision + 1 : 0,
    });
  }
  private publish(): void {
    if (this.closed) return;
    this.snapshot = this.buildSnapshot();
    try {
      this.ctx.emit('theme/change', this.snapshot);
    } catch {
      console.warn('THEME_EVENT_OBSERVER_FAILED');
    }
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('THEME_OBSERVER_FAILED');
      }
    }
  }
}
export const inject: string[] = [];
export function apply(ctx: Context): void {
  const theme = new ThemeRuntime(ctx);
  ctx.effect(() => () => theme.dispose());
  ctx.provide('theme', theme);
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {};
    const style = document.createElement('style');
    style.dataset.plugin = '@axterm/infra-ui-theme';
    style.textContent = cssText + semanticRoles;
    document.head.append(style);
    const html = document.documentElement;
    const before = html.getAttribute('data-ax-theme');
    const scheme = html.style.colorScheme;
    let owned: string | undefined;
    const tokenBefore = new Map<string, string>();
    const tokenOwned = new Map<string, string>();
    const sync = () => {
      const active = theme.getTheme().active;
      owned = active.colorScheme;
      html.dataset.axTheme = owned;
      html.style.colorScheme = owned;
      for (const [name, value] of tokenOwned)
        if (!Object.hasOwn(active.tokens, name)) {
          if (html.style.getPropertyValue(name) === value) {
            const previous = tokenBefore.get(name);
            if (previous) html.style.setProperty(name, previous);
            else html.style.removeProperty(name);
          }
          tokenOwned.delete(name);
          tokenBefore.delete(name);
        }
      for (const [name, value] of Object.entries(active.tokens)) {
        if (!tokenBefore.has(name)) tokenBefore.set(name, html.style.getPropertyValue(name));
        html.style.setProperty(name, value);
        tokenOwned.set(name, value);
      }
    };
    const off = theme.subscribe(sync);
    sync();
    return () => {
      off();
      style.remove();
      if (html.dataset.axTheme === owned) {
        if (before === null) html.removeAttribute('data-ax-theme');
        else html.setAttribute('data-ax-theme', before);
      }
      if (html.style.colorScheme === owned) html.style.colorScheme = scheme;
      for (const [name, value] of tokenOwned)
        if (html.style.getPropertyValue(name) === value) {
          const previous = tokenBefore.get(name);
          if (previous) html.style.setProperty(name, previous);
          else html.style.removeProperty(name);
        }
    };
  });
}
