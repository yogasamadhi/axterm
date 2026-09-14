import { describe, expect, it } from 'vitest';
import type { BookmarkTree, Host } from '../../packages/contracts/src';
import { parseCommandLineBatchOperation } from '../../apps/desktop/src/renderer/src/app/command-line-batch-operation';
import { translateAxterm } from '../../apps/desktop/src/renderer/src/i18n/core';

const x = (
  key: Parameters<typeof translateAxterm>[1],
  variables?: Parameters<typeof translateAxterm>[2],
) => translateAxterm('zh-CN', key, variables);

const tree = {
  revision: 1,
  etag: '"bookmark-tree-v1"',
  groups: [],
  bookmarks: [
    {
      id: '00000000-0000-4000-8000-000000000002',
      hostId: '00000000-0000-4000-8000-000000000001',
      protocol: 'ssh',
      position: 0,
      title: 'Production',
    },
  ],
} as unknown as BookmarkTree;
const hosts = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    hostname: 'server.test',
    port: 2222,
    username: 'operator',
  },
] as Host[];

describe('command-line batch operation', () => {
  it('accepts the native bounded operation document unchanged', () => {
    const request = {
      name: 'Release',
      bookmarkIds: ['00000000-0000-4000-8000-000000000002'],
      steps: [
        {
          id: '00000000-0000-4000-8000-000000000003',
          name: 'Health check',
          command: 'uptime',
          delayMs: 0,
          continueOnError: false,
        },
      ],
      concurrency: 1,
      connectionTimeoutMs: 30_000,
    };
    expect(
      parseCommandLineBatchOperation(JSON.stringify(request), 'release.json', tree, hosts, x),
    ).toEqual(request);
  });

  it('translates an Electerm command workflow through its saved SSH bookmark', () => {
    let sequence = 3;
    const request = parseCommandLineBatchOperation(
      JSON.stringify([
        {
          name: 'Deploy server',
          action: 'connect',
          params: {
            host: 'server.test',
            port: 2222,
            username: 'operator',
            password: 'ignored-inline-secret',
          },
        },
        { name: 'Prepare', action: 'command', command: 'mkdir -p /tmp/release', afterDelay: 20 },
        { name: 'Verify', action: 'command', command: 'test -d /tmp/release', prevDelay: 30 },
      ]),
      'workflow.json',
      tree,
      hosts,
      x,
      () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
    );
    expect(request).toMatchObject({
      name: 'Deploy server',
      bookmarkIds: ['00000000-0000-4000-8000-000000000002'],
      concurrency: 1,
      steps: [
        { name: 'Prepare', command: 'mkdir -p /tmp/release', delayMs: 50 },
        { name: 'Verify', command: 'test -d /tmp/release', delayMs: 0 },
      ],
    });
    expect(JSON.stringify(request)).not.toContain('ignored-inline-secret');
  });

  it('rejects Electerm file-transfer steps because they lack scoped file grants', () => {
    expect(() =>
      parseCommandLineBatchOperation(
        JSON.stringify([
          { action: 'connect', params: { host: 'server.test', port: 2222 } },
          { action: 'sftp_upload', localPath: '/tmp/a', remotePath: '/tmp/a' },
        ]),
        'workflow.json',
        tree,
        hosts,
        x,
      ),
    ).toThrow('文件授权');
  });
});
