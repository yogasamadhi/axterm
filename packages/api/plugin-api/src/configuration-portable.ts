import { z } from 'zod';
import {
  axtermConfigurationPreviewSchema,
  type AxtermConfigurationPreview,
} from './schemas/axterm-configuration.ts';
export * from './schemas/axterm-configuration.ts';
import type {} from './types.ts';
export type ConfigurationPortableFailure =
  | 'invalid-input'
  | 'not-found'
  | 'conflict'
  | 'stale'
  | 'closed'
  | 'unavailable'
  | 'capacity'
  | 'cancelled'
  | 'receipt-expired';
declare module './types.ts' {
  interface RemoteErrorDetailsMap {
    'configuration/portable-failure': { readonly reason: ConfigurationPortableFailure };
  }
}

export const configurationPortableSnapshotSchema = z
  .object({ previews: z.array(axtermConfigurationPreviewSchema).max(4) })
  .strict();
export interface ConfigurationPortableBaseline {
  readonly generation: string;
  readonly cursor: number;
  readonly previews: readonly AxtermConfigurationPreview[];
}
export type { SettingsUpdate as ConfigurationPortableUpdate } from './configuration.ts';

export const CONFIGURATION_PORTABLE_CHUNK_CHARACTERS = 16_384;
export const CONFIGURATION_PORTABLE_MAX_SNAPSHOT_BYTES = 1024 * 1024;

export const CONFIGURATION_EXPORT_PATH = '/api/configuration/files/export';
export const CONFIGURATION_INSPECT_PATH = '/api/configuration/files/inspect';
export const CONFIGURATION_PREVIEW_PATH = '/api/configuration/files/preview';
export const CONFIGURATION_MAX_FILE_BYTES = 16 * 1024 * 1024;

export const configurationPortableFailureSchema = z.enum([
  'invalid-input',
  'not-found',
  'conflict',
  'stale',
  'closed',
  'unavailable',
  'capacity',
  'cancelled',
  'receipt-expired',
]);
