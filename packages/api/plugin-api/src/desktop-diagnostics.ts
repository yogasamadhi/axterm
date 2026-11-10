import type { UpdaterStatus } from './desktop-updater.ts';
export interface DesktopDiagnostics {
  readonly generation: string;
  readonly uptimeSeconds: number;
  readonly resources: Readonly<Record<string, number>>;
  readonly database: 'ok';
  readonly updater: UpdaterStatus;
}
export interface DesktopDiagnosticLogs {
  readonly lines: readonly string[];
  readonly truncated: boolean;
}
export interface DesktopDiagnosticExport {
  readonly bytes: number;
  readonly createdAt: string;
}
export interface DesktopDiagnosticOutcome {
  readonly phase: 'not-found' | 'pending' | 'complete' | 'uncertain';
  readonly result?: DesktopDiagnosticExport;
}
export interface DesktopDiagnosticsBaseline {
  readonly type: 'baseline';
  readonly diagnostics: DesktopDiagnostics;
}
export interface DesktopDiagnosticsReplacement {
  readonly type: 'replace';
  readonly diagnostics: DesktopDiagnostics;
}
export type DesktopDiagnosticsUpdate = DesktopDiagnosticsBaseline | DesktopDiagnosticsReplacement;
