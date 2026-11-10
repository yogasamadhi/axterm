import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const printer = ts.createPrinter({ removeComments: true });
/** Retain every assertion expression and test declaration, including conditional skips. */
export function testSemantics(source) {
  const ast = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
  const assertions = [],
    declarations = [],
    conditions = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      if (node.expression.getText(ast) === 'expect') {
        let assertion = node;
        while (
          (ts.isPropertyAccessExpression(assertion.parent) ||
            ts.isCallExpression(assertion.parent)) &&
          assertion.parent.expression === assertion
        )
          assertion = assertion.parent;
        assertions.push(
          createHash('sha256')
            .update(printer.printNode(ts.EmitHint.Unspecified, assertion, ast))
            .digest('hex'),
        );
      }
      const name = node.expression.getText(ast);
      if (
        /^(it|test)\.(skip|skipIf|runIf|fixme|fail|failIf)$/.test(name) &&
        (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0]))
      )
        conditions.push(printer.printNode(ts.EmitHint.Unspecified, node, ast));
      if (/^(it|test)(\.|\()/.test(name) || /^(it|test)$/.test(name)) {
        if (
          node.arguments[0] &&
          (ts.isStringLiteralLike(node.arguments[0]) || ts.isTemplateExpression(node.arguments[0]))
        ) {
          declarations.push({
            name: ts.isTemplateExpression(node.arguments[0])
              ? 'computed:' + printer.printNode(ts.EmitHint.Unspecified, node.arguments[0], ast)
              : node.arguments[0].text,
            invocation: printer.printNode(ts.EmitHint.Unspecified, node.expression, ast),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { assertions, declarations, conditions };
}
export function inspectTestRetention(baseline, source, aliases = {}) {
  const current = testSemantics(source),
    errors = [];
  for (const [kind, expected, actual] of [
    ['assertion', baseline.assertions, current.assertions],
    ['condition', baseline.conditions ?? [], current.conditions],
    [
      'declaration',
      baseline.declarations.map((d) => JSON.stringify({ ...d, name: aliases[d.name] ?? d.name })),
      current.declarations.map((d) => JSON.stringify(d)),
    ],
  ]) {
    const available = [...actual];
    for (const value of expected) {
      const index = available.indexOf(value);
      if (index < 0) errors.push(`${kind} removed or changed: ${value}`);
      else available.splice(index, 1);
    }
  }
  return errors;
}
/** Explicit semantic replacements retain a named successor and its frozen assertions per old case. */
export function inspectSemanticReplacement(row, sources) {
  const errors = [],
    covered = new Set();
  const original = new Set(row.baseline.declarations.map((d) => d.name));
  if (!Array.isArray(row.replacements) || !row.replacements.length)
    return ['semantic successors missing'];
  for (const replacement of row.replacements) {
    const source = sources.get(replacement.path);
    if (typeof source !== 'string') {
      errors.push('successor source missing');
      continue;
    }
    if (!replacement.baseline?.declarations?.length || !replacement.baseline?.assertions?.length) {
      errors.push('successor baseline missing');
      continue;
    }
    errors.push(...inspectTestRetention(replacement.baseline, source));
    const current = new Set(testSemantics(source).declarations.map((d) => d.name));
    for (const mapping of replacement.cases ?? []) {
      if (!original.has(mapping.from) || !current.has(mapping.to) || !mapping.reason?.trim())
        errors.push('semantic case identity or explanation missing');
      else covered.add(mapping.from);
    }
  }
  for (const name of original)
    if (!covered.has(name)) errors.push('unmapped historical case: ' + name);
  return errors;
}
export async function checkTestRetention(
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
) {
  const manifest = JSON.parse(
    await readFile(resolve(root, 'tests/fixtures/engineering/level3/test-retirement.json'), 'utf8'),
  );
  const errors = [];
  for (const [file, expected] of Object.entries(manifest.frozenInputs ?? {})) {
    const actual = createHash('sha256')
      .update(await readFile(resolve(root, file)))
      .digest('hex');
    if (actual !== expected) errors.push(`${file}: frozen historical input changed`);
  }
  const seen = new Set();
  for (const row of manifest.tests) {
    if (seen.has(row.source)) errors.push(`${row.source}: duplicate retirement record`);
    seen.add(row.source);
    if (!['retired', 'retargeted', 'superseded', 'pending'].includes(row.state))
      errors.push(`${row.source}: unknown retirement state`);
    if (!/^[a-f0-9]{64}$/.test(row.sourceSha256 ?? ''))
      errors.push(`${row.source}: frozen source identity missing`);
    if (
      ['retired', 'superseded'].includes(row.state) &&
      (await lstat(resolve(root, row.source)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      }))
    )
      errors.push(`${row.source}: retired duplicate is still executable`);
    if (row.state === 'retargeted' && row.source !== row.successor)
      errors.push(`${row.source}: in-place retarget changed file identity`);
    if (row.state === 'superseded') {
      const sources = new Map();
      for (const replacement of row.replacements ?? []) {
        const source = await readFile(resolve(root, replacement.path), 'utf8');
        sources.set(replacement.path, source);
        if (
          /packages\/runtime|apps\/desktop\/src\/(main|renderer|preload)|@workspace\//u.test(source)
        )
          errors.push(`${replacement.path}: retired implementation dependency`);
      }
      for (const error of inspectSemanticReplacement(row, sources))
        errors.push(`${row.source}: ${error}`);
      continue;
    }
    if (!['retired', 'retargeted'].includes(row.state)) continue;
    const source = await readFile(resolve(root, row.successor), 'utf8');
    for (const error of inspectTestRetention(row.baseline, source, row.titleAliases))
      errors.push(`${row.source}: ${error}`);
    if (/packages\/runtime|apps\/desktop\/src\/(main|renderer|preload)|@workspace\//u.test(source))
      errors.push(`${row.successor}: retired implementation dependency`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return {
    retired: manifest.tests.filter((r) => r.state === 'retired').length,
    superseded: manifest.tests.filter((r) => r.state === 'superseded').length,
    retargeted: manifest.tests.filter((r) => r.state === 'retargeted').length,
    pending: manifest.tests.filter((r) => r.state === 'pending').length,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.info(await checkTestRetention());
