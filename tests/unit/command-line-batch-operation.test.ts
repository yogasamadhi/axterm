import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCommandLineBatchOperation } from '../../apps/desktop/src/renderer/src/app/command-line-batch-operation';
import { translateAxterm } from '../../apps/desktop/src/renderer/src/i18n/core';

const x = (
  key: Parameters<typeof translateAxterm>[1],
  variables?: Parameters<typeof translateAxterm>[2],
) => translateAxterm('zh-CN', key, variables);

const nativeRequest = {
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

describe('command-line batch operation', () => {
  it('accepts only a valid native Axterm document, including a UTF-8 BOM', () => {
    expect(parseCommandLineBatchOperation(JSON.stringify(nativeRequest), x)).toEqual(nativeRequest);
    expect(parseCommandLineBatchOperation(`\uFEFF${JSON.stringify(nativeRequest)}`, x)).toEqual(
      nativeRequest,
    );
  });

  it('rejects Legacy Prototype JSON and CSV workflows without translating or persisting them', () => {
    const legacyJson = readFileSync(
      resolve('tests/fixtures/migration/synthetic-legacy-legacy-prototype-batch-operation-v1.json'),
      'utf8',
    );
    const legacyCsv = readFileSync(
      resolve('tests/fixtures/migration/legacy-prototype-v1.101.16-command-workflow-sanitized.csv'),
      'utf8',
    );
    expect(() => parseCommandLineBatchOperation(legacyJson, x)).toThrow(
      x('batchCli.invalidFormat'),
    );
    expect(() => parseCommandLineBatchOperation(legacyCsv, x)).toThrow(x('batchCli.invalidJson'));
  });

  it('rejects malformed JSON and invalid native documents', () => {
    expect(() => parseCommandLineBatchOperation('{', x)).toThrow(x('batchCli.invalidJson'));
    expect(() =>
      parseCommandLineBatchOperation(JSON.stringify({ ...nativeRequest, steps: [] }), x),
    ).toThrow(x('batchCli.invalidFormat'));
    expect(() => parseCommandLineBatchOperation(JSON.stringify([nativeRequest]), x)).toThrow(
      x('batchCli.invalidFormat'),
    );
  });

  it('limits document bytes before parsing', () => {
    expect(() => parseCommandLineBatchOperation('x'.repeat(2 * 1024 * 1024 + 1), x)).toThrow(
      x('batchCli.fileTooLarge'),
    );
  });
});
