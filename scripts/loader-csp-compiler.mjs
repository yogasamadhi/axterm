/** Compile one pinned literal Function constructor into an application-owned classic asset.
 * No framework source, package output, service or expression implementation is replaced.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import ts from 'typescript';
export const LOADER_EVALUATOR_KEY = '__AXTERM_PINNED_LOADER_EVALUATOR__';
function constructor(source) {
  const file = ts.createSourceFile(
      'loader.js',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    ),
    matches = [];
  const walk = (node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Function'
    )
      matches.push(node);
    ts.forEachChild(node, walk);
  };
  walk(file);
  const node = matches[0],
    args = node?.arguments;
  if (
    matches.length !== 1 ||
    args?.length !== 3 ||
    !args.every(ts.isStringLiteralLike) ||
    args[0].text !== 'ctx' ||
    args[1].text !== 'expr'
  )
    throw Error('LOADER_CSP_CONSTRUCTOR_CHANGED');
  return { node, body: args[2].text };
}
export function compilePinnedLoader(source, pinnedSource, fileName = 'loader.js') {
  const expected = constructor(pinnedSource),
    actual = constructor(source);
  if (actual.body !== expected.body) throw Error('LOADER_CSP_EVALUATOR_CHANGED');
  const global = () =>
    ts.factory.createPropertyAccessExpression(
      ts.factory.createIdentifier('globalThis'),
      LOADER_EVALUATOR_KEY,
    );
  const failure = () =>
    ts.factory.createCallExpression(
      ts.factory.createParenthesizedExpression(
        ts.factory.createArrowFunction(
          undefined,
          undefined,
          [],
          undefined,
          ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
          ts.factory.createBlock(
            [
              ts.factory.createThrowStatement(
                ts.factory.createNewExpression(ts.factory.createIdentifier('Error'), undefined, [
                  ts.factory.createStringLiteral('CLIENT_LOADER_EVALUATOR_MISSING'),
                ]),
              ),
            ],
            true,
          ),
        ),
      ),
      undefined,
      [],
    );
  const result = ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.ESNext,
      sourceMap: true,
    },
    transformers: {
      before: [
        (context) => (root) => {
          const visit = (node) =>
            ts.isNewExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === 'Function'
              ? ts.factory.createConditionalExpression(
                  ts.factory.createBinaryExpression(
                    ts.factory.createTypeOfExpression(global()),
                    ts.factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
                    ts.factory.createStringLiteral('function'),
                  ),
                  ts.factory.createToken(ts.SyntaxKind.QuestionToken),
                  global(),
                  ts.factory.createToken(ts.SyntaxKind.ColonToken),
                  failure(),
                )
              : ts.visitEachChild(node, visit, context);
          return ts.visitNode(root, visit);
        },
      ],
    },
  });
  const asset = `/*! Generated from pinned @deepseek-ai/cordis-plugin-loader (MIT); original source and license remain in the framework snapshot. */\nObject.defineProperty(globalThis,${JSON.stringify(LOADER_EVALUATOR_KEY)},{value:(function anonymous(ctx,expr\n) {\n${actual.body}\n}),writable:false,configurable:false,enumerable:false});\n`;
  return { code: result.outputText, map: JSON.parse(result.sourceMapText), asset };
}
export function loaderCspCompiler(root) {
  const entry = realpathSync(resolve(root, 'packages/framework/loader/lib/index.js')),
    pinned = readFileSync(resolve(root, 'packages/framework/loader/src/config/utils.ts'), 'utf8');
  let asset;
  return {
    name: 'axterm-pinned-loader-csp-compiler',
    apply: 'build',
    enforce: 'pre',
    transform(source, id) {
      if (id.split('?')[0].replaceAll('\\', '/') !== entry.replaceAll('\\', '/')) return null;
      const compiled = compilePinnedLoader(source, pinned, entry);
      asset = compiled.asset;
      return { code: compiled.code, map: compiled.map };
    },
    transformIndexHtml(_html, context) {
      if (basename(context.filename) !== 'index.html') return [];
      return [
        { tag: 'script', attrs: { src: './assets/loader-evaluator.js' }, injectTo: 'head-prepend' },
      ];
    },
    generateBundle() {
      if (!asset) throw Error('LOADER_CSP_COMPILER_NOT_USED');
      this.emitFile({ type: 'asset', fileName: 'assets/loader-evaluator.js', source: asset });
    },
  };
}
