import type { PluginToolInput } from '@axterm/plugin-api/plugins';
/** Selected application commands; never an installer or a wait for package removal. */
export interface AiPluginManagementPort {
  readonly target: string;
  available(): boolean;
  invoke(
    id: string,
    generation: string,
    input: PluginToolInput,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
