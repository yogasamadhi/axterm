import { z } from 'zod';
import { DomainCommands } from '@axterm/infra-storage-domain';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import {
  aiProviderInputSchema,
  aiProviderPatchSchema,
  aiProviderSchema,
  aiModelInputSchema,
  aiModelPatchSchema,
  aiModelSchema,
  aiConversationInputSchema,
  aiConversationPatchSchema,
  type AiProviderInput,
  type AiProviderPatch,
  type AiProvider,
  type AiModelInput,
  type AiModelPatch,
  type AiModel,
  type AiConversationInput,
  type AiConversationPatch,
  type AiReceipt,
} from '@axterm/plugin-api/ai';
import { ApplicationError } from '../application/errors.ts';
import type { AiRepository } from './repository.ts';
/** Only synchronous facts and outbox run under these receipts. IO/cancellation happens after commit. */
export class AiCommands {
  private readonly commands: DomainCommands;
  constructor(
    private readonly domain: RelationalDomain,
    private readonly repository: AiRepository,
    private readonly generation: string,
    private readonly profile: string,
  ) {
    this.commands = new DomainCommands(domain, 'axterm_ai_command_receipts');
  }
  createProvider(key: string, generation: string, input: AiProviderInput): AiReceipt {
    const parsed = aiProviderInputSchema.parse(input);
    return this.run(
      key,
      generation,
      'ai.provider.create',
      parsed,
      () => this.repository.createJson('ai_providers', parsed, 'ai-provider').id,
    );
  }
  updateProvider(
    key: string,
    generation: string,
    id: string,
    input: AiProviderPatch,
    ifMatch: string | undefined,
  ): AiReceipt {
    z.uuid().parse(id);
    const parsed = aiProviderPatchSchema.parse(input);
    return this.run(key, generation, 'ai.provider.update', { id, input: parsed, ifMatch }, () => {
      aiProviderSchema.parse({
        ...this.repository.getJson<AiProvider>('ai_providers', id),
        ...Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined)),
      });
      return this.repository.updateJson<AiProvider>(
        'ai_providers',
        id,
        parsed,
        ifMatch,
        'ai-provider',
      ).id;
    });
  }
  deleteProvider(
    key: string,
    generation: string,
    id: string,
    ifMatch: string | undefined,
  ): AiReceipt {
    z.uuid().parse(id);
    return this.run(key, generation, 'ai.provider.delete', { id, ifMatch }, () => {
      this.repository.deleteJson('ai_providers', id, ifMatch, 'ai-provider');
      return id;
    });
  }
  createModel(key: string, generation: string, input: AiModelInput): AiReceipt {
    const parsed = aiModelInputSchema.parse(input);
    return this.run(
      key,
      generation,
      'ai.model.create',
      parsed,
      () => this.repository.createJson('ai_models', parsed, 'ai-model').id,
    );
  }
  updateModel(
    key: string,
    generation: string,
    id: string,
    input: AiModelPatch,
    ifMatch: string | undefined,
  ): AiReceipt {
    z.uuid().parse(id);
    const parsed = aiModelPatchSchema.parse(input);
    return this.run(key, generation, 'ai.model.update', { id, input: parsed, ifMatch }, () => {
      aiModelSchema.parse({
        ...this.repository.getJson<AiModel>('ai_models', id),
        ...Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined)),
      });
      return this.repository.updateJson<AiModel>('ai_models', id, parsed, ifMatch, 'ai-model').id;
    });
  }
  deleteModel(key: string, generation: string, id: string, ifMatch: string | undefined): AiReceipt {
    z.uuid().parse(id);
    return this.run(key, generation, 'ai.model.delete', { id, ifMatch }, () => {
      this.repository.deleteJson('ai_models', id, ifMatch, 'ai-model');
      return id;
    });
  }
  createConversation(key: string, generation: string, input: AiConversationInput): AiReceipt {
    const parsed = aiConversationInputSchema.parse(input);
    return this.run(key, generation, 'ai.conversation.create', parsed, () => {
      this.repository.getJson<AiModel>('ai_models', parsed.modelId);
      return this.repository.createAiConversation(parsed).id;
    });
  }
  updateConversation(
    key: string,
    generation: string,
    id: string,
    input: AiConversationPatch,
    ifMatch: string | undefined,
  ): AiReceipt {
    z.uuid().parse(id);
    const parsed = aiConversationPatchSchema.parse(input);
    return this.run(
      key,
      generation,
      'ai.conversation.update',
      { id, input: parsed, ifMatch },
      () => {
        if (parsed.modelId) this.repository.getJson<AiModel>('ai_models', parsed.modelId);
        return this.repository.updateAiConversation(id, parsed, ifMatch).id;
      },
    );
  }
  deleteConversation(
    key: string,
    generation: string,
    id: string,
    ifMatch: string | undefined,
  ): AiReceipt & { cancelRunIds: readonly string[]; committed: boolean } {
    z.uuid().parse(id);
    let committed = false;
    let cancelRunIds: string[] = [];
    const receipt = this.run(key, generation, 'ai.conversation.delete', { id, ifMatch }, () => {
      const rows = this.domain.all<{
        id: string;
        profile_name: string | null;
        generation: string | null;
        owner_pid: number | null;
      }>(
        "SELECT r.id,i.profile_name,i.generation,i.owner_pid FROM ai_runs r LEFT JOIN axterm_ai_run_intents i ON i.run_id=r.id WHERE r.conversation_id=? AND r.state IN ('queued','running','waiting_approval') LIMIT 65",
        id,
      );
      if (rows.length > 64)
        throw new ApplicationError(
          'CAPACITY_EXCEEDED',
          'AI conversation activity capacity reached',
        );
      if (
        rows.some(
          (row) =>
            row.profile_name !== this.profile ||
            row.generation !== this.generation ||
            row.owner_pid !== process.pid,
        )
      )
        throw new ApplicationError('CONFLICT', 'Conversation is active in another Profile');
      cancelRunIds = rows.map((row) => row.id);
      this.repository.deleteAiConversation(id, ifMatch);
      committed = true;
      return id;
    });
    return { ...receipt, cancelRunIds, committed };
  }
  assertGeneration(generation: string): void {
    if (generation !== this.generation) throw new ApplicationError('CONFLICT', 'Stale generation');
  }
  private run(
    key: string,
    generation: string,
    operation: string,
    input: unknown,
    apply: () => string,
  ): AiReceipt {
    this.assertGeneration(generation);
    return this.commands.execute(key, operation, input, () => ({
      ids: [apply()],
      cursor: this.domain.cursor(),
    }));
  }
}
