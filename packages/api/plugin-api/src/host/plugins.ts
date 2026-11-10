import type {
  PluginInspection,
  PluginManagementSnapshot,
  PluginCommandInput,
  PluginCommandReceipt,
  PluginCommandOutcome,
  ManagedPluginPackage,
  ManagedPluginEntry,
  PluginChange,
  PendingPluginBuild,
} from '../plugins.ts';
/** Profile owner. Callers must obtain the user's explicit action; model calls require separate approval. */
export interface PluginManagerService {
  inspect(spec: string, signal?: AbortSignal, registry?: string): Promise<PluginInspection>;
  list(): readonly ManagedPluginPackage[];
  entries(): readonly ManagedPluginEntry[];
  install(
    spec: string,
    options?: { enabled?: boolean; replace?: boolean; signal?: AbortSignal; registry?: string },
  ): Promise<PluginChange>;
  remove(name: string, signal?: AbortSignal): Promise<PluginChange>;
  setBundleEnabled(name: string, enabled: boolean): Promise<PluginChange>;
  setPluginEnabled(id: string, enabled: boolean): Promise<PluginChange>;
  allowVersion(
    packageVersion: string,
    runtimeVersion: string,
    enabled: boolean,
    acceptRisk: boolean,
  ): Promise<PluginChange>;
  pendingBuilds(): Promise<readonly PendingPluginBuild[]>;
  approveBuilds(
    ids: readonly string[],
    approved: boolean,
    signal?: AbortSignal,
  ): Promise<PluginChange>;
  transactions(): Promise<readonly string[]>;
  inspectTasks(signal: AbortSignal): { active: boolean };
  /** Available only to offline management holding the Profile runtime lock. */
  repair(id: string): Promise<PluginChange>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    pluginManager: PluginManagerService;
  }
}

/** Durable admission only. Completion belongs to the package owner and is read through outcome(). */
export interface PluginCommandsService {
  readonly generation: string;
  snapshot(): Promise<PluginManagementSnapshot>;
  inspect(spec: string, signal?: AbortSignal, registry?: string): Promise<PluginInspection>;
  execute(id: string, generation: string, input: PluginCommandInput): Promise<PluginCommandReceipt>;
  outcome(id: string): PluginCommandOutcome;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    pluginCommands: PluginCommandsService;
  }
}
