import { createWriteStream, existsSync, readdirSync, statSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const playwrightEntry = require.resolve('@playwright/test');
const playwrightCoreEntry = require.resolve('playwright-core', { paths: [playwrightEntry] });
const playwrightCoreDirectory = dirname(playwrightCoreEntry);
const { ZipFile } = require(join(playwrightCoreDirectory, 'lib', 'coreBundle.js')).utils;
const { yazl } = require(join(playwrightCoreDirectory, 'lib', 'utilsBundle.js'));

const textEntryExtensions = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsonl',
  '.md',
  '.mjs',
  '.svg',
  '.trace',
  '.txt',
  '.xml',
]);
const traceTextEntries = new Set(['trace.network', 'trace.stacks', 'trace.trace']);
const credentialFieldNames = [
  'apiKey',
  'bootstrapToken',
  'passphrase',
  'password',
  'privateKey',
  'secret',
  'secretValue',
  'sessionToken',
];
const credentialFieldPattern = credentialFieldNames.join('|');
const replacement = '[REDACTED]';

const secretPatterns = [
  {
    label: 'authorization credential',
    expression: /\b(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/giu,
  },
  {
    label: 'JSON credential field',
    expression: new RegExp(
      `"(?:${credentialFieldPattern})"\\s*:\\s*"(?!\\[REDACTED\\])(?:\\\\.|[^"\\\\])+"`,
      'giu',
    ),
  },
];

function isTextEntry(name) {
  return traceTextEntries.has(name) || textEntryExtensions.has(extname(name).toLowerCase());
}

function redactTraceText(text) {
  let redactions = 0;
  let sanitized = text.replace(
    /\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/giu,
    (_match, scheme) => {
      redactions += 1;
      return `${scheme} ${replacement}`;
    },
  );
  sanitized = sanitized.replace(
    new RegExp(`("(?:${credentialFieldPattern})"\\s*:\\s*")(?:\\\\.|[^"\\\\])*(")`, 'giu'),
    (_match, prefix, suffix) => {
      redactions += 1;
      return `${prefix}${replacement}${suffix}`;
    },
  );
  return { redactions, sanitized };
}

async function readTraceEntries(path) {
  const archive = new ZipFile(path);
  try {
    const names = await archive.entries();
    return await Promise.all(
      names.map(async (name) => ({
        name,
        content: await archive.read(name),
      })),
    );
  } finally {
    archive.close();
  }
}

async function writeTraceEntries(path, entries) {
  const temporaryPath = `${path}.${process.pid}.sanitizing`;
  const archive = new yazl.ZipFile();
  const completed = new Promise((resolveWrite, rejectWrite) => {
    archive.on('error', rejectWrite);
    archive.outputStream
      .pipe(createWriteStream(temporaryPath))
      .on('close', resolveWrite)
      .on('error', rejectWrite);
  });
  try {
    for (const entry of entries) archive.addBuffer(entry.content, entry.name);
    archive.end();
    await completed;
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function sanitizeInteractionTrace(path) {
  const entries = await readTraceEntries(path);
  let redactions = 0;
  for (const entry of entries) {
    if (!isTextEntry(entry.name)) continue;
    const result = redactTraceText(entry.content.toString('utf8'));
    if (!result.redactions) continue;
    redactions += result.redactions;
    entry.content = Buffer.from(result.sanitized);
  }
  if (redactions) await writeTraceEntries(path, entries);
  return { path, redactions };
}

export function findTraceArchives(paths) {
  const archives = [];
  const visit = (path) => {
    if (!existsSync(path)) return;
    const stats = statSync(path);
    if (stats.isDirectory()) {
      for (const child of readdirSync(path)) visit(join(path, child));
      return;
    }
    if (path.toLowerCase().endsWith('.zip')) archives.push(resolve(path));
  };
  for (const path of paths) visit(resolve(path));
  return archives.sort();
}

export async function auditInteractionTraces(paths) {
  const archives = findTraceArchives(paths);
  const findings = [];
  for (const path of archives) {
    const entries = await readTraceEntries(path);
    for (const entry of entries) {
      if (!isTextEntry(entry.name)) continue;
      const text = entry.content.toString('utf8');
      for (const pattern of secretPatterns) {
        pattern.expression.lastIndex = 0;
        if (pattern.expression.test(text)) {
          findings.push({ path, entry: entry.name, kind: pattern.label });
        }
      }
    }
  }
  return { archives: archives.length, findings };
}

async function runCli() {
  const mode = process.argv[2];
  const paths = process.argv.slice(3);
  if (!['--audit', '--sanitize'].includes(mode) || !paths.length) {
    throw new Error('Usage: node trace-security.mjs (--audit|--sanitize) <trace path...>');
  }
  const archives = findTraceArchives(paths);
  let redactions = 0;
  if (mode === '--sanitize') {
    for (const path of archives) redactions += (await sanitizeInteractionTrace(path)).redactions;
  }
  const audit = await auditInteractionTraces(paths);
  if (audit.findings.length) {
    const details = audit.findings
      .map(({ path, entry, kind }) => `${path}: ${entry}: ${kind}`)
      .join('\n');
    throw new Error(
      `Trace security audit found ${audit.findings.length} unsafe entries:\n${details}`,
    );
  }
  console.log(
    `Trace security audit passed: ${audit.archives} archives, ${redactions} redactions, 0 unsafe entries.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
