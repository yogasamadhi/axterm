import { expect, it } from 'vitest';
import { inspectOperationMap } from '../../scripts/level3-operation-map.mjs';
import {
  inspectBindings,
  serviceMethods,
  clientServiceMethods,
} from '../../scripts/level3-operation-bindings.mjs';
import {
  checkSourceReview,
  inspectSourceReview,
} from '../../scripts/level3-operation-source-review.mjs';
const identity = {
  schemaVersion: 1,
  sourceCommit: 'f252e62c7841ba906f9d4cb73152cd55a3bea9b3',
  sourceClientSha256: '304c1e3771007e754efa9685953f39ae69186963aa428e3978781686b4676098',
};
const service = `import {Service} from '@deepseek-ai/cordis';export class HostConnectionService extends Service{constructor(ctx){super(ctx,'connection')}authorizeConnect(){return true}private hidden(){return true}static staticMethod(){return true}}`;
const client = `import type {Context} from '@deepseek-ai/cordis';export function installDesktopShortcuts(ctx:Context){const windowUi={getState(){return {}},act:()=>true};ctx.provide('desktopWindowUi',windowUi)}`;
function fixture() {
  const original = { operationId: 'authBootstrap', method: 'POST', path: '/api/v1/auth/bootstrap' };
  const binding = {
    kind: 'service',
    module: '@axterm/infra-connection',
    source: 'packages/infra/connection/src/rpc-host.ts',
    namespace: 'connection',
    className: 'HostConnectionService',
    methods: ['authorizeConnect'],
  };
  const row = {
    operationId: original.operationId,
    original: { method: original.method, path: original.path },
    state: 'bound',
    target: 'connection.authorizeConnect',
    replacements: [binding],
    semantics: 'POST /connect exchange through the owned authentication carrier.',
    finalAcceptance: 'Source binding only; package evidence remains required.',
  };
  const review = { ...identity, operations: [row] };
  const assets = {
    packages: new Map([['@axterm/infra-connection', 'packages/infra/connection']]),
    sources: new Map([[binding.source, service]]),
  };
  return {
    original,
    binding,
    row,
    review,
    assets,
    check: () => inspectSourceReview(review, [original], assets),
  };
}
it('checks all 264 real source bindings while leaving final package verification separate', async () => {
  expect(await checkSourceReview()).toEqual({ total: 264, bound: 264 });
});
it('requires an exported real Cordis Service key and public instance method body', () => {
  expect([...serviceMethods(service, 'HostConnectionService', 'connection')]).toEqual([
    'authorizeConnect',
  ]);
  for (const text of [
    service.replace("'@deepseek-ai/cordis'", "'@fake/core'"),
    service.replace("'connection'", 'dynamicKey'),
    service.replace('export class', 'class'),
    service.replace('authorizeConnect(){', 'private authorizeConnect(){'),
    service.replace("super(ctx,'connection')", 'super(ctx)'),
  ])
    expect(
      serviceMethods(text, 'HostConnectionService', 'connection').has('authorizeConnect'),
    ).toBe(false);
});
it('requires a selected object provided by the owning Context or one of its actual inject scopes', () => {
  expect([...clientServiceMethods(client, 'installDesktopShortcuts', 'desktopWindowUi')]).toEqual([
    'getState',
    'act',
  ]);
  const scoped = client.replace(
    "ctx.provide('desktopWindowUi',windowUi)",
    "ctx.inject(['ready'],scope=>scope.provide('desktopWindowUi',windowUi))",
  );
  expect(
    clientServiceMethods(scoped, 'installDesktopShortcuts', 'desktopWindowUi').has('act'),
  ).toBe(true);
  for (const text of [
    client.replace('const windowUi', 'let windowUi'),
    client.replace('ctx.provide', 'other.provide'),
    client.replace('ctx:Context', 'ctx:unknown'),
    client.replace("'@deepseek-ai/cordis'", "'@fake/core'"),
    client.replace('export function', 'function'),
    client.replace("'desktopWindowUi'", "'otherUi'"),
  ])
    expect(clientServiceMethods(text, 'installDesktopShortcuts', 'desktopWindowUi').size).toBe(0);
});
it('rejects frozen drift, gaps, omissions, fake owners and private or mismatched replacements', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.review.sourceCommit = 'changed';
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.original.path = '/changed';
    },
    (f: ReturnType<typeof fixture>) => {
      f.review.operations = [];
    },
    (f: ReturnType<typeof fixture>) => {
      f.review.operations.push(f.row);
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.state = 'gap';
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.semantics = '';
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.target = 'connection.fake';
    },
    (f: ReturnType<typeof fixture>) => {
      f.binding.module = '@axterm/other';
    },
    (f: ReturnType<typeof fixture>) => {
      f.binding.source = '../outside.ts';
    },
    (f: ReturnType<typeof fixture>) => {
      f.binding.methods = ['hidden'];
    },
    (f: ReturnType<typeof fixture>) => {
      f.binding.namespace = 'other';
    },
    (f: ReturnType<typeof fixture>) => {
      f.binding.className = 'OtherClass';
    },
    (f: ReturnType<typeof fixture>) => {
      f.binding.kind = 'arbitrary';
    },
  ]) {
    const f = fixture();
    mutate(f);
    expect(f.check().length).toBeGreaterThan(0);
  }
  expect(fixture().check()).toEqual([]);
});
it('retains real test and successful source-free package evidence requirements for non-Remote replacements', () => {
  const f = fixture(),
    test = 'tests/integration/fixture.test.ts',
    evidence = 'docs/implementation/evidence/fixture.json';
  const row = {
    ...f.original,
    namespace: 'desktop',
    target: f.row.target,
    transport: 'http-auth',
    state: 'verified',
    semantics: f.row.semantics,
    replacements: f.row.replacements,
    tests: [test],
    evidence: [evidence],
  };
  const map = {
    schemaVersion: 2,
    sourceCommit: identity.sourceCommit,
    sourceClientSha256: identity.sourceClientSha256,
    operations: [row],
  };
  const record = {
    checks: { scoped: { passedTests: 1 } },
    sourceFreeMacPackage: { passedTests: 1 },
  };
  const assets = {
    ...f.assets,
    remotes: new Map(),
    files: new Set([test]),
    evidence: new Map([[evidence, record]]),
  };
  expect(inspectOperationMap(map, [f.original], assets)).toEqual([]);
  record.sourceFreeMacPackage.passedTests = 0;
  expect(inspectOperationMap(map, [f.original], assets).length).toBeGreaterThan(0);
  record.sourceFreeMacPackage.passedTests = 1;
  assets.files.clear();
  expect(inspectOperationMap(map, [f.original], assets).length).toBeGreaterThan(0);
});
it('admits the existing pending window presentation mapping only for its exact operation and selected method', () => {
  const original = {
    operationId: 'getDesktopWindowState',
    method: 'GET',
    path: '/api/v1/desktop/window',
  };
  const row = {
    ...original,
    namespace: 'desktop',
    target: 'desktopWindowUi.getState',
    transport: 'native',
    state: 'pending',
    evidence: [],
  };
  const map = {
    schemaVersion: 2,
    sourceCommit: identity.sourceCommit,
    sourceClientSha256: identity.sourceClientSha256,
    operations: [row],
  };
  const assets = { packages: new Map(), remotes: new Map(), files: new Set(), evidence: new Map() };
  expect(inspectOperationMap(map, [original], assets)).toEqual([]);
  row.target = 'desktopWindowUi.act';
  expect(inspectOperationMap(map, [original], assets).length).toBeGreaterThan(0);
});
it('binds only the actual exported credential binary route and rejects ordinary or invented carriers', () => {
  const binding = {
    kind: 'binary-route',
    module: '@axterm/plugin-remote-desktop',
    source: 'packages/plugins/remote-desktop/src/adapters/binary-stream.ts',
    className: 'RemoteDesktopBinaryStream',
    pathSymbol: 'REMOTE_DESKTOP_CREDENTIAL_PATH',
  };
  const source = `import {REMOTE_DESKTOP_CREDENTIAL_PATH} from '@axterm/plugin-api/remote-desktop';export class RemoteDesktopBinaryStream{constructor(ctx){ctx.webServer.registerUpgrade({path:REMOTE_DESKTOP_CREDENTIAL_PATH,handler:(request)=>{return request}})}}`;
  const assets = {
    packages: new Map([[binding.module, 'packages/plugins/remote-desktop']]),
    sources: new Map([[binding.source, source]]),
  };
  expect(inspectBindings('claimVncSessionCredentials', [binding], assets).errors).toEqual([]);
  expect(inspectBindings('createHost', [binding], assets).errors.length).toBeGreaterThan(0);
  for (const text of [
    source.replace('export class', 'class'),
    source.replace('ctx.webServer', 'other.webServer'),
    source.replace('path:REMOTE_DESKTOP_CREDENTIAL_PATH', "path:'/invented'"),
    source.replace("'@axterm/plugin-api/remote-desktop'", "'@fake/protocol'"),
  ]) {
    assets.sources.set(binding.source, text);
    expect(
      inspectBindings('claimVncSessionCredentials', [binding], assets).errors.length,
    ).toBeGreaterThan(0);
  }
});
