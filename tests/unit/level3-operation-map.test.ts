import { expect, it } from 'vitest';
import {
  frozenOperations,
  remoteDeclarations,
  inspectOperationMap,
  inspectFinalOperationMap,
} from '../../scripts/level3-operation-map.mjs';
const source = `import {Remote as Rpc} from '@axterm/plugin-api';
class Owner extends Base { constructor(ctx){ super(ctx,'owner',{namespace:'catalog'}); }
@Rpc save(){return 1} @Rpc({mode:'stream'}) watch(){return []} @Rpc private hidden(){return 1} plain(){return 1} }`;
const evidencePath = 'docs/implementation/evidence/fixture.json';
const testPath = 'tests/integration/fixture.test.ts';
const ownerSource = 'packages/plugins/catalog/src/index.ts';
const original = { operationId: 'oldSave', method: 'POST', path: '/api/v1/save' };
function fixture() {
  const row = {
    ...original,
    namespace: 'catalog',
    target: 'catalog.save',
    transport: 'remote',
    state: 'verified',
    semantics: 'Same explicit durable save through its owning Controller.',
    replacements: [
      {
        module: '@axterm/plugin-catalog',
        source: ownerSource,
        namespace: 'catalog',
        methods: ['save', 'watch'],
      },
    ],
    tests: [testPath],
    evidence: [evidencePath],
  };
  const map = {
    schemaVersion: 2,
    sourceCommit: 'f252e62c7841ba906f9d4cb73152cd55a3bea9b3',
    sourceClientSha256: '304c1e3771007e754efa9685953f39ae69186963aa428e3978781686b4676098',
    operations: [row],
  };
  const assets = {
    packages: new Map([['@axterm/plugin-catalog', 'packages/plugins/catalog']]),
    remotes: new Map([[ownerSource, remoteDeclarations(source)]]),
    files: new Set([testPath]),
    evidence: new Map([
      [
        evidencePath,
        {
          schemaVersion: 1,
          checks: { scoped: { passedTests: 1 } },
          sourceFreeMacPackage: { passedTests: 1 },
        },
      ],
    ]),
  };
  return { map, row, assets, check: () => inspectOperationMap(map, [original], assets) };
}
it('rejects an otherwise valid pending record at the final repository boundary', () => {
  const f = fixture();
  expect(inspectFinalOperationMap(f.map, [original], f.assets)).toEqual([]);
  f.row.state = 'pending';
  f.row.evidence = [];
  delete (f.row as Partial<typeof f.row>).replacements;
  expect(f.check()).toEqual([]);
  expect(inspectFinalOperationMap(f.map, [original], f.assets)).toContain(
    'oldSave: final operation acceptance is incomplete',
  );
});
it('reads frozen HTTP identities and only canonical public Remote declarations from their owning namespace', () => {
  expect(
    frozenOperations(
      `export interface paths { '/frozen': {get: operations['read']; post?:never;} }`,
    ),
  ).toEqual([{ operationId: 'read', method: 'GET', path: '/frozen' }]);
  expect([...remoteDeclarations(source).keys()]).toEqual(['catalog.save', 'catalog.watch']);
  expect(remoteDeclarations(source.replace('@axterm/plugin-api', '@fixture/fake')).size).toBe(0);
  expect(
    remoteDeclarations(source.replace("namespace:'catalog'", 'namespace:runtimeValue')).size,
  ).toBe(0);
  expect(
    remoteDeclarations(
      source.replace("super(ctx,'owner',{namespace:'catalog'})", "super(ctx,'owner',{})"),
    ).size,
  ).toBe(0);
});
it('accepts actual shared/composed replacements without requiring fictional one-to-one method names', () => {
  const f = fixture();
  expect(f.check()).toEqual([]);
  const other = { ...f.row, operationId: 'anotherOldSave', path: '/another' };
  f.map.operations.push(other);
  expect(
    inspectOperationMap(
      f.map,
      [original, { ...original, operationId: 'anotherOldSave', path: '/another' }],
      f.assets,
    ),
  ).toEqual([]);
});
it('rejects frozen metadata drift, missing/duplicate operations and altered methods or paths', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.map.sourceCommit = 'changed';
    },
    (f: ReturnType<typeof fixture>) => {
      f.map.sourceClientSha256 = 'changed';
    },
    (f: ReturnType<typeof fixture>) => {
      f.map.operations = [];
    },
    (f: ReturnType<typeof fixture>) => {
      f.map.operations.push(f.row);
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.operationId = 'invented';
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.method = 'GET';
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.path = '/changed';
    },
  ]) {
    const f = fixture();
    mutate(f);
    expect(f.check().length).toBeGreaterThan(0);
  }
});
it('rejects nonexistent, private, non-Remote, wrong-owner and wrong-namespace implementations', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.row.replacements[0]!.methods = ['missing'];
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.replacements[0]!.methods = ['hidden'];
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.replacements[0]!.methods = ['plain'];
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.replacements[0]!.namespace = 'connections';
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.replacements[0]!.module = '@axterm/plugin-other';
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.replacements[0]!.source = 'packages/plugins/catalog/src/client/index.ts';
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.replacements[0]!.source = '../outside.ts';
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.target = 'catalog.fictional';
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.namespace = 'other';
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.replacements = [];
    },
  ]) {
    const f = fixture();
    mutate(f);
    expect(f.check().length).toBeGreaterThan(0);
  }
});
it('rejects absent or unsuccessful engineering evidence, missing tests and unsupported completion claims', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.row.evidence = [];
    },
    (f: ReturnType<typeof fixture>) => {
      f.assets.evidence.clear();
    },
    (f: ReturnType<typeof fixture>) => {
      f.assets.evidence.get(evidencePath)!.sourceFreeMacPackage.passedTests = 0;
    },
    (f: ReturnType<typeof fixture>) => {
      f.assets.evidence.get(evidencePath)!.checks.scoped.passedTests = 0;
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.tests = [];
    },
    (f: ReturnType<typeof fixture>) => {
      f.assets.files.clear();
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.semantics = '';
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.state = 'complete';
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.transport = 'unknown';
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.state = 'pending';
    },
  ]) {
    const f = fixture();
    mutate(f);
    expect(f.check().length).toBeGreaterThan(0);
  }
  const pending = fixture();
  pending.row.state = 'pending';
  pending.row.evidence = [];
  delete (pending.row as Partial<typeof pending.row>).replacements;
  expect(pending.check()).toEqual([]);
});
