// Frozen Axterm sync-v1 hash algorithm. Changing ordering requires a format migration.
import { createHash } from 'node:crypto';
export const stableHash = (value: unknown): string =>
  createHash('sha256').update(stableJson(value)).digest('hex');
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ':' + stableJson(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
