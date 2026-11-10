import type { Context } from '@deepseek-ai/cordis';
import { defineDomain } from '@axterm/plugin-api';
import type { StorageBootstrapPlan } from '@axterm/plugin-api/host';
import { legacyMigrations } from './legacy-migrations.ts';
import { forwardMigrations } from './forward-migrations.ts';
export { legacyMigrations, SCHEMA_VERSION } from './legacy-migrations.ts';
/** The immutable generation-2 marker first exists in committed migration 41. */
export const GENERATION2_MIN_SCHEMA_VERSION = 41;
export {
  forwardMigrations,
  forwardTableNames,
  PRODUCT_SCHEMA_VERSION,
} from './forward-migrations.ts';
export const productDomains = {
  files: defineDomain({
    kind: 'relational',
    name: 'files',
    owner: '@axterm/plugin-files',
    version: 1,
    tables: ['axterm_file_operation_receipts'],
    migrations: [],
  }),
  catalog: defineDomain({
    kind: 'relational',
    name: 'catalog',
    owner: '@axterm/plugin-catalog',
    version: 3,
    tables: [
      'host_groups',
      'hosts',
      'host_auth_refs',
      'bookmark_groups',
      'bookmarks',
      'connection_profiles',
      'recent_connections',
      'axterm_catalog_revisions',
      'axterm_catalog_command_receipts',
      'axterm_catalog_import_reports',
    ],
    migrations: [
      { version: 2, sql: '-- Catalog ownership format after product migration 43.\nSELECT 1;' },
      { version: 3, sql: '-- Catalog import reports after product migration 51.\nSELECT 1;' },
    ],
  }),
  connections: defineDomain({
    kind: 'relational',
    name: 'connections',
    owner: '@axterm/plugin-connections',
    version: 2,
    tables: ['known_host_keys', 'tunnel_profiles', 'axterm_connection_command_receipts'],
    migrations: [
      { version: 2, sql: '-- Connections fact receipts after product migration 46.\nSELECT 1;' },
    ],
  }),
  configuration: defineDomain({
    kind: 'relational',
    name: 'configuration',
    owner: '@axterm/plugin-configuration',
    version: 4,
    tables: [
      'app_settings',
      'sync_profiles',
      'axterm_configuration_import_entries',
      'axterm_configuration_command_receipts',
      'axterm_credential_command_intents',
      'axterm_sync_run_intents',
    ],
    migrations: [
      {
        version: 2,
        sql: '-- Configuration ownership format after product migration 43.\nSELECT 1;',
      },
      {
        version: 3,
        sql: '-- Saved credential intent ownership after product migration 48.\nSELECT 1;',
      },
      { version: 4, sql: '-- Sync intent ownership after product migration 49.\nSELECT 1;' },
    ],
  }),
  automation: defineDomain({
    kind: 'relational',
    name: 'automation',
    owner: '@axterm/plugin-automation',
    version: 2,
    tables: [
      'quick_commands',
      'quick_command_groups',
      'batch_operations',
      'automation_triggers',
      'axterm_automation_revisions',
      'axterm_automation_command_receipts',
      'axterm_batch_ownership',
    ],
    migrations: [
      { version: 2, sql: '-- Automation ownership after product migration 47.\nSELECT 1;' },
    ],
  }),
  ai: defineDomain({
    kind: 'relational',
    name: 'ai',
    owner: '@axterm/plugin-ai',
    version: 2,
    tables: [
      'ai_providers',
      'ai_models',
      'ai_conversations',
      'ai_messages',
      'ai_runs',
      'ai_tool_calls',
      'ai_approvals',
      'axterm_ai_command_receipts',
      'axterm_ai_run_intents',
      'axterm_ai_run_log',
    ],
    migrations: [
      { version: 2, sql: '-- Application AI ownership after product migration 50.\nSELECT 1;' },
    ],
  }),
  desktop: defineDomain({
    kind: 'relational',
    name: 'desktop',
    owner: '@axterm/plugin-desktop',
    version: 2,
    tables: ['app_meta', 'axterm_desktop_preferences', 'axterm_desktop_command_receipts'],
    migrations: [
      { version: 2, sql: '-- Desktop preference ownership after product migration 55.\nSELECT 1;' },
    ],
  }),
  storage: defineDomain({
    kind: 'relational',
    name: 'storage',
    owner: '@axterm/infra-storage-relational',
    version: 1,
    tables: ['domain_events', 'idempotency_records'],
    migrations: [],
  }),
  terminals: defineDomain({
    kind: 'relational',
    name: 'terminals',
    owner: '@axterm/plugin-terminals',
    version: 3,
    tables: [
      'terminal_profiles',
      'terminal_themes',
      'command_history',
      'axterm_terminal_revisions',
      'axterm_terminal_command_receipts',
    ],
    migrations: [
      { version: 2, sql: '-- Terminal ownership format after product migration 43.\nSELECT 1;' },
      {
        version: 3,
        sql: '-- Terminal private stage ownership after product migration 52.\nSELECT 1;',
      },
    ],
  }),
  terminalAssets: defineDomain({
    kind: 'relational',
    name: 'terminal_assets',
    owner: '@axterm/plugin-terminals',
    version: 1,
    tables: [
      'terminal_background_assets',
      'terminal_background_asset_chunks',
      'axterm_terminal_asset_receipts',
    ],
    migrations: [],
  }),
  terminalTransferStages: defineDomain({
    kind: 'relational',
    name: 'terminal_transfer_stages',
    owner: '@axterm/plugin-terminals',
    version: 1,
    tables: ['axterm_terminal_stage_keys', 'axterm_terminal_stages'],
    migrations: [],
  }),
  transfers: defineDomain({
    kind: 'relational',
    name: 'transfers',
    owner: '@axterm/plugin-transfers',
    version: 2,
    tables: ['transfer_history', 'axterm_transfer_commands', 'axterm_transfer_fact_commands'],
    migrations: [
      { version: 2, sql: '-- Transfer ownership after product migration 45.\nSELECT 1;' },
    ],
  }),
} as const;
export const productBootstrap: StorageBootstrapPlan = Object.freeze({
  generation: 2,
  migrations: Object.freeze([...legacyMigrations, ...forwardMigrations]),
  tables: Object.values(productDomains).flatMap((spec) =>
    spec.tables.map((table) => ({ table, domain: spec.name, owner: spec.owner })),
  ),
});
export function apply(ctx: Context): void {
  ctx.provide('productSchema', productBootstrap);
}

export { copiedReferences, type CopiedReferences } from './copy.ts';
