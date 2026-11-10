import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { RemoteError, remoteErrorOf } from '../../packages/api/plugin-api/src/remote-error.ts';
import { isRemoteJsonValue } from '../../packages/api/plugin-api/src/json-value.ts';

const execute = promisify(execFile);
it('keeps standard Remote decorators executable after compilation and hides unmarked methods', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-remote-marker-'));
  try {
    const url = pathToFileURL(resolve('packages/api/plugin-api/lib/index.js')).href;
    const result = ts.transpileModule(
      `
      import {Remote,remoteMethods,bindTypertRemote} from ${JSON.stringify(url)};
      class Catalog {
        @Remote('list') read(){return ['one'];}
        privateInternal(){return 'private';}
      }
      const service=new Catalog();
      const methods=remoteMethods(service);
      methods[0].exportName='attempted mutation';
      let invalid=false;try{bindTypertRemote(service,'../catalog');}catch{invalid=true;}
      console.log(JSON.stringify({methods:remoteMethods(service).map(({method,exportName})=>({method,exportName})),invalid}));
    `,
      { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } },
    );
    const entry = join(root, 'remote.mjs');
    await writeFile(entry, result.outputText);
    const { stdout } = await execute(process.execPath, [entry], { timeout: 5000 });
    expect(JSON.parse(stdout.trim())).toEqual({
      methods: [{ method: 'read', exportName: 'list' }],
      invalid: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('preserves the typed failure marker across realm copies without serializing causes', () => {
  const failure = new RemoteError(
    'gateway/cancelled',
    'Cancelled',
    {},
    { cause: new Error('in-process cause') },
  );
  expect(remoteErrorOf(failure)?.code).toBe('gateway/cancelled');
  expect(
    remoteErrorOf({ isAXTERMRemoteError: true, code: 'gateway/internal', details: {} })?.code,
  ).toBe('gateway/internal');
  expect(remoteErrorOf({ code: 'gateway/internal' })).toBeUndefined();
  expect(JSON.stringify(failure)).not.toContain('in-process cause');
});

it('rejects non-JSON and cyclic values at the Remote boundary', () => {
  const cycle: unknown[] = [];
  cycle.push(cycle);
  for (const value of [cycle, NaN, Infinity, () => {}, 1n, new Uint8Array([1])])
    expect(isRemoteJsonValue(value)).toBe(false);
  expect(isRemoteJsonValue({ items: [null, true, 1, 'text'] })).toBe(true);
});
