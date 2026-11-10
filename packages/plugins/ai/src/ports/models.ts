import type { AiProvider, AiSkill, PiCatalogProvider, AiRun } from '@axterm/plugin-api/ai';
import type { ModelProvider } from './model-provider.ts';
export interface AiModelProvider extends ModelProvider {
  listModels(signal?: AbortSignal): Promise<string[]>;
}
export interface AiModelsPort {
  supportsApplicationTools?(provider: AiProvider): boolean;
  skills(): AiSkill[];
  skillInstructions(useCase: AiRun['useCase']): string | undefined;
  catalog(): PiCatalogProvider[];
  create(provider: AiProvider, testModel?: string, signal?: AbortSignal): Promise<AiModelProvider>;
}
