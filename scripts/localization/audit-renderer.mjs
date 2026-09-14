import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import ts from 'typescript';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const rendererRoot = resolve(repositoryRoot, 'apps/desktop/src/renderer/src');
const baselinePath = resolve(repositoryRoot, 'tests/parity/renderer-literal-baseline.json');
const writeBaseline = process.argv.includes('--write-baseline');
const cjk = /[\u3400-\u9fff]/u;

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'i18n' ? [] : sourceFiles(path);
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : [];
  });
}

function literalText(node) {
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node) ||
    ts.isJsxText(node)
  ) {
    return node.text;
  }
  return undefined;
}

const files = {};
const examples = [];
for (const path of sourceFiles(rendererRoot).sort()) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let count = 0;
  const visit = (node) => {
    const value = literalText(node);
    if (value && cjk.test(value)) {
      count += 1;
      if (examples.length < 50) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        examples.push({
          file: relative(repositoryRoot, path),
          line: position.line + 1,
          text: value.trim().replaceAll(/\s+/gu, ' ').slice(0, 120),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (count) files[relative(repositoryRoot, path)] = count;
}

const report = {
  schemaVersion: 1,
  rule: 'CJK string/template/JSX literals outside renderer/src/i18n',
  total: Object.values(files).reduce((sum, count) => sum + count, 0),
  files,
};

if (writeBaseline) {
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote Renderer localization baseline with ${report.total} literals`);
} else {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  if (JSON.stringify(report) !== JSON.stringify(baseline)) {
    console.error(
      JSON.stringify(
        {
          expectedTotal: baseline.total,
          actualTotal: report.total,
          files: report.files,
          examples,
        },
        null,
        2,
      ),
    );
    throw new Error(
      'Renderer localization literals changed; migrate new text and refresh the reviewed baseline with bun run locales:audit:update',
    );
  }
  console.log(`Renderer localization baseline verified: ${report.total} literals remain`);
}
