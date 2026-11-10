import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import ts from 'typescript';
import {
  inspectStyleSource,
  inspectInlineStyle,
  mapCssVariables,
  themeDirectory,
} from './level3-style-policy.mjs';

/** Domain/layout producers declare geometry; they do not acquire theme palette ownership. */
export function inlineGeometryDefinitions(path, source) {
  const names = new Set();
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function walk(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'setProperty' &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text.startsWith('--ax-')
    )
      names.add(node.arguments[0].text);
    if (
      ts.isPropertyAssignment(node) &&
      ts.isStringLiteral(node.name) &&
      node.name.text.startsWith('--ax-')
    )
      names.add(node.name.text);
    ts.forEachChild(node, walk);
  }
  walk(tree);
  return names;
}
export function checkStyleOwnership(root = resolve(import.meta.dirname, '..')) {
  const styles = globSync(
    ['packages/{api,infra,plugins}/**/src/**/*.css', 'apps/web/src/**/*.css'],
    { cwd: root },
  ).sort();
  const sources = globSync(
    ['packages/{api,infra,plugins}/**/src/**/*.{ts,tsx}', 'apps/web/src/**/*.{ts,tsx}'],
    {
      cwd: root,
    },
  ).sort();
  const definitions = new Set();
  const errors = [];
  for (const path of styles)
    postcss.parse(readFileSync(resolve(root, path), 'utf8'), { from: path }).walkDecls((decl) => {
      if (decl.prop.startsWith('--ax-')) definitions.add(decl.prop);
    });
  for (const path of sources)
    for (const name of inlineGeometryDefinitions(path, readFileSync(resolve(root, path), 'utf8')))
      definitions.add(name);
  for (const path of styles)
    errors.push(
      ...inspectStyleSource(path, readFileSync(resolve(root, path), 'utf8'), definitions),
    );
  for (const path of sources)
    errors.push(
      ...inspectInlineStyle(path, readFileSync(resolve(root, path), 'utf8'), definitions),
    );
  // Theme roles may depend on each other, but never on missing or legacy palette entries.
  for (const path of styles.filter((path) => path.startsWith(themeDirectory))) {
    postcss.parse(readFileSync(resolve(root, path), 'utf8')).walkDecls((decl) => {
      mapCssVariables(decl.value, (name, fallback) => {
        if (!name.startsWith('--ax-') || !definitions.has(name))
          errors.push(`${path}: Undefined theme dependency: ${name}`);
        return `var(${name}${fallback === undefined ? '' : ', ' + fallback})`;
      });
    });
  }
  if (errors.length) throw Error([...new Set(errors)].join('\n'));
  return { styles: styles.length, sourceFiles: sources.length, definitions: definitions.size };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkStyleOwnership();
  console.info(
    `Theme ownership passed: ${result.styles} CSS Modules and ${result.sourceFiles} sources.`,
  );
}
