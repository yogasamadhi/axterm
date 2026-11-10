import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** A source-only extension workspace using the actual SDK rather than a protocol stub. */
export function createRemoteWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'axterm-remote-workspace-'));
  const write = (name: string, value: unknown) => {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  };
  write('package.json', { name: 'remote-contract-fixture', private: true, type: 'module' });
  write('tsconfig.base.json', {
    compilerOptions: {
      target: 'ES2024',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noEmit: true,
      types: [],
      lib: ['ES2024', 'DOM', 'DOM.Iterable', 'ESNext.Disposable'],
      allowImportingTsExtensions: true,
      skipLibCheck: false,
      paths: {
        '@axterm/plugin-api': [resolve('packages/api/plugin-api/lib/types/index.d.ts')],
        '@deepseek-ai/cordis': [resolve('packages/framework/cordis/lib/types/index.d.ts')],
        '@fixture/catalog': ['./packages/catalog/src/index.ts'],
        '@fixture/catalog/types': ['./packages/catalog/src/types.ts'],
        '@fixture/catalog-remote': ['./packages/remote/src/index.ts'],
        '@fixture/catalog-remote/types': ['./packages/remote/src/types.ts'],
      },
    },
  });
  write('tsconfig.host.json', {
    extends: './tsconfig.base.json',
    dependencies: { zod: '4.4.3' },
    peerDependencies: { '@axterm/plugin-api': '0.10.0', '@deepseek-ai/cordis': '~4.1.0' },
    files: [],
    references: [{ path: './packages/catalog' }, { path: './packages/remote' }],
  });
  write('packages/catalog/package.json', {
    name: '@fixture/catalog',
    private: true,
    type: 'module',
    exports: { '.': './src/index.ts', './types': './src/types.ts' },
  });
  write('packages/remote/package.json', {
    name: '@fixture/catalog-remote',
    private: true,
    type: 'module',
    exports: {
      '.': './src/index.ts',
      './types': './src/types.ts',
      './typert': { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' },
      './remote': {
        types: './lib/typert.remote-client.d.ts',
        default: './lib/typert.remote-client.js',
      },
    },
    dependencies: { zod: '4.4.3' },
    peerDependencies: { '@axterm/plugin-api': '0.10.0', '@deepseek-ai/cordis': '~4.1.0' },
    files: [
      'lib/typert.host.js',
      'lib/typert.host.d.ts',
      'lib/typert.remote-client.js',
      'lib/typert.remote-client.d.ts',
    ],
  });
  for (const name of ['catalog', 'remote']) {
    write(`packages/${name}/tsconfig.json`, {
      extends: '../../tsconfig.base.json',
      include: ['src'],
    });
  }
  write('packages/catalog/src/types.ts', 'export type EntryId = string;\n');
  write(
    'packages/catalog/src/index.ts',
    `
import type { TypertContext, TypertLookup } from '@axterm/plugin-api';
import type { EntryId } from './types.ts';
export class Entry { constructor(readonly id: EntryId) {} }
declare module '@axterm/plugin-api' {
  interface TypertLookupMap { entry: TypertLookup<Entry, EntryId> }
  interface TypertContextMap { entry: TypertContext<EntryId> }
}
export type { EntryId } from './types.ts';
`,
  );
  write(
    'packages/remote/src/types.ts',
    `
import type { JsonValue } from '@axterm/plugin-api';
export interface CreateRequest { readonly title: string; readonly metadata?: JsonValue }
export interface EntryResult { readonly ref: string }
export interface RenameRequest { readonly title: string }
`,
  );
  write(
    'packages/remote/src/index.ts',
    `
import type { Context } from '@deepseek-ai/cordis';
import { Remote, RemoteScope, TypertRemoteService } from '@axterm/plugin-api';
import type { Entry } from '@fixture/catalog';
import type { CreateRequest, EntryResult, RenameRequest } from './types.ts';
export class CatalogController extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'catalog'); }
  @Remote
  async create(entry: Entry, request: CreateRequest, signal: AbortSignal): Promise<EntryResult> {
    signal.throwIfAborted();
    return { ref: entry.id + ':' + request.title };
  }
  @RemoteScope('entry')
  rename(request: RenameRequest): EntryResult { return { ref: request.title }; }
  @Remote({ mode: 'stream' })
  async *watch(entry: Entry, signal: AbortSignal): AsyncIterable<EntryResult> {
    signal.throwIfAborted();
    yield { ref: entry.id };
  }
  private localOnly(): string { return 'not exposed'; }
  unmarked(): string { return this.localOnly(); }
}
export type { CreateRequest, EntryResult, RenameRequest } from './types.ts';
`,
  );
  return root;
}
