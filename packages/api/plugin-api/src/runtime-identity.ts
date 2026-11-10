import type { DesktopLifecycleState } from './desktop-lifecycle.ts';
/** Non-secret, immutable launch identity shared by the runner and Desktop controller. */
export interface RuntimeIdentity {
  readonly profileName?: string;
  readonly recoveryMode?: true;
  readonly recoveryHome?: string;
  readonly runtimeId: string;
  readonly generation: string;
  readonly startedAt: string;
  readonly pid: number;
  readonly mode: 'desktop' | 'web' | 'headless';
  readonly appVersion: string;
}

export interface RuntimeHealth {
  readonly status: 'ok';
}
export interface RuntimeVersion {
  readonly apiVersion: 'v1';
  readonly appVersion: string;
}
export interface RuntimeMetadata {
  readonly recoveryMode?: true;
  readonly recoveryHome?: string;
  readonly runtimeId: string;
  readonly generation: string;
  readonly state: 'ready';
  readonly startedAt: string;
  readonly pid: number;
  readonly mode: 'desktop' | 'web' | 'headless';
}
export interface RuntimeStateData {
  readonly lifecycle?: DesktopLifecycleState;
  readonly health: RuntimeHealth;
  readonly version: RuntimeVersion;
  readonly metadata: RuntimeMetadata;
}

export interface RuntimeBaseline extends RuntimeStateData {
  readonly type: 'baseline';
}
export interface RuntimeReplacement extends RuntimeStateData {
  readonly type: 'replace';
}
export type RuntimeUpdate = RuntimeBaseline | RuntimeReplacement;
