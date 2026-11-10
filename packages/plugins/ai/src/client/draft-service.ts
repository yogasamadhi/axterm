import { RemoteError } from '@axterm/plugin-api';
import { z } from 'zod';
import { aiTerminalThemeDraftSchema } from '@axterm/plugin-api/ai';
import { terminalThemeInputSchema } from '@axterm/plugin-api/terminals';
import type { AiThemeUi, AiCommandSuggestionsUi } from '@axterm/ui/workspace';
import type { AiModel } from './index.ts';
import type { AiRunModel } from './run-model.ts';
import { AiRunAdmissions, type AdmittedAiRun } from './run-admissions.ts';
const inputSchema = z
  .object({
    modelId: z.uuid(),
    prompt: z.string().trim().min(1).max(16384),
    draft: terminalThemeInputSchema.optional(),
  })
  .strict();
type Model = Pick<
  AiModel,
  | 'getSnapshot'
  | 'subscribe'
  | 'retry'
  | 'startRun'
  | 'getRun'
  | 'getRunCommandOutcome'
  | 'cancelRun'
  | 'drainRun'
> & {
  openRun(
    id: string,
  ): Promise<Pick<AiRunModel, 'getSnapshot' | 'subscribe' | 'dispose' | 'generation'>>;
};
/** AI owns admission, selected log and real execution cleanup. The editor receives no Engine handle. */
export class AiDraftService implements AiThemeUi, AiCommandSuggestionsUi {
  private readonly admissions: AiRunAdmissions;
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly drains = new Map<string, string>();
  private closing: Promise<void> | undefined;
  constructor(private readonly model: Model) {
    this.admissions = new AiRunAdmissions(model);
  }
  getSnapshot = () => this.model.getSnapshot();
  subscribe = (listener: () => void) => this.model.subscribe(listener);
  retry = () => this.model.retry();
  generateTheme(input: Parameters<AiThemeUi['generateTheme']>[0], caller?: AbortSignal) {
    const request = inputSchema.parse(input);
    return this.generate(
      {
        ...request,
        useCase: 'createTheme',
        context: request.draft ? JSON.stringify(request.draft) : '',
        parse: (output: string) => {
          const text = output
            .trim()
            .replace(/^```(?:json)?\s*/iu, '')
            .replace(/\s*```$/u, '');
          try {
            return aiTerminalThemeDraftSchema.parse(JSON.parse(text));
          } catch {
            throw Error('AI_THEME_OUTPUT_INVALID');
          }
        },
      },
      caller,
    );
  }
  suggestCommands(
    input: Parameters<AiCommandSuggestionsUi['suggestCommands']>[0],
    caller?: AbortSignal,
  ): Promise<string> {
    const request = z
      .object({
        modelId: z.uuid(),
        generation: z.uuid(),
        terminalId: z.uuid(),
        prefix: z
          .string()
          .min(1)
          .max(256)
          .refine((value) =>
            [...value].every(
              (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
            ),
          ),
      })
      .strict()
      .parse(input);
    return this.generate(
      {
        ...request,
        useCase: 'generateCommand',
        prompt:
          'Return at most five shell commands that begin with the exact user prefix. Return only a JSON string array. User prefix: ' +
          JSON.stringify(request.prefix),
        context: '',
        parse: (output: string) => output,
      },
      caller,
    );
  }
  private generate<T>(
    request: {
      modelId: string;
      prompt: string;
      context: string;
      useCase: 'createTheme' | 'generateCommand';
      generation?: string;
      terminalId?: string;
      parse(output: string): T;
    },
    caller?: AbortSignal,
  ): Promise<T> {
    if (this.lifetime.signal.aborted) throw Error('AI_THEME_CLOSED');
    if (this.pending.size + this.drains.size >= 4) throw Error('AI_THEME_CAPACITY');
    caller?.throwIfAborted();
    const initial = this.model.getSnapshot();
    if (initial.status !== 'ready') throw Error('AI_THEME_UNAVAILABLE');
    if (request.generation && request.generation !== initial.baseline.generation)
      throw Error('AI_DRAFT_RETIRED');
    if (this.admissions.hasUnresolvedAdmissions(initial.baseline.generation))
      throw Error('AI_THEME_OUTCOME_UNCERTAIN');
    const generation = initial.baseline.generation,
      context = request.context;
    if (new TextEncoder().encode(context).byteLength > 65536)
      throw Error('AI_THEME_INPUT_TOO_LARGE');
    const abort = new AbortController(),
      signal = AbortSignal.any([abort.signal, this.lifetime.signal, ...(caller ? [caller] : [])]);
    const timer = setTimeout(
      () =>
        abort.abort(
          request.useCase === 'generateCommand'
            ? new RemoteError('ai/failure', 'AI suggestion deadline expired', { reason: 'expired' })
            : Error('AI_THEME_TIMEOUT'),
        ),
      request.useCase === 'generateCommand' ? 20000 : 30000,
    );
    const off = this.model.subscribe(() => {
      const current = this.model.getSnapshot();
      if (current.status === 'ready' && current.baseline.generation !== generation)
        abort.abort(Error('AI_THEME_RETIRED'));
    });
    const task = Promise.resolve()
      .then(async () => {
        let owned: AdmittedAiRun | undefined,
          log: Awaited<ReturnType<Model['openRun']>> | undefined,
          completed = false;
        try {
          signal.throwIfAborted();
          owned = await this.admissions.start({
            modelId: request.modelId,
            mode: 'chat',
            useCase: request.useCase,
            ...(request.terminalId ? { terminalId: request.terminalId } : {}),
            prompt: request.prompt,
            context,
            includeConversationHistory: false,
          });
          signal.throwIfAborted();
          log = await this.model.openRun(owned.run.id);
          signal.throwIfAborted();
          if (log.generation !== generation) throw Error('AI_THEME_RETIRED');
          const visible = await this.wait(log, signal),
            run = visible.run;
          if (run.state !== 'succeeded' || !visible.output)
            throw Error(
              run.errorCode === 'AI_OUTPUT_INVALID' ? 'AI_THEME_OUTPUT_INVALID' : 'AI_THEME_FAILED',
            );
          if (new TextEncoder().encode(visible.output).byteLength > 65536)
            throw Error('AI_THEME_OUTPUT_TOO_LARGE');
          const draft = request.parse(visible.output);
          signal.throwIfAborted();
          completed = true;
          return draft;
        } finally {
          try {
            if (owned) {
              this.drains.set(owned.run.id, owned.generation);
              if (!completed) await this.admissions.cancel(owned);
              await this.drain(owned.run.id, owned.generation);
            }
          } finally {
            await log?.dispose();
            if (completed) signal.throwIfAborted();
          }
        }
      })
      .finally(() => {
        clearTimeout(timer);
        off();
      });
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort();
    const closing = (async () => {
      await Promise.allSettled([...this.pending]);
      await this.admissions.close();
      await Promise.allSettled(
        [...this.drains].map(([id, generation]) => this.drain(id, generation)),
      );
      if (this.drains.size) throw Error('AI_THEME_DRAIN_FAILED');
    })();
    this.closing = closing;
    void closing.catch(() => {
      if (this.closing === closing) this.closing = undefined;
    });
    return closing;
  }
  private async drain(id: string, generation: string): Promise<void> {
    this.drains.set(id, generation);
    const current = this.model.getSnapshot();
    if (current.status !== 'ready' || current.baseline.generation === generation)
      await this.model.drainRun(id, generation);
    this.drains.delete(id);
  }
  private wait(log: Awaited<ReturnType<Model['openRun']>>, signal: AbortSignal) {
    return new Promise<ReturnType<typeof log.getSnapshot>['visible']>((resolve, reject) => {
      let off = () => {},
        settled = false;
      const finish = (apply: () => void) => {
        if (settled) return;
        settled = true;
        off();
        signal.removeEventListener('abort', aborted);
        apply();
      };
      const check = () => {
        const current = log.getSnapshot();
        if (current.status === 'error') finish(() => reject(Error('AI_THEME_LOG_UNAVAILABLE')));
        else if (['succeeded', 'failed', 'canceled'].includes(current.visible.run.state))
          finish(() => resolve(current.visible));
      };
      const aborted = () => finish(() => reject(signal.reason ?? Error('AI_THEME_CANCELED')));
      off = log.subscribe(check);
      if (settled) off();
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
      else check();
    });
  }
}
