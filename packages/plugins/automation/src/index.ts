import { assertWidgetAuthority } from './adapters/widget-authority.ts';
import { NodeLocalFileServer } from './adapters/widgets/node-local-file-server.ts';
import { NodeLocalFtpServer } from './adapters/widgets/node-local-ftp-server.ts';
import { NodeLocalSshServer } from './adapters/widgets/node-local-ssh-server.ts';
import { NodeMcpServer } from './adapters/widgets/node-mcp-server.ts';
import { WidgetServers } from './application/widgets.ts';
import { WidgetCommands } from './adapters/widget-commands.ts';
import type { CredentialMutationMarker } from '@axterm/plugin-api/saved-credentials';
import { FileRenamer } from './application/file-renamer.ts';
import { GrantedFileRenamer } from './adapters/file-renamer.ts';
import { BatchOperationRepository } from './adapters/batch-repository.ts';
import { BatchCommands } from './adapters/batch-commands.ts';
import { BatchOperationService } from './application/batches.ts';
import {
  Remote,
  RemoteError,
  remoteErrorOf,
  StorageCommandError,
  TypertRemoteService,
} from '@axterm/plugin-api';
import type { AutomationOwner } from '@axterm/plugin-api/host';
import type { Context } from '@deepseek-ai/cordis';
import { z, ZodError } from 'zod';
import type * as Contract from '@axterm/plugin-api/automation';
import {
  quickCommandGroupInputSchema,
  quickCommandInputSchema,
  triggerRuleInputSchema,
} from '@axterm/plugin-api/automation';
import { productDomains } from '@axterm/data-schema';
import { idSchema } from '@axterm/plugin-api/catalog';
import { AutomationStorage } from './adapters/storage.ts';
import { QuickCommandRepository } from './adapters/quick-command-repository.ts';
import { TriggerRepository } from './adapters/trigger-repository.ts';
import { QuickCommandService } from './application/quick-commands.ts';
import { TriggerService } from './application/triggers.ts';
import { AutomationFacts } from './adapters/facts.ts';
import { AutomationObservation } from './observation.ts';
import { ApplicationError } from './application/errors.ts';
declare module '@deepseek-ai/cordis' {
  interface Context {
    automationController: AutomationController;
  }
}
export class AutomationController extends TypertRemoteService {
  private readonly lifetime = new AbortController();
  private closing?: Promise<void>;
  private failedRefresh = false;
  private readonly poll: ReturnType<typeof setInterval>;
  resourceSnapshot(): Readonly<Record<string, number>> {
    return Object.freeze({
      batchOperations: this.batches.resourceCount(),
      triggerSessions: this.facts.triggers.resourceCount(),
      renamerTasks: this.renamer.resourceCount(),
      automationFollowers: this.observation.resourceCount(),
      ...(this.widgets?.resourceSnapshot() ?? {}),
    });
  }
  constructor(
    ctx: Context,
    private readonly facts: AutomationFacts,
    private readonly observation: AutomationObservation,
    private readonly batches: BatchOperationService,
    private readonly batchCommands: BatchCommands,
    private readonly renamer: FileRenamer,
    private readonly widgets?: WidgetServers,
  ) {
    super(ctx, 'automationController', { namespace: 'automation' });
    ctx.inject(['remoteEvents'], (events) => {
      events.remoteEvents.register({ event: 'automation/trigger-fired', mode: 'emit' });
      events.remoteEvents.register({ event: 'automation/trigger-session-disabled', mode: 'emit' });
    });
    const reload = () => {
      try {
        facts.triggers.refreshFromStorage();
        this.failedRefresh = false;
      } catch {
        if (!this.failedRefresh) console.warn('AUTOMATION_RULE_REFRESH_FAILED');
        this.failedRefresh = true;
      }
    };
    const timer = (this.poll = setInterval(reload, 250));
    timer.unref();
    ctx.effect(() => () => clearInterval(timer));
    ctx.effect(() => () => this.close());
    ctx.desktopTaskInspection.register('automation', {
      inspect: (signal) => {
        signal.throwIfAborted();
        if (this.failedRefresh) throw new Error('AUTOMATION_STATE_UNAVAILABLE');
        return {
          active:
            facts.triggers.resourceCount() > 0 ||
            batches.resourceCount() > 0 ||
            renamer.resourceCount() > 0 ||
            !!widgets?.active(),
        };
      },
      dispose: () => this.close(),
    });
  }
  @Remote({ mode: 'stream' }) watchWidgets(
    signal: AbortSignal,
  ): AsyncIterable<Contract.WidgetUpdate> {
    if (!this.widgets) throw this.failure('unavailable');
    return this.widgets.watch(AbortSignal.any([signal, this.lifetime.signal]));
  }
  @Remote async releaseWidgetCredential(
    key: string,
    generation: string,
    ref: string,
    createdBy: CredentialMutationMarker,
  ): Promise<void> {
    if (generation !== this.ctx.runtimeIdentity.generation) throw this.failure('conflict');
    const owner = this.ctx.get('temporaryCredentials');
    if (!owner) throw this.failure('unavailable');
    return owner.removeOwned(key, generation, ref, createdBy);
  }
  @Remote async getWidgetCommandOutcome(
    key: string,
    generation: string,
  ): Promise<Contract.WidgetCommandOutcome> {
    if (!this.widgets) throw this.failure('unavailable');
    return this.widgets.outcome(key, generation);
  }
  @Remote async startLocalFileServerWidget(
    key: string,
    generation: string,
    input: Contract.StartLocalFileServerInput,
  ): Promise<Contract.WidgetCommandOutcome> {
    if (!this.widgets) throw this.failure('unavailable');
    return this.widgets.start(key, generation, 'local-file-server', input);
  }
  @Remote async startLocalFtpServerWidget(
    key: string,
    generation: string,
    input: Contract.StartLocalFtpServerInput,
  ): Promise<Contract.WidgetCommandOutcome> {
    if (!this.widgets) throw this.failure('unavailable');
    return this.widgets.start(key, generation, 'local-ftp-server', input);
  }
  @Remote async startLocalSshServerWidget(
    key: string,
    generation: string,
    input: Contract.StartLocalSshServerInput,
  ): Promise<Contract.WidgetCommandOutcome> {
    if (!this.widgets) throw this.failure('unavailable');
    return this.widgets.start(key, generation, 'local-ssh-server', input);
  }
  @Remote async startMcpServerWidget(
    key: string,
    generation: string,
    input: Contract.StartMcpServerInput,
  ): Promise<Contract.WidgetCommandOutcome> {
    if (!this.widgets) throw this.failure('unavailable');
    return this.widgets.start(key, generation, 'mcp-server', input);
  }
  @Remote async renameWidgetInstance(
    key: string,
    generation: string,
    id: string,
    input: Contract.RenameWidgetInstanceInput,
  ): Promise<Contract.WidgetCommandOutcome> {
    if (!this.widgets) throw this.failure('unavailable');
    return this.widgets.rename(key, generation, id, input);
  }
  @Remote async stopWidgetInstance(
    key: string,
    generation: string,
    id: string,
  ): Promise<Contract.WidgetCommandOutcome> {
    if (!this.widgets) throw this.failure('unavailable');
    return this.widgets.stop(key, generation, id);
  }
  configurationAccess<T>(operation: () => T): T {
    if (this.lifetime.signal.aborted) throw this.failure('closed');
    return operation();
  }
  @Remote async previewFileRename(
    input: Contract.PreviewFileRenameInput,
  ): Promise<Contract.FileRenamePreview> {
    return this.run(() => this.renamer.preview(input));
  }
  @Remote async runFileRename(
    key: string,
    id: string,
    signal: AbortSignal,
  ): Promise<Contract.FileRenameResult> {
    return this.run(() => this.renamer.run(key, idSchema.parse(id), signal));
  }
  @Remote async discardFileRename(id: string): Promise<void> {
    return this.run(() => this.renamer.discard(idSchema.parse(id)));
  }
  @Remote async recoverFileRename(id: string, grantId: string): Promise<void> {
    return this.run(() =>
      this.renamer.recover(idSchema.parse(id), z.string().min(1).max(256).parse(grantId)),
    );
  }
  @Remote({ mode: 'stream' }) watchFileRenames(
    signal: AbortSignal,
  ): AsyncIterable<Contract.RenameUpdate> {
    return this.renamer.watch(AbortSignal.any([signal, this.lifetime.signal]));
  }
  @Remote async getQuickCommands(): Promise<Contract.QuickCommandTree> {
    return this.run(() => this.facts.quickCommands.snapshot());
  }
  @Remote async getTriggers(): Promise<Contract.TriggerCollection> {
    return this.run(() => this.facts.triggers.snapshot());
  }
  @Remote async createQuickCommandGroup(
    key: string,
    input: Contract.QuickCommandGroupInput,
    ifMatch: string | undefined,
  ): Promise<Contract.AutomationReceipt> {
    return this.run(() => this.facts.createGroup(key, input, ifMatch));
  }
  @Remote({ resources: { quickCommandGroup: (_key: string, id: string) => id } })
  async updateQuickCommandGroup(
    key: string,
    id: string,
    input: Contract.QuickCommandGroupPatch,
    ifMatch: string | undefined,
  ): Promise<Contract.AutomationReceipt> {
    return this.run(() => this.facts.updateGroup(key, idSchema.parse(id), input, ifMatch));
  }
  @Remote({ resources: { quickCommandGroup: (_key: string, id: string) => id } })
  async deleteQuickCommandGroup(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Promise<Contract.AutomationReceipt> {
    return this.run(() => this.facts.deleteGroup(key, idSchema.parse(id), ifMatch));
  }
  @Remote async createQuickCommand(
    key: string,
    input: Contract.QuickCommandInput,
    ifMatch: string | undefined,
  ): Promise<Contract.AutomationReceipt> {
    return this.run(() => this.facts.createCommand(key, input, ifMatch));
  }
  @Remote({ resources: { quickCommand: (_key: string, id: string) => id } })
  async updateQuickCommand(
    key: string,
    id: string,
    input: Contract.QuickCommandPatch,
    ifMatch: string | undefined,
  ): Promise<Contract.AutomationReceipt> {
    return this.run(() => this.facts.updateCommand(key, idSchema.parse(id), input, ifMatch));
  }
  @Remote({ resources: { quickCommand: (_key: string, id: string) => id } })
  async deleteQuickCommand(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Promise<Contract.AutomationReceipt> {
    return this.run(() => this.facts.deleteCommand(key, idSchema.parse(id), ifMatch));
  }
  @Remote async moveQuickCommand(
    key: string,
    input: Contract.MoveQuickCommandTreeNodeInput,
    ifMatch: string | undefined,
  ): Promise<Contract.AutomationReceipt> {
    return this.run(() => this.facts.move(key, input, ifMatch));
  }
  @Remote async createTrigger(
    key: string,
    input: Contract.TriggerRuleInput,
    ifMatch: string | undefined,
  ): Promise<Contract.AutomationReceipt> {
    return this.run(() => this.facts.createTrigger(key, input, ifMatch));
  }
  @Remote({ resources: { trigger: (_key: string, id: string) => id } }) async updateTrigger(
    key: string,
    id: string,
    input: Contract.TriggerRulePatch,
    ifMatch: string | undefined,
  ): Promise<Contract.AutomationReceipt> {
    return this.run(() => this.facts.updateTrigger(key, idSchema.parse(id), input, ifMatch));
  }
  @Remote({ resources: { trigger: (_key: string, id: string) => id } }) async deleteTrigger(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Promise<Contract.AutomationReceipt> {
    return this.run(() => this.facts.deleteTrigger(key, idSchema.parse(id), ifMatch));
  }
  @Remote async replaceTriggers(
    key: string,
    input: Contract.TriggerRuleInput[],
    ifMatch: string | undefined,
  ): Promise<Contract.AutomationReceipt> {
    return this.run(() => this.facts.replaceTriggers(key, input, ifMatch));
  }
  @Remote async listBatchOperations(): Promise<Contract.BatchOperation[]> {
    return this.run(() => this.batches.list());
  }
  @Remote({ resources: { batchOperation: (id: string) => id } }) async getBatchOperation(
    id: string,
  ): Promise<Contract.BatchOperation> {
    return this.run(() => this.batches.get(idSchema.parse(id)));
  }
  @Remote async createBatchOperation(
    key: string,
    input: Contract.CreateBatchOperationInput,
    generation: string,
  ): Promise<Contract.AutomationReceipt> {
    if (generation !== this.ctx.runtimeIdentity.generation) throw this.failure('conflict');
    return this.run(() => this.batchCommands.create(key, input));
  }
  @Remote({ resources: { batchOperation: (_key: string, id: string) => id } })
  async cancelBatchOperation(
    key: string,
    id: string,
    generation: string,
  ): Promise<Contract.AutomationReceipt> {
    if (generation !== this.ctx.runtimeIdentity.generation) throw this.failure('conflict');
    return this.run(() => this.batchCommands.cancel(key, idSchema.parse(id)));
  }
  @Remote async clearCompletedBatchOperations(
    key: string,
    generation: string,
  ): Promise<Contract.AutomationReceipt & { cleared: number }> {
    if (generation !== this.ctx.runtimeIdentity.generation) throw this.failure('conflict');
    return this.run(() => this.batchCommands.clearCompleted(key));
  }
  @Remote({ mode: 'stream' }) watchAutomation(
    signal: AbortSignal,
  ): AsyncIterable<Contract.AutomationUpdate> {
    if (this.lifetime.signal.aborted) throw this.failure('closed');
    return this.observation.watch(AbortSignal.any([signal, this.lifetime.signal]));
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      clearInterval(this.poll);
      this.facts.triggers.close();
      await Promise.all([this.batches.closeAll(), this.renamer.close(), this.widgets?.close()]);
      await this.observation.dispose();
    })());
  }
  private failure(reason: Contract.AutomationFailureReason): RemoteError<'automation/failure'> {
    return new RemoteError('automation/failure', 'The automation operation failed', { reason });
  }
  private async run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.lifetime.signal.aborted) throw this.failure('closed');
    try {
      return await operation();
    } catch (error) {
      const remote = remoteErrorOf(error);
      if (remote?.code === 'automation/failure') throw remote;
      if (error instanceof StorageCommandError)
        throw this.failure(
          ['conflict', 'receipt-expired', 'invalid-input', 'capacity'].includes(error.code)
            ? (error.code as Contract.AutomationFailureReason)
            : 'unavailable',
        );
      if (error instanceof ZodError) throw this.failure('invalid-input');
      if (error instanceof ApplicationError) {
        const reasons: Partial<Record<ApplicationError['code'], Contract.AutomationFailureReason>> =
          {
            NOT_FOUND: 'not-found',
            PRECONDITION_REQUIRED: 'precondition-required',
            PRECONDITION_FAILED: 'precondition-failed',
            VALIDATION_ERROR: 'invalid-input',
            INVALID_STATE: 'conflict',
            CONFLICT: 'conflict',
            CAPACITY_EXCEEDED: 'capacity',
            PAYLOAD_TOO_LARGE: 'capacity',
          };
        throw this.failure(reasons[error.code] ?? 'unavailable');
      }
      throw this.failure('unavailable');
    }
  }
}
export const inject = [
  'runtimeIdentity',
  'storage',
  'storageDomain',
  'catalog',
  'terminals',
  'connections',
  'desktopTaskInspection',
];
export async function apply(ctx: Context, raw: unknown): Promise<void> {
  const { profile } = z
    .object({ profile: z.string().min(1).max(128) })
    .strict()
    .parse(raw);
  const opening = ctx.storage.domain.open(productDomains.automation);
  const owned: { controller?: AutomationController } = {};
  ctx.effect(() => async () => {
    await owned.controller?.close();
    await (await opening.catch(() => undefined))?.close();
  });
  const domain = await opening;
  const sql = new AutomationStorage(domain);
  sql.assertBounds();
  const quick = new QuickCommandService(new QuickCommandRepository(sql));
  const triggers = new TriggerService(
    new TriggerRepository(sql),
    ctx.terminals,
    {
      publish(type, payload) {
        if (type === 'trigger.fired' && 'triggerId' in payload)
          ctx.emit('automation/trigger-fired', payload);
        else if (type === 'trigger.session-disabled' && 'errorCode' in payload)
          ctx.emit('automation/trigger-session-disabled', payload);
      },
    },
    ctx.catalog,
  );
  ctx.effect(() => () => triggers.close());
  const batchRepository = new BatchOperationRepository(
    sql,
    profile,
    ctx.runtimeIdentity.generation,
  );
  const batches = new BatchOperationService(batchRepository, ctx.catalog, ctx.connections);
  ctx.effect(() => () => batches.closeAll());
  const batchCommands = new BatchCommands(domain, batches, (operation) =>
    ctx.storage.domain.transaction([domain.participant, ctx.catalog.participant], operation),
  );
  const facts = new AutomationFacts(domain, sql, quick, triggers);
  const observation = new AutomationObservation(domain, () => ({
    generation: ctx.runtimeIdentity.generation,
    cursor: domain.cursor(),
    quickCommands: quick.snapshot(),
    triggers: triggers.snapshot(),
    batches: batches.list(),
  }));
  const renamer = new FileRenamer(
    ctx.runtimeIdentity.generation,
    new GrantedFileRenamer(() => {
      const grants = ctx.get('fileGrants');
      if (!grants)
        throw new RemoteError('automation/failure', 'Native file grants are unavailable', {
          reason: 'unavailable',
        });
      return grants;
    }),
  );
  ctx.effect(() => () => renamer.close());
  const widgets = new WidgetServers(
    ctx,
    ctx.runtimeIdentity.generation,
    {
      assertAuthority: assertWidgetAuthority,
      file: new NodeLocalFileServer(),
      ftp: new NodeLocalFtpServer(),
      ssh: (subprocess) => new NodeLocalSshServer(subprocess),
      mcp: new NodeMcpServer(),
    },
    new WidgetCommands(domain, profile, ctx.runtimeIdentity.generation),
  );
  ctx.effect(() => () => widgets.close());
  ctx.inject(['aiMcpTools'], (scope) => {
    scope.effect(() => () => widgets.stopMcp());
  });
  const controller = new AutomationController(
    ctx,
    facts,
    observation,
    batches,
    batchCommands,
    renamer,
    widgets,
  );
  owned.controller = controller;
  const automationOwner: AutomationOwner = {
    participant: domain.participant,
    configurationImport: {
      quickCommands: {
        snapshot: () => controller.configurationAccess(() => quick.snapshot()),
        createGroup(input, ifMatch) {
          return controller.configurationAccess(() =>
            quick.createGroup(quickCommandGroupInputSchema.parse(input), ifMatch),
          );
        },
        createCommand(input, ifMatch) {
          return controller.configurationAccess(() =>
            quick.createCommand(quickCommandInputSchema.parse(input), ifMatch),
          );
        },
      },
      triggers: {
        snapshot: () => controller.configurationAccess(() => triggers.snapshot()),
        create(input, ifMatch) {
          return controller.configurationAccess(() =>
            triggers.create(triggerRuleInputSchema.parse(input), ifMatch),
          );
        },
      },
    },
    getQuickCommands: () => quick.snapshot(),
    getTriggers: () => triggers.snapshot(),
    importQuickCommands: (value, ifMatch) => {
      quick.replacePortable(value, ifMatch);
    },
    importTriggers: (value, ifMatch) => {
      triggers.replace(value, ifMatch);
    },
  };
  ctx.provide('automation', automationOwner);
}
