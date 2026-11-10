import type {
  EngineCapabilities,
  EngineDescriptor,
  EngineEvent,
  EngineRunInput,
  EngineSessionInput,
  EngineSessionHandle,
  EngineToolRequest,
  EngineToolResult,
  EngineExecutionOptions,
} from '../index.ts';
export type * from '../index.ts';
/** Host callbacks must be awaited. No internal reasoning event is admitted. */
export interface EngineRunContext {
  readonly signal: AbortSignal;
  /** Immutable bounded execution configuration. The selected provider validates its own format. */
  readonly configuration?: EngineExecutionOptions['configuration'];
  emit(event: EngineEvent): Promise<void>;
  tool(request: EngineToolRequest): Promise<EngineToolResult>;
}
/** An execution handle, never the authoritative application Session. */
export interface EngineProviderSession {
  run(input: EngineRunInput, context: EngineRunContext): Promise<void>;
  /** Must stop and join underlying resources, even if user cancellation is unsupported. */
  close(): Promise<void>;
}
export interface EngineProvider {
  readonly label: string;
  readonly capabilities: EngineCapabilities;
  openSession(input: EngineSessionInput, signal: AbortSignal): Promise<EngineProviderSession>;
}
export interface EnginesService {
  /** Registration belongs to the calling plugin and registry. Dispose waits for all resources. */
  register(id: string, provider: EngineProvider): () => Promise<void>;
  list(): readonly EngineDescriptor[];
  /** Exact id only; missing/unavailable/unsupported resume fails without fallback. */
  openSession(
    engineId: string,
    input: EngineSessionInput,
    signal?: AbortSignal,
  ): Promise<EngineSessionHandle>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    engines: EnginesService;
  }
}
