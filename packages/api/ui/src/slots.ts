import type { Context } from '@deepseek-ai/cordis';
import type {
  SlotCore,
  RegisterFactory,
  SlotMap,
  SlotRenderer,
  OwnerOf,
  StoredEntry,
  StoredFactory,
  LiveCompositionNode,
  SlotSpec,
  LocaleFace,
  RootStandardSourceContribution,
  SlotScope,
  SlotScopeAdapter,
  ScopedStandardSourceBinding,
} from './index.ts';
export interface RootOwnerProps {
  children?: never;
}
export type SlotInjectionEffect = (() => void) | Iterable<() => void, void, void>;
/** Selected public composition face. Its implementation and React root remain renderer-owned. */
export interface Slots {
  readonly register: SlotCore['register'];
  readonly registerFactory: RegisterFactory;
  inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void;
  install(renderer: SlotRenderer): void;
  installLocale(face: LocaleFace): void;
  provideRoot(contribution: RootStandardSourceContribution): () => void;
  installScope(
    scope: Exclude<SlotScope, 'root' | 'session-maybe'>,
    adapter: SlotScopeAdapter,
  ): void;
  bindStoreScope(binding: Pick<ScopedStandardSourceBinding, 'key' | 'ctx'>): void;
  renderSlot<K extends keyof SlotMap & string>(
    key: K,
    owner: OwnerOf<K>,
  ): ReturnType<SlotRenderer['renderRoot']>;
  entries(key: keyof SlotMap & string): readonly StoredEntry[];
  entriesOfSlot(key: keyof SlotMap & string): readonly StoredEntry[];
  snapshot(root?: string): LiveCompositionNode[];
  onEntryError(
    fn: (
      key: string,
      registration: StoredEntry | StoredFactory,
      error: unknown,
      info: { abdicated: boolean },
    ) => void,
  ): () => void;
  spec<K extends keyof SlotMap & string>(key: K): SlotSpec<SlotMap[K]> | undefined;
  subscribe(key: keyof SlotMap & string, fn: () => void): () => void;
  getVersion(key: keyof SlotMap & string): number;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: Slots;
  }
  interface Events {
    'slots/changed'(key: string): void;
  }
}
// Keep Context reachable in declaration consumers without importing the private renderer.
export type SlotContext = Context;
