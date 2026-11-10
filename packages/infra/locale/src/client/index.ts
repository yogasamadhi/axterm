// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/client/locale/src/client/index.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
// Axterm additions: accepted Configuration facts, bounded registries and deterministic drain.
import type { Context } from '@deepseek-ai/cordis';
import { PresentationPreference } from '@axterm/ui/preference';
import type {
  LocaleService,
  LocaleDict,
  LocaleSnapshot,
  LocaleDefinition,
  LocaleId,
  BuiltInLocaleId,
  LanguageRegistration,
  PresentationPreferencePort,
  LocalizedText,
} from '@axterm/ui/presentation';
import type { LocaleDictOf, LocaleNamespaceMap, Translate, TranslateNS } from '@axterm/ui';
const COMMON_NS = 'common';
const FALLBACK_LOCALE = 'en';
const LOCALE_ID_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;
const BUILT_IN_METADATA: readonly LocaleDefinition[] = Object.freeze([
  Object.freeze({ id: 'en', label: 'English' }),
  Object.freeze({ id: 'ja', label: '日本語', fallback: 'en' }),
  Object.freeze({ id: 'zh-CN', label: '简体中文', fallback: 'en' }),
  Object.freeze({ id: 'zh-TW', label: '繁體中文', fallback: 'en' }),
]);
function localeKey(value: string): string {
  return value.toLowerCase();
}
function normalizeLanguage(input: LanguageRegistration): Readonly<LanguageRegistration> {
  if (
    input.id.length > 128 ||
    input.fallback.length > 128 ||
    !LOCALE_ID_PATTERN.test(input.id) ||
    !LOCALE_ID_PATTERN.test(input.fallback) ||
    !input.label.trim() ||
    input.label.length > 128
  )
    throw new Error('LOCALE_LANGUAGE_INVALID');
  return Object.freeze({ id: input.id, label: input.label, fallback: input.fallback });
}
function copyDictionary(entries: LocaleDict): LocaleDict {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries))
    throw new Error('LOCALE_DICTIONARY_INVALID');
  const values = Object.entries(entries);
  if (
    values.length > 20000 ||
    values.some(
      ([key, value]) =>
        !key || key.length > 256 || typeof value !== 'string' || value.length > 16384,
    )
  )
    throw new Error('LOCALE_DICTIONARY_INVALID');
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const entry of values) {
    bytes += encoder.encode(JSON.stringify(entry)).byteLength;
    if (bytes > 16 * 1024 * 1024) throw new Error('LOCALE_CAPACITY');
  }
  return Object.freeze(Object.fromEntries(values));
}
function dictionarySize(entries: LocaleDict): number {
  return new TextEncoder().encode(JSON.stringify(entries)).byteLength;
}
export class LocaleRuntime implements LocaleService {
  private readonly durable: PresentationPreference<string>;
  private closed = false;
  private dictionaryBytes = 0;
  private dicts = new Map<string, Map<string, LocaleDict>>();
  private bound = new Map<string, Translate>();
  private catalog = new Map<string, LocaleDefinition>();
  private fallbackChains = new Map<string, readonly LocaleId[]>();
  private snapshot: LocaleSnapshot;
  private listeners = new Set<() => void>();
  private readonly ctx: Context;
  /** Browser-derived locale standing wherever no explicit Host selection does. */
  private provisional: LocaleId;
  /** Last explicit selection, including one awaiting an external registration. */
  private preference: LocaleId | undefined;

  /**
   * @param ctx - owning context (change events are emitted on it; the scope
   * listener is released through ctx.effect on dispose).
   * @param host - durable preference scope owned by the providing plugin;
   * absent compositions (standalone dictionary registries) stay process-local.
   * @param bootstrap - native initialization; absent in ordinary browsers.
   */
  constructor(
    ctx: Context,
    private readonly bootstrap?: { readonly languages: readonly string[] },
  ) {
    this.ctx = ctx;
    for (const locale of BUILT_IN_METADATA) this.catalog.set(localeKey(locale.id), locale);
    const locales = this.localeList();
    this.provisional = resolveInitialLocale(locales, bootstrap?.languages);
    this.snapshot = Object.freeze({ active: this.provisional, locales, revision: 0 });
    this.durable = new PresentationPreference((value) => {
      this.preference = value;
      const target = this.resolveActive();
      if (this.snapshot.active !== target) this.publish(target, true);
    });
  }
  attachPreference(port: PresentationPreferencePort<string>): () => Promise<void> {
    this.assertOpen();
    return this.durable.attach(port);
  }
  async dispose(): Promise<void> {
    this.closed = true;
    await this.durable.dispose();
    this.listeners.clear();
    this.dicts.clear();
    this.bound.clear();
    this.catalog.clear();
    this.fallbackChains.clear();
    this.dictionaryBytes = 0;
  }
  private assertOpen(): void {
    if (this.closed) throw new Error('LOCALE_CLOSED');
  }

  /**
   * Read the current immutable locale snapshot.
   * @returns the current snapshot (stable reference until the next change).
   */
  getLocale(): LocaleSnapshot {
    return this.snapshot;
  }

  /**
   * Resolve package text through the active language's declared fallback chain.
   * Plain strings stay verbatim; maps do not consult registered dictionaries.
   * @param text - package text whose locale keys are lowercase and include English.
   * @returns the first available translation, including an empty string.
   */
  resolveText(text: LocalizedText): string {
    if (typeof text === 'string') {
      if (text.length > 16384) throw new Error('LOCALE_TEXT_INVALID');
      return text;
    }
    if (!text || typeof text !== 'object' || Array.isArray(text) || typeof text.en !== 'string')
      throw new Error('LOCALE_TEXT_INVALID');
    const entries = Object.entries(text);
    if (
      entries.length > 128 ||
      entries.some(
        ([key, value]) =>
          key.length > 128 ||
          !LOCALE_ID_PATTERN.test(key) ||
          typeof value !== 'string' ||
          value.length > 16384,
      )
    )
      throw new Error('LOCALE_TEXT_INVALID');
    const values = new Map(entries.map(([key, value]) => [localeKey(key), value]));
    if (values.size !== entries.length) throw new Error('LOCALE_TEXT_INVALID');
    return this.fallbackChain(this.snapshot.active).reduceRight(
      (resolved, locale) => values.get(localeKey(locale)) ?? resolved,
      text.en,
    );
  }

  /**
   * LocaleFace getSnapshot: the current snapshot (carries `revision`; stable
   * reference between changes, uSES-safe).
   * @returns the current snapshot.
   */
  getSnapshot = (): LocaleSnapshot => this.snapshot;

  /**
   * LocaleFace subscribe: notified on every snapshot change (locale switch
   * or dictionary registration — registrations bump the revision so already
   * rendered outlets pick up late-arriving dictionaries and locale definitions).
   * @param fn - change callback.
   * @returns unsubscribe.
   */
  subscribe = (fn: () => void): (() => void) => {
    this.assertOpen();
    if (this.listeners.size >= 256) throw new Error('LOCALE_CAPACITY');
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  /**
   * Switch the active locale — the only user preference write entry.
   *
   * The durable write happens even when the id already matches the active
   * locale, because the active value may be a provisional browser-derived or
   * fallback resolution that nothing has stored yet. Picking the language
   * already on screen is still an explicit choice, and it must survive a
   * different browser sharing the same DSH home. Only the render notification
   * is conditional: republishing an unchanged locale would churn every
   * subscriber for nothing.
   * @param id - a registered locale id; unknown ids throw.
   */
  async setLocale(id: string): Promise<void> {
    this.assertOpen();
    const match = this.catalog.get(localeKey(id));
    if (!match) throw new Error('LOCALE_NOT_REGISTERED');
    await this.durable.write(match.id);
  }

  /**
   * Add one selectable language to the shared catalog. Its fallback must
   * already be registered, and following fallback definitions must terminate
   * at English. Dictionaries may register before or after this definition.
   * Registration rechecks an unresolved Host preference and the browser's
   * ordered language list. The caller owns the returned disposer; removing an
   * active language falls back without clearing the stored id.
   * @param input - stable id, self-described label, and fallback language id.
   * @returns idempotent disposer removing this exact definition.
   * @throws when fields are malformed, the id is occupied, or the fallback
   * target is unknown or creates a cycle.
   */
  addLanguage(input: LanguageRegistration): () => void {
    this.assertOpen();
    if (this.catalog.size >= 128) throw new Error('LOCALE_CAPACITY');
    const candidate = normalizeLanguage(input);
    const key = localeKey(candidate.id);
    if (this.catalog.has(key)) throw new Error(`locale "${candidate.id}" is already registered`);
    const fallback = this.catalog.get(localeKey(candidate.fallback));
    if (fallback === undefined) {
      throw new Error(`locale fallback "${candidate.fallback}" is not registered`);
    }
    const language = Object.freeze({ ...candidate, fallback: fallback.id });
    this.catalog.set(key, language);
    try {
      this.assertFallbackChain(language.id);
    } catch (error) {
      this.catalog.delete(key);
      throw error;
    }
    this.publishCatalog();
    return () => {
      if (this.catalog.get(key) !== language) return;
      this.catalog.delete(key);
      this.publishCatalog();
    };
  }

  /**
   * Adopt the scope's accepted durable selection without writing it back; an
   * absent selection returns to the browser-derived locale.
   * @param host - the constructor-narrowed scope driving this adoption.
   */

  /** Recompute browser fallback and publish the current catalog. */
  private publishCatalog(): void {
    this.fallbackChains.clear();
    const locales = this.localeList();
    this.provisional = resolveInitialLocale(locales, this.bootstrap?.languages);
    const active = this.resolveActive();
    this.publish(active, active !== this.snapshot.active, locales);
  }

  /** Resolve an explicit preference only while its definition is available. */
  private resolveActive(): LocaleId {
    if (this.preference === undefined) return this.provisional;
    return this.catalog.get(localeKey(this.preference))?.id ?? this.provisional;
  }

  /** Snapshot the catalog in registration order. */
  private localeList(): readonly LocaleDefinition[] {
    return Object.freeze([...this.catalog.values()]);
  }

  /** Fail a new definition whose complete fallback path does not reach English. */
  private assertFallbackChain(start: LocaleId): void {
    const seen = new Set<string>();
    let current = this.catalog.get(localeKey(start));
    while (current !== undefined) {
      const key = localeKey(current.id);
      if (seen.has(key)) throw new Error(`locale fallback cycle includes "${current.id}"`);
      seen.add(key);
      if (key === localeKey(FALLBACK_LOCALE)) return;
      /* v8 ignore next -- English is the only built-in terminal and every
       * language accepted by addLanguage has a required fallback. */
      if (current.fallback === undefined) {
        throw new Error(
          `locale "${current.id}" fallback chain does not reach "${FALLBACK_LOCALE}"`,
        );
      }
      const next = this.catalog.get(localeKey(current.fallback));
      if (next === undefined) {
        throw new Error(`locale fallback "${current.fallback}" is not registered`);
      }
      current = next;
    }
  }

  /** Resolve a lookup chain, falling directly to English across an unload gap. */
  private fallbackChain(start: LocaleId): readonly LocaleId[] {
    const startKey = localeKey(start);
    const cached = this.fallbackChains.get(startKey);
    if (cached !== undefined) return cached;
    const chain: LocaleId[] = [];
    const seen = new Set<string>();
    let current = this.catalog.get(startKey);
    while (current !== undefined && !seen.has(localeKey(current.id))) {
      const key = localeKey(current.id);
      seen.add(key);
      chain.push(current.id);
      current =
        current.fallback === undefined ? undefined : this.catalog.get(localeKey(current.fallback));
    }
    if (!seen.has(localeKey(FALLBACK_LOCALE))) chain.push(FALLBACK_LOCALE);
    const resolved = Object.freeze(chain);
    this.fallbackChains.set(startKey, resolved);
    return resolved;
  }

  /**
   * Register a declared namespace's dictionaries, all locales in one call —
   * the typed form: each dictionary is checked against the namespace's
   * {@link LocaleNamespaceMap} key union (a missing or extra key is a
   * compile error), and both baseline locales are required (bilingual balance
   * enforced at registration). Duplicate (ns, locale) throws (single occupant; a
   * namespace's texts have one owner). Registration bumps the revision so
   * mounted outlets pick up late-arriving dictionaries.
   * @param ns - a namespace merged into LocaleNamespaceMap.
   * @param dicts - complete baseline dictionaries and optional dictionaries for additional locale ids.
   * @returns disposer removing every locale registered by this call (idempotent).
   */
  register<N extends Extract<keyof LocaleNamespaceMap, string>>(
    ns: N,
    dicts: Record<BuiltInLocaleId, LocaleDictOf<N>> & Record<LocaleId, LocaleDictOf<N>>,
  ): () => void;
  /**
   * Single-locale untyped form for language-pack contributions and namespaces
   * outside the merge table.
   * @param ns - namespace.
   * @param locale - locale tag.
   * @param dict - dictionary.
   * @returns disposer (idempotent).
   * @throws when locale is not a BCP 47-style tag.
   */
  register(ns: string, locale: string, dict: LocaleDict): () => void;
  register(
    ns: string,
    localeOrDicts: string | Record<string, LocaleDict>,
    dict?: LocaleDict,
  ): () => void {
    this.assertOpen();
    if (!/^[A-Za-z][\w.-]{0,127}$/u.test(ns)) throw new Error('LOCALE_NAMESPACE_INVALID');
    if (!this.dicts.has(ns) && this.dicts.size >= 256) throw new Error('LOCALE_CAPACITY');
    const inputPairs: [string, LocaleDict][] =
      typeof localeOrDicts === 'string'
        ? // Overload guarantees dict on the single-locale arm.
          [[localeOrDicts, dict as LocaleDict]]
        : Object.entries(localeOrDicts);
    if (inputPairs.length > 128) throw new Error('LOCALE_CAPACITY');
    const pairs: Array<[string, LocaleDict]> = [];
    const bytes = new Map<string, number>();
    let added = 0;
    for (const [locale, entries] of inputPairs) {
      const copy = copyDictionary(entries);
      const size = dictionarySize(copy);
      added += size;
      if (this.dictionaryBytes + added > 16 * 1024 * 1024) throw new Error('LOCALE_CAPACITY');
      bytes.set(locale, size);
      pairs.push([locale, copy]);
    }
    if (new Set(pairs.map(([locale]) => localeKey(locale))).size !== pairs.length)
      throw new Error('LOCALE_DUPLICATE');
    for (const [locale] of pairs) {
      if (locale.length > 128 || !LOCALE_ID_PATTERN.test(locale)) {
        throw new Error(`locale id "${locale}" is not a BCP 47-style tag`);
      }
    }
    let locales = this.dicts.get(ns);
    if (!locales) {
      locales = new Map();
      this.dicts.set(ns, locales);
    }
    for (const [locale] of pairs) {
      if (locales.has(localeKey(locale))) {
        throw new Error(`locale namespace "${ns}" already has locale "${locale}"`);
      }
    }
    for (const [locale, entries] of pairs) locales.set(localeKey(locale), entries);
    this.dictionaryBytes += added;
    this.publish(this.snapshot.active, false);
    return () => {
      const owner = this.dicts.get(ns);
      /* v8 ignore next -- defensive: a namespace's locales map is created on
       * first register and never removed, so the disposer always finds it. */
      if (!owner) return;
      let removed = false;
      for (const [locale, entries] of pairs) {
        const key = localeKey(locale);
        if (owner.get(key) === entries) {
          owner.delete(key);
          this.dictionaryBytes -= bytes.get(locale) ?? 0;
          removed = true;
        }
      }
      if (owner.size === 0) this.dicts.delete(ns);
      if (removed) this.publish(this.snapshot.active, false);
    };
  }

  /**
   * Bind a declared namespace to a translate function typed to its
   * dictionary key union (plus the shared common vocabulary) — the same key
   * domain the framework-injected `t` seat carries. The returned reference
   * is stable per namespace (repeat binds return the same function), so it
   * can ride inject surfaces without breaking memoization.
   * @param ns - a namespace merged into LocaleNamespaceMap.
   * @returns the typed translate function (reads the active locale at call time).
   */
  bind<N extends Extract<keyof LocaleNamespaceMap, string>>(ns: N): TranslateNS<N>;
  /**
   * Untyped form for namespaces outside the merge table (dynamic
   * composition, tests).
   * @param ns - namespace.
   * @returns the translate function.
   */
  bind(ns: string): Translate;
  bind(ns: string): Translate {
    this.assertOpen();
    if (!this.bound.has(ns) && this.bound.size >= 256) throw new Error('LOCALE_CAPACITY');
    let t = this.bound.get(ns);
    if (!t) {
      t = (key, params) => this.translate(ns, key, params);
      this.bound.set(ns, t);
      return t;
    }
    return t;
  }

  private translate(ns: string, key: string, params?: Record<string, unknown>): string {
    const chain = this.fallbackChain(this.snapshot.active);
    const template =
      this.lookup(ns, key, chain) ??
      (ns !== COMMON_NS ? this.lookup(COMMON_NS, key, chain) : undefined) ??
      key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      Object.hasOwn(params, name) ? String(params[name]).slice(0, 16384) : match,
    );
  }

  private lookup(ns: string, key: string, chain: readonly LocaleId[]): string | undefined {
    const locales = this.dicts.get(ns);
    for (const locale of chain) {
      const entries = locales?.get(localeKey(locale));
      const value = entries && Object.hasOwn(entries, key) ? entries[key] : undefined;
      if (value !== undefined) return value;
    }
    return undefined;
  }

  /**
   * Advance the snapshot revision and notify LocaleFace subscribers (render
   * refresh). Only an active-locale switch additionally emits
   * `locale/change` — dictionary registrations stay off the event so
   * registration-heavy boot cannot storm event listeners (which may
   * re-register slots in response).
   */
  private publish(
    active: LocaleId,
    localeChanged: boolean,
    locales: readonly LocaleDefinition[] = this.snapshot.locales,
  ): void {
    this.snapshot = Object.freeze({
      active,
      locales,
      revision: this.snapshot.revision + 1,
    });
    if (this.closed) return;
    if (localeChanged) {
      try {
        this.ctx.emit('locale/change', this.snapshot);
      } catch {
        console.warn('LOCALE_EVENT_OBSERVER_FAILED');
      }
    }
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        // One throwing subscriber must not strand the rest on a stale
        // revision (outlets would keep the previous language).
        console.warn('LOCALE_OBSERVER_FAILED');
      }
    }
  }
}

/**
 * The browser's own language wins over {@link FALLBACK_LOCALE}; an explicit
 * Host preference may replace this provisional value after plugin activation.
 */
function resolveInitialLocale(
  locales: readonly LocaleDefinition[],
  languages?: readonly string[],
): LocaleId {
  return detectBrowserLocale(locales, languages) ?? FALLBACK_LOCALE;
}

/**
 * The first registered locale the browser asks for. Each browser tag first
 * matches a locale id exactly, then its primary subtag, so an exact regional
 * registration wins before a language-wide fallback.
 * `window` is the browser test, not `navigator`: Node exposes a global
 * `navigator` reporting the machine's own language, which must not decide the
 * locale for non-browser runs. `navigator.language` trails the ordered
 * `languages` list and covers hosts exposing only the single tag.
 * @param locales - definitions currently available to the browser.
 * @param languages - native system language order, when supplied by a shell.
 * @returns the first matching locale id, or undefined.
 */
function detectBrowserLocale(
  locales: readonly LocaleDefinition[],
  languages?: readonly string[],
): LocaleId | undefined {
  if (languages === undefined) {
    if (typeof window === 'undefined') return undefined;
    // Embedders and older WebViews may omit the DOM-typed `languages` property.
    const browserLanguages = (navigator as { readonly languages?: readonly string[] }).languages;
    languages = [...(browserLanguages ?? []), navigator.language];
  }
  for (const tag of languages) {
    const requested = localeKey(tag.trim().replaceAll('_', '-'));
    const chinese = /^zh-(tw|hk)(-|$)/u.test(requested)
      ? 'zh-tw'
      : /^zh-(cn|mo|sg)(-|$)/u.test(requested) || requested === 'zh'
        ? 'zh-cn'
        : undefined;
    if (chinese) {
      const match = locales.find((locale) => localeKey(locale.id) === chinese);
      if (match) return match.id;
    }
    const exact = locales.find((locale) => localeKey(locale.id) === requested);
    if (exact !== undefined) return exact.id;
    const primary = requested.split('-')[0];
    const match = locales.find((locale) => localeKey(locale.id).split('-')[0] === primary);
    if (match !== undefined) return match.id;
  }
  return undefined;
}

/** Required services: slot registration plus the settings transport. */

export const inject = ['slots'];
export function apply(ctx: Context): void {
  const locale = new LocaleRuntime(ctx);
  ctx.effect(() => () => locale.dispose());
  ctx.provide('locale', locale);
  ctx.slots.installLocale(locale);
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {};
    const html = document.documentElement;
    const names = ['lang', 'dir', 'data-language'];
    const before = names.map((name) => html.getAttribute(name));
    let owned: string[] = [];
    const sync = () => {
      const language = locale.getLocale().active;
      owned = [language, 'ltr', language];
      names.forEach((name, index) => html.setAttribute(name, owned[index]!));
    };
    const off = locale.subscribe(sync);
    sync();
    return () => {
      off();
      names.forEach((name, index) => {
        if (html.getAttribute(name) !== owned[index]) return;
        const value = before[index];
        if (value === null || value === undefined) html.removeAttribute(name);
        else html.setAttribute(name, value);
      });
    };
  });
}
