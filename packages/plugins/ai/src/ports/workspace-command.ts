import type { AiWorkspace } from '@axterm/plugin-api/ai';
export interface WorkspaceExecutionFacts {
  shell: string;
  command: string;
  cwd: string | null;
  connectionId?: string;
  executable?: string;
  arguments?: string[];
}
export interface AiWorkspaceCommands {
  facts(command: string, workspace: AiWorkspace): WorkspaceExecutionFacts;
  execute(
    command: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
}
