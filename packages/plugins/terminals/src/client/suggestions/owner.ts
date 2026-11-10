import { remoteErrorOf } from '@axterm/plugin-api';
import type {} from '@axterm/plugin-api/ai';
import type { CommandHistoryItem } from '@axterm/plugin-api/terminals';
import type { AiCommandSuggestionsUi } from '@axterm/ui/workspace';
import type { TranslateNS } from '@axterm/ui';
import type { TerminalsModel } from '../index.ts';
import type { TerminalFactsModel } from '../facts.ts';
import { historyPageFor } from '../history/projection.ts';
import {
  TerminalPromptInputModel,
  rankTerminalCommandSuggestions,
  terminalSuggestionInsertion,
  parseAiCommandSuggestions,
  setBoundedSuggestionCache,
  TERMINAL_SUGGESTION_DEBOUNCE_MS,
  type TerminalCommandSuggestion,
} from './model.ts';
import type { TerminalCommandSuggestionsState } from './panel.tsx';
interface Ports {
  id: string;
  generation: string;
  sessions: Pick<TerminalsModel, 'getSnapshot'>;
  facts: Pick<TerminalFactsModel, 'getSnapshot' | 'subscribe'>;
  enabled(): boolean;
  active(): boolean;
  position(): Pick<TerminalCommandSuggestionsState, 'position' | 'reverse'> | undefined;
  ai(): AiCommandSuggestionsUi | undefined;
  remove(item: CommandHistoryItem, generation: string): Promise<void>;
  send(text: string): boolean;
  focus(): void;
  t: TranslateNS<'terminals'>;
  changed(state: TerminalCommandSuggestionsState | undefined): void;
}
/** Bounded prompt input and presentation only. History stays in the canonical facts model. */
export class TerminalSuggestionOwner {
  private readonly input = new TerminalPromptInputModel();
  private integrated = false;
  private replaying = false;
  private readonly lifetime = new AbortController();
  private readonly aiCache = new Map<string, string[]>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private state: TerminalCommandSuggestionsState | undefined;
  private error: string | undefined;
  private currentAi: AbortController | undefined;
  private aiTask: Promise<void> | undefined;
  private readonly mutations = new Set<Promise<void>>();
  private readonly off: () => void;
  private closing: Promise<void> | undefined;
  constructor(private readonly ports: Ports) {
    this.off = ports.facts.subscribe(() => {
      if (this.state) this.refresh();
    });
  }
  getSnapshot = () => this.state;
  prompt(data: string): void {
    if (!this.integrated || this.replaying || this.lifetime.signal.aborted) {
      this.input.closePrompt();
      this.dismiss();
      return;
    }
    if (data === 'A') {
      this.input.openPrompt();
      this.dismiss();
    } else if (data === 'C' || data === 'D' || data.startsWith('D;') || data.startsWith('E;')) {
      this.input.closePrompt();
      this.dismiss();
    }
  }
  integration(state: string): void {
    this.integrated = state === 'active';
    if (!this.integrated) {
      this.input.closePrompt();
      this.dismiss();
    }
  }
  replay(active: boolean): void {
    this.replaying = active;
    this.input.closePrompt();
    this.dismiss();
  }
  userInput(data: string): void {
    const snapshot = this.input.handleInput(data);
    if (
      !this.allowed() ||
      !snapshot?.value ||
      snapshot.value !== snapshot.value.trimStart() ||
      snapshot.value.length > 256
    ) {
      this.dismiss();
      return;
    }
    this.currentAi?.abort();
    this.error = undefined;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.refresh();
    }, TERMINAL_SUGGESTION_DEBOUNCE_MS);
  }
  updated(): void {
    if (!this.allowed()) this.dismiss();
  }
  dismiss(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.currentAi?.abort();
    this.error = undefined;
    this.publish(undefined);
  }
  key(event: Pick<KeyboardEvent, 'type' | 'key'>): boolean {
    const state = this.state;
    if (!state) return false;
    if (event.key === 'Escape') {
      if (event.type === 'keydown') this.dismiss();
      return true;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (event.type === 'keydown' && state.items.length) {
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const selectedIndex =
          state.selectedIndex < 0
            ? direction > 0
              ? 0
              : state.items.length - 1
            : (state.selectedIndex + direction + state.items.length) % state.items.length;
        this.publish({ ...state, selectedIndex });
      }
      return true;
    }
    if (event.key === 'Enter' && state.selectedIndex >= 0) {
      if (event.type === 'keydown') {
        const item = state.items[state.selectedIndex];
        if (item) this.select(item);
      }
      return true;
    }
    if (event.key === 'Enter' && event.type === 'keydown') this.dismiss();
    return false;
  }
  select(item: TerminalCommandSuggestion): void {
    const input = this.input.snapshot();
    if (!this.allowed() || !input) return this.dismiss();
    const insertion = terminalSuggestionInsertion(input, item.command);
    if (insertion !== undefined && (!insertion || this.ports.send(insertion)))
      this.input.replace(item.command);
    this.dismiss();
    this.ports.focus();
  }
  remove(item: TerminalCommandSuggestion): Promise<void> {
    if (!item.historyItem || !this.allowed() || this.mutations.size)
      return Promise.reject(Error('TERMINAL_SUGGESTION_DELETE_UNAVAILABLE'));
    const task = Promise.resolve()
      .then(async () => {
        this.lifetime.signal.throwIfAborted();
        if (!this.allowed()) throw Error('TERMINAL_SUGGESTION_RETIRED');
        await this.ports.remove(item.historyItem!, this.ports.generation);
      })
      .catch((error) => {
        if (!this.lifetime.signal.aborted) {
          this.error = this.ports.t('terminal.deleteSuggestionError');
          this.refresh(false);
        }
        throw error;
      })
      .finally(() => {
        if (this.allowed()) {
          this.refresh();
          this.ports.focus();
        }
      });
    this.mutations.add(task);
    void task.then(
      () => this.mutations.delete(task),
      () => this.mutations.delete(task),
    );
    return task;
  }
  requestAi(): Promise<void> {
    const input = this.input.snapshot(),
      ai = this.ports.ai();
    if (!this.allowed() || !input?.value || !ai)
      return Promise.reject(Error('TERMINAL_SUGGESTION_AI_UNAVAILABLE'));
    const metadata = ai.getSnapshot();
    if (
      metadata.status !== 'ready' ||
      metadata.baseline.generation !== this.ports.generation ||
      !metadata.baseline.models[0]
    )
      return Promise.reject(Error('TERMINAL_SUGGESTION_AI_UNAVAILABLE'));
    const cached = this.aiCache.get(input.value);
    if (cached) {
      this.refresh();
      return Promise.resolve();
    }
    // A canceled native/Engine call retains this slot until actual drain completes.
    if (this.aiTask) return Promise.reject(Error('TERMINAL_SUGGESTION_AI_BUSY'));
    const controller = new AbortController(),
      signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    this.currentAi = controller;
    this.error = undefined;
    this.refresh(true);
    const task = Promise.resolve()
      .then(async () => {
        signal.throwIfAborted();
        const response = await ai.suggestCommands(
          {
            modelId: metadata.baseline.models[0]!.id,
            generation: this.ports.generation,
            terminalId: this.ports.id,
            prefix: input.value,
          },
          signal,
        );
        signal.throwIfAborted();
        const current = this.input.snapshot();
        if (!this.allowed() || current?.value !== input.value) return;
        setBoundedSuggestionCache(
          this.aiCache,
          input.value,
          parseAiCommandSuggestions(response, input.value),
        );
      })
      .catch((error) => {
        if (!signal.aborted) {
          const failure = remoteErrorOf(error);
          this.error =
            failure?.code === 'ai/failure' && failure.details?.reason === 'expired'
              ? this.ports.t('app.aiSuggestionsTimeout')
              : this.ports.t('app.aiSuggestionsFailed', { detail: '' });
          this.refresh(false);
        }
        if (!signal.aborted) throw error;
      })
      .finally(() => {
        if (this.currentAi === controller) this.currentAi = undefined;
        if (this.aiTask === task) this.aiTask = undefined;
        if (!this.lifetime.signal.aborted) this.refresh();
      });
    this.aiTask = task;
    return task;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      this.dismiss();
      this.input.closePrompt();
      this.off();
      await Promise.allSettled([this.aiTask, ...this.mutations]);
      this.aiCache.clear();
    })());
  }
  private allowed(): boolean {
    const state = this.ports.sessions.getSnapshot();
    return (
      !this.lifetime.signal.aborted &&
      this.integrated &&
      !this.replaying &&
      this.ports.enabled() &&
      this.ports.active() &&
      state.status === 'ready' &&
      state.baseline.generation === this.ports.generation &&
      state.baseline.sessions.some(
        (session) => session.id === this.ports.id && session.state === 'ready',
      )
    );
  }
  private refresh(aiLoading = !!this.aiTask, aiError = this.error): void {
    const input = this.input.snapshot(),
      facts = this.ports.facts.getSnapshot(),
      position = this.ports.position();
    if (
      !this.allowed() ||
      !input?.value ||
      input.value !== input.value.trimStart() ||
      input.value.length > 256 ||
      !position
    ) {
      this.dismiss();
      return;
    }
    const history =
      facts.status === 'ready' && facts.baseline.generation === this.ports.generation
        ? historyPageFor(facts.baseline.history, 'frequency', input.value).items
        : [];
    const ai = this.ports.ai()?.getSnapshot(),
      aiAvailable =
        ai?.status === 'ready' &&
        ai.baseline.generation === this.ports.generation &&
        ai.baseline.models.length > 0;
    const items = rankTerminalCommandSuggestions(
      input.value,
      { history, ai: this.aiCache.get(input.value) },
      position.reverse,
    );
    if (!items.length && !aiAvailable && !aiLoading && !aiError) {
      this.publish(undefined);
      return;
    }
    this.publish({
      ...position,
      items,
      selectedIndex: -1,
      aiAvailable,
      aiLoading,
      ...(aiError ? { aiError } : {}),
    });
  }
  private publish(state: TerminalCommandSuggestionsState | undefined): void {
    this.state = state;
    if (!this.lifetime.signal.aborted) this.ports.changed(state);
  }
}
