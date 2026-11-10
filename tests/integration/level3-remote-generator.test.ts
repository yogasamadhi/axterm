import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import TypertRegistry from '@axterm/infra-typert-registry';
import { WorkspaceTypertGenerator, writeWorkspaceArtifacts } from '@axterm/remote-generator';
import type { TypertContribution, TypertRemoteContribution } from '@axterm/plugin-api';
import { createRemoteWorkspace } from '../support/level3-remote-workspace.ts';

const roots: string[] = [];
const contexts: Context[] = [];
function workspace(): string {
  const root = createRemoteWorkspace();
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function evaluateArtifact<Module>(source: string): Promise<Module> {
  const executable = source
    .replace(
      /from (['"])zod\1/g,
      `from ${JSON.stringify(new URL('../../packages/api/plugin-api/node_modules/zod/index.js', import.meta.url).href)}`,
    )
    .replace(
      /from (['"])@axterm\/plugin-api\/remote-info\1/g,
      `from ${JSON.stringify(new URL('../../packages/api/plugin-api/lib/remote-info.js', import.meta.url).href)}`,
    );
  return (await import(`data:text/javascript,${encodeURIComponent(executable)}`)) as Module;
}

it('generates executable strict codecs, scoped lookups and a browser-only typed consumer', async () => {
  const root = workspace();
  const generator = new WorkspaceTypertGenerator(root);
  expect(generator.discover()).toEqual([
    { package: '@fixture/catalog-remote', root: 'packages/remote', faces: ['host'] },
  ]);
  const artifacts = generator.generateContributors();
  expect(artifacts).toHaveLength(1);
  const artifact = artifacts[0]!;
  expect(artifact.remote).toBeDefined();
  expect(artifact.remote!.js).not.toMatch(/from ['"]@fixture\/catalog/);
  expect(artifact.remote!.dts).not.toContain("from '@fixture/catalog'");
  expect(artifact.remote!.dts).not.toContain('localOnly');
  expect(artifact.remote!.dts).not.toContain('unmarked');
  // Resolve only canonical pure runtime imports; execute generated code, not a test codec.
  const generated = await evaluateArtifact<{
    TYPERT_REMOTE: TypertRemoteContribution;
  }>(artifact.remote!.js);
  const host = await evaluateArtifact<{ TYPERT: TypertContribution }>(artifact.js);
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(TypertRegistry);
  const owner = ctx.plugin({
    inject: ['typert'],
    apply(ctx) {
      ctx.typert.register(host.TYPERT);
      ctx.typert.remotes.register(generated.TYPERT_REMOTE);
    },
  });
  await owner;
  expect(ctx.typert.local.get('catalog/create')).toBe(host.TYPERT.invocations[0]);
  expect(ctx.typert.remotes.get('catalog/create')).toBe(generated.TYPERT_REMOTE.descriptors[0]);
  await owner.dispose();
  expect(ctx.typert.local.get('catalog/create')).toBeUndefined();
  expect(ctx.typert.remotes.get('catalog/create')).toBeUndefined();
  expect(ctx.typert.listPackages()).toEqual([]);
  const descriptors = generated.TYPERT_REMOTE.descriptors;
  expect(descriptors.map((item) => item.id)).toEqual([
    '@fixture/catalog-remote#catalog/create',
    '@fixture/catalog-remote#catalog/rename',
    '@fixture/catalog-remote#catalog/watch',
  ]);
  const create = descriptors[0]!;
  expect(create.cancellation).toEqual({ parameter: 'signal' });
  expect(create.parameters[0]).toMatchObject({
    source: 'lookup',
    lookup: 'entry',
    wire: 'entryId',
  });
  const request = create.parameters[1]!.codec;
  if (request.mode !== 'strict') throw new Error('Missing generated input codec');
  expect(
    request.create().parse({ title: 'saved', metadata: { nested: [null, true, 1, 'x'] } }),
  ).toEqual({ title: 'saved', metadata: { nested: [null, true, 1, 'x'] } });
  for (const value of [{ title: 42 }, { title: 'saved', metadata: { nested: undefined } }])
    expect(() => request.create().parse(value)).toThrow();
  expect(descriptors[1]!.invocation).toMatchObject({
    kind: 'context',
    context: 'entry',
    wire: 'entryId',
  });
  expect(descriptors[2]!.mode).toBe('stream');
  if (create.result.mode !== 'strict') throw new Error('Missing generated output codec');
  expect(
    () => create.result.mode === 'strict' && create.result.create().parse({ ref: 5 }),
  ).toThrow();
  expect(generator.generateContributors()).toEqual(artifacts);
  writeWorkspaceArtifacts(root, artifacts);
  const config = JSON.parse(readFileSync(join(root, 'tsconfig.base.json'), 'utf8'));
  config.compilerOptions.paths['@fixture/catalog-remote/remote'] = [
    './packages/remote/lib/typert.remote-client.d.ts',
  ];
  writeFileSync(
    join(root, 'consumer.ts'),
    `
import '@fixture/catalog-remote/remote';
import type { TypertRemoteNamespaceMap, TypertRemoteScopeMap, RemoteResult, RemoteStreamHandle } from '@axterm/plugin-api';
declare const remote: TypertRemoteNamespaceMap;
const created: Promise<RemoteResult<{ readonly ref: string }>> = remote.catalog.create('entry-1', { title: 'saved' }, new AbortController().signal);
const watched: RemoteStreamHandle<{ readonly ref: string }, never> = remote.catalog.watch('entry-1');
declare const rename: TypertRemoteScopeMap['entry:catalog/rename'];
rename({ title: 'changed' });
// @ts-expect-error Host objects cannot enter the Client API.
remote.catalog.create({ id: 'entry-1' }, { title: 'saved' });
// @ts-expect-error Wrong input is rejected statically too.
remote.catalog.create('entry-1', { title: 5 });
// @ts-expect-error Undecorated implementation stays private.
remote.catalog.unmarked();
void created; void watched;
`,
  );
  config.files = ['./consumer.ts'];
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  expect(
    diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')),
  ).toEqual([]);
  expect(
    program
      .getSourceFiles()
      .some((file) => /(?:@types\/node|packages\/catalog\/src\/index)/.test(file.fileName)),
  ).toBe(false);
});

it.each([
  [
    'missing return annotation',
    (source: string) => source.replace(': Promise<EntryResult>', ''),
    /explicit type annotation/,
  ],
  [
    'private decorated method',
    (source: string) => source.replace('async create(', 'private async create('),
    /public instance method/,
  ],
  [
    'unconstrained wire input',
    (source: string) => source.replace('request: CreateRequest', 'request: unknown'),
    /unconstrained unknown/,
  ],
  [
    'wrong cancellation type',
    (source: string) => source.replace('signal: AbortSignal', 'signal: string'),
    /global AbortSignal/,
  ],
] as const)('rejects %s before emitting an extension API', (_name, edit, message) => {
  const root = workspace();
  const path = join(root, 'packages/remote/src/index.ts');
  writeFileSync(path, edit(readFileSync(path, 'utf8')));
  expect(() => new WorkspaceTypertGenerator(root, { checkDiagnostics: false }).generate()).toThrow(
    message,
  );
});

it.each([true, false])('refuses compiled workspace dependencies (output exists: %s)', (exists) => {
  const root = workspace();
  const configPath = join(root, 'tsconfig.base.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  delete config.compilerOptions.paths['@fixture/catalog'];
  writeFileSync(configPath, JSON.stringify(config));
  const catalog = join(root, 'packages/catalog');
  const manifestPath = join(catalog, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.exports['.'] = { types: './lib/types/index.d.ts', default: './lib/index.js' };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  mkdirSync(join(root, 'node_modules/@fixture'), { recursive: true });
  symlinkSync(catalog, join(root, 'node_modules/@fixture/catalog'), 'dir');
  if (exists) {
    mkdirSync(join(catalog, 'lib/types'), { recursive: true });
    writeFileSync(
      join(catalog, 'lib/types/index.d.ts'),
      'export declare class Entry { readonly id: string }',
    );
  }
  expect(() => new WorkspaceTypertGenerator(root, { checkDiagnostics: false }).generate()).toThrow(
    /(?:build output|cannot resolve workspace imports)/i,
  );
});
