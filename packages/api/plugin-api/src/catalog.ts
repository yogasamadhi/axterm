export {
  sshDiagnosticCodeSchema,
  sshDiagnosticFieldSchema,
  sshOperationDiagnosticSchema,
  type SshOperationDiagnostic,
} from './schemas/ssh-diagnostic.ts';
import type { SshOperationDiagnostic } from './schemas/ssh-diagnostic.ts';
import type { ClientFactsView } from './types.ts';
import type { Host, HostGroup } from './schemas/resources.ts';
import type {} from './index.ts';
import type {
  BookmarkTree,
  SshConfigImportResult,
  CreateSshBookmarkInput,
} from './schemas/bookmarks.ts';
import type { ConnectionProfile } from './schemas/connection-profiles.ts';
import type { ConnectionHistoryPage } from './schemas/connection-history.ts';
export * from './schemas/bookmarks.ts';
export * from './schemas/connection-profiles.ts';
export * from './schemas/connection-history.ts';
export {
  DEFAULT_SSH_CONNECTION_OPTIONS,
  DEFAULT_SSH_STARTUP,
  idSchema,
  timestampSchema,
  etagSchema,
  hostSchema,
  hostGroupSchema,
  hostProxySchema,
  createHostSchema,
  updateHostSchema,
  createHostGroupSchema,
  updateHostGroupSchema,
  sshAgentSchema,
  sshAlgorithmsSchema,
  sshStartupSchema,
  sshX11Schema,
  sshConnectionOptionsSchema,
  authTypeSchema,
} from './schemas/resources.ts';
export type {
  Host,
  HostGroup,
  HostProxyConfig,
  CreateHostInput,
  CreateHostGroupInput,
  UpdateHostInput,
} from './schemas/resources.ts';

export type CatalogFailureReason =
  | 'stale'
  | 'not-found'
  | 'precondition-required'
  | 'precondition-failed'
  | 'invalid-input'
  | 'conflict'
  | 'unavailable'
  | 'closed'
  | 'capacity'
  | 'receipt-expired'
  | 'internal';
export interface CatalogReceipt {
  readonly ids: readonly string[];
  readonly cursor: number;
  readonly version?: number;
  readonly treeRevision?: number;
  readonly deletedCount?: number;
}

/** Remote transports carry typed numbers; URL query coercion stays outside this contract. */
export interface CatalogHistoryQuery {
  readonly sort?: 'recent' | 'frequency';
  readonly limit?: number;
  readonly cursor?: string;
}
export type CatalogCollection =
  'hosts' | 'hostGroups' | 'bookmarks' | 'connectionProfiles' | 'history';
/** A generated, bounded transport envelope. Payloads are validated against their collection schema before publication. */
export type CatalogUpdate =
  | {
      readonly type: 'begin';
      readonly generation: string;
      readonly cursor: number;
      readonly mode: 'baseline' | 'delta';
      readonly collections: readonly CatalogCollection[];
    }
  | {
      readonly type: 'chunk';
      readonly collection: CatalogCollection;
      readonly offset: number;
      readonly text: string;
      readonly final: boolean;
    }
  | { readonly type: 'commit'; readonly cursor: number };

export interface CatalogBaseline {
  readonly generation: string;
  readonly cursor: number;
  readonly hosts: readonly Host[];
  readonly hostGroups: readonly HostGroup[];
  readonly bookmarks: BookmarkTree;
  readonly connectionProfiles: readonly ConnectionProfile[];
  readonly history: ConnectionHistoryPage;
}
export const CATALOG_CHUNK_CHARACTERS = 16_384;
export const CATALOG_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
declare module './types.ts' {
  interface RemoteErrorDetailsMap {
    'catalog/failure': {
      readonly reason: CatalogFailureReason;
      readonly diagnostic?: SshOperationDiagnostic;
    };
  }
}
import type { TypertResource } from './types.ts';
import type { z } from 'zod';
import type { updateHostGroupSchema } from './schemas/resources.ts';
export type UpdateHostGroupInput = z.input<typeof updateHostGroupSchema>;
declare module './index.ts' {
  interface TypertResourceMap {
    host: TypertResource<string>;
    hostGroup: TypertResource<string>;
    bookmark: TypertResource<string>;
    bookmarkGroup: TypertResource<string>;
    connectionProfile: TypertResource<string>;
    connectionHistory: TypertResource<string>;
    catalogImportReport: TypertResource<string>;
  }
}

/** Full previews/reports are pull-streamed; command outcomes stay compact and durable. */
export interface CatalogImportChunk {
  readonly offset: number;
  readonly text: string;
  readonly final: boolean;
}
export interface CatalogImportReceipt extends CatalogReceipt {
  readonly reportId: string;
  readonly summary: SshConfigImportResult['summary'];
}

/** Compact atomic outcome; full Host/Bookmark/history facts stay in their model. */
export interface CatalogHistoryPromotionReceipt extends CatalogReceipt {
  readonly hostId: string;
  readonly bookmarkId: string;
  readonly createdHost: boolean;
  readonly historyVersion: number;
}

/** Selected Client capability for explicit atomic bookmark creation; facts remain Catalog-owned. */
export interface CatalogClientActions extends ClientFactsView<CatalogBaseline> {
  createSshBookmark(
    key: string,
    input: CreateSshBookmarkInput,
    ifMatch: string | undefined,
  ): Promise<CatalogReceipt>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    catalogActions: CatalogClientActions;
  }
}
