import { describe, expect, it } from 'vitest';
import type { ConnectionHistoryItem } from '../../packages/api/plugin-api/src/catalog.ts';
import {
  connectionHistoryFrequency,
  connectionHistoryRelativeTime,
  connectionHistoryTarget,
} from '../../packages/plugins/catalog/src/client/ui/history-model.ts';
import { ownedTranslations } from '../fixtures/level3-owner-translations.ts';
import { dictionaries } from '../../packages/plugins/catalog/src/client/ui/locales.ts';
const translateAxterm = ownedTranslations('catalog', dictionaries);

const x = (
  key: Parameters<typeof translateAxterm>[1],
  variables?: Parameters<typeof translateAxterm>[2],
) => translateAxterm('zh-CN', key, variables);

const item: ConnectionHistoryItem = {
  id: '00000000-0000-4000-8000-000000000001',
  hostId: null,
  name: 'Production',
  hostname: 'server.example',
  port: 2202,
  username: 'operator',
  authType: 'agent',
  jumpHostId: null,
  connectionOptions: {
    connectionTimeoutMs: 50_000,
    keepaliveIntervalMs: 10_000,
    keepaliveCountMax: 10,
    compression: true,
    algorithms: { kex: [], cipher: [], serverHostKey: [], hmac: [] },
    reconnectPolicy: { mode: 'manual', delayMs: 3_000, maxAttempts: 10 },
  },
  count: 4,
  lastConnectedAt: '2026-09-12T00:00:00.000Z',
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
  version: 1,
};

describe('connection history presentation model', () => {
  it('projects only safe target metadata and the aggregate frequency', () => {
    expect(connectionHistoryTarget(item)).toBe('operator@server.example:2202');
    expect(connectionHistoryFrequency(item, x)).toBe('4 次连接');
    expect(connectionHistoryFrequency({ ...item, count: 1 }, x)).toBe('1 次连接');
    expect(
      JSON.stringify({
        target: connectionHistoryTarget(item),
        frequency: connectionHistoryFrequency(item, x),
      }),
    ).not.toMatch(/password|credential|private.?key/i);
  });

  it('formats bounded relative time without locale-dependent output', () => {
    const now = Date.parse('2026-09-12T03:00:00.000Z');
    expect(connectionHistoryRelativeTime('2026-09-12T02:59:40.000Z', x, now)).toBe('刚刚');
    expect(connectionHistoryRelativeTime('2026-09-12T02:30:00.000Z', x, now)).toBe('30 分钟前');
    expect(connectionHistoryRelativeTime(item.lastConnectedAt, x, now)).toBe('3 小时前');
    expect(connectionHistoryRelativeTime('invalid', x, now)).toBe('时间未知');
  });
});
