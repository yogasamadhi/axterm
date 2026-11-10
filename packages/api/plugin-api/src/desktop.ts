import { z } from 'zod';
import type { RuntimeMetadata } from './runtime-identity.ts';
export type * from './runtime-identity.ts';
export * from './desktop-window.ts';
declare module '@deepseek-ai/cordis' {
  interface Events {
    'desktop/runtime-state'(metadata: RuntimeMetadata): void;
  }
}
declare module './index.ts' {
  interface TypertRemoteEventSelection {
    'desktop/runtime-state': true;
  }
}

/** Same HTTP/HTTPS-only external target policy at Client, Host and shell boundaries. */
export const externalHttpUrlSchema = z
  .string()
  .max(4096)
  .url()
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.codePointAt(0)!;
        return code > 0x20 && code !== 0x7f;
      }) && /^https?:\/\//iu.test(value),
    'Unsafe external URL',
  )
  .transform((value) => new URL(value).href);
declare module './types.ts' {
  interface RemoteErrorDetailsMap {
    'desktop/failure': {
      readonly reason:
        | 'invalid-input'
        | 'stale'
        | 'unavailable'
        | 'closed'
        | 'capacity'
        | 'uncertain'
        | 'conflict'
        | 'receipt-expired';
    };
  }
}
/** A Profile-local decision, containing neither native source input nor an executable workflow. */
export interface DesktopStartupDecision {
  readonly generation: string;
  readonly phase: 'waiting' | 'ready' | 'native' | 'configured' | 'claimed';
}

export * from './desktop-updater.ts';

export type * from './desktop-diagnostics.ts';

export * from './desktop-lifecycle.ts';
