/** A domain-owned readonly task inspection plus its deterministic resource drain. */
export interface DesktopTaskContribution {
  inspect(signal: AbortSignal): { active: boolean } | Promise<{ active: boolean }>;
  dispose(): void | Promise<void>;
}
export interface DesktopTaskInspection {
  /** Registration belongs to both calling plugin and provider; disposal awaits the contributor's drain. */
  register(name: string, contribution: DesktopTaskContribution): () => Promise<void>;
  inspect(signal: AbortSignal): Promise<{ active: boolean }>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopTaskInspection: DesktopTaskInspection;
  }
}
