import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const retiredName = ['elect', 'erm'].join('');
const ignoredDirectories = new Set([
  '.git',
  'node_modules',
  'out',
  'dist',
  'release',
  'test-results',
  'playwright-report',
]);

function countOccurrences(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

export function auditRetiredName(sourceDirectory = repositoryRoot) {
  const root = resolve(sourceDirectory);
  if (!existsSync(root) || !lstatSync(root).isDirectory())
    throw new Error(`Source directory does not exist: ${root}`);
  const ascii = new RegExp(retiredName, 'gi');
  const littleEndian = new RegExp(
    [...retiredName].map((letter) => `${letter}\\x00`).join(''),
    'gi',
  );
  const bigEndian = new RegExp([...retiredName].map((letter) => `\\x00${letter}`).join(''), 'gi');
  const findings = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      const name = relative(root, path).replaceAll('\\', '/');
      const pathOccurrences = countOccurrences(name, ascii);
      if (pathOccurrences)
        findings.push({ path: name, kind: 'path', occurrences: pathOccurrences });
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile()) {
        const bytes = readFileSync(path).toString('latin1');
        const occurrences =
          countOccurrences(bytes, ascii) +
          countOccurrences(bytes, littleEndian) +
          countOccurrences(bytes, bigEndian);
        if (occurrences) findings.push({ path: name, kind: 'content', occurrences });
      }
    }
  }

  visit(root);
  findings.sort(
    (left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind),
  );
  return { passed: findings.length === 0, findings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--check' || process.argv.length < 3 || process.argv.length > 4) {
    console.error(
      'Usage: node scripts/commercialization/audit-retired-name.mjs --check [directory]',
    );
    process.exitCode = 2;
  } else {
    const report = auditRetiredName(process.argv[3] ?? repositoryRoot);
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  }
}
