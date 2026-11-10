import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import {
  compilePinnedLoader,
  loaderCspCompiler,
  LOADER_EVALUATOR_KEY,
} from '../../scripts/loader-csp-compiler.mjs';
const source = readFileSync('packages/framework/loader/src/config/utils.ts', 'utf8'),
  body = '\n  with (ctx) {\n    return eval(expr)\n  }\n',
  entry = `const evaluate = new Function('ctx','expr',${JSON.stringify(body)});globalThis.result=evaluate;`;
it('precompiles only the pinned literal constructor without writing the framework and retains its exact function source and scope semantics', () => {
  const compiled = compilePinnedLoader(entry, source),
    context = createContext({});
  runInContext(compiled.asset, context);
  runInContext(compiled.code, context);
  expect(context.result({ value: 7 }, 'value+2')).toBe(9);
  expect(context.result.toString()).toBe(Function('ctx', 'expr', body).toString());
  expect(Object.getOwnPropertyDescriptor(context, LOADER_EVALUATOR_KEY)).toMatchObject({
    writable: false,
    configurable: false,
    enumerable: false,
  });
  expect(readFileSync('packages/framework/loader/src/config/utils.ts', 'utf8')).toBe(source);
  expect(compiled.map.version).toBe(3);
});
it('starts the compiled constructor with runtime string compilation disabled and rejects a missing application asset', () => {
  const compiled = compilePinnedLoader(entry, source),
    context = createContext({}, { codeGeneration: { strings: false, wasm: false } });
  expect(() =>
    runInContext(
      compiled.code,
      createContext({}, { codeGeneration: { strings: false, wasm: false } }),
    ),
  ).toThrow('CLIENT_LOADER_EVALUATOR_MISSING');
  runInContext(compiled.asset, context);
  runInContext(compiled.code, context);
  expect(typeof context.result).toBe('function');
  expect(() => context.result({ value: 7 }, 'value+2')).toThrow(
    'Code generation from strings disallowed',
  );
});
it('refuses parameter/body drift, dynamic input and additional Function constructors instead of enabling a fallback', () => {
  for (const input of [
    entry.replace("'ctx'", "'other'"),
    "const evaluate=new Function('ctx','expr',untrusted);",
    entry + "new Function('untrusted');",
  ])
    expect(() => compilePinnedLoader(input, source)).toThrow('LOADER_CSP_CONSTRUCTOR_CHANGED');
  expect(() => compilePinnedLoader(entry.replace('eval(expr)', 'expr + 1'), source)).toThrow(
    'LOADER_CSP_EVALUATOR_CHANGED',
  );
});

it('leaves unrelated modules alone, rejects an unused compiler and emits only the derived application asset without changing framework package bytes', () => {
  const plugin = loaderCspCompiler(process.cwd()),
    emitFile = vi.fn();
  expect(plugin.transform('new Function(untrusted)', '/unrelated/index.js')).toBeNull();
  expect(() => plugin.generateBundle.call({ emitFile })).toThrow('LOADER_CSP_COMPILER_NOT_USED');
  const path = process.cwd() + '/packages/framework/loader/lib/index.js',
    before = readFileSync(path, 'utf8');
  expect(plugin.transform(before, path)).not.toBeNull();
  expect(plugin.transform(before, path.replaceAll('/', '\\') + '?module')).not.toBeNull();
  plugin.generateBundle.call({ emitFile });
  expect(emitFile).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'asset', fileName: 'assets/loader-evaluator.js' }),
  );
  expect(readFileSync(path, 'utf8')).toBe(before);
  expect(plugin.transformIndexHtml('', { filename: '/fixture/auth.html' })).toEqual([]);
  expect(plugin.transformIndexHtml('', { filename: '/fixture/index.html' })).toEqual([
    { tag: 'script', attrs: { src: './assets/loader-evaluator.js' }, injectTo: 'head-prepend' },
  ]);
});
