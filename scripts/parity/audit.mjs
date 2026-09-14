import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertElectermBaseline,
  electermRoot,
  expectedElectermCommit,
  expectedElectermVersion,
  readJson,
  repositoryRoot,
} from './baseline.mjs';
import { auditInteractionTraces } from './trace-security.mjs';

const scenarioPath = resolve(repositoryRoot, 'tests/parity/electerm-scenarios.json');
const settingsMapPath = resolve(repositoryRoot, 'tests/parity/electerm-settings-map.json');
const actionsMapPath = resolve(repositoryRoot, 'tests/parity/electerm-actions-map.json');
const matrixPath = resolve(repositoryRoot, 'docs/implementation/ELECTERM_PARITY_MATRIX.md');
const tokenCssPath = resolve(
  repositoryRoot,
  'apps/desktop/src/renderer/src/styles/electerm-parity.tokens.css',
);
const tokenDocPath = resolve(repositoryRoot, 'docs/product/ELECTERM_DESIGN_TOKENS.md');

function fail(message, details = []) {
  const suffix = details.length ? `\n  - ${details.join('\n  - ')}` : '';
  throw new Error(`${message}${suffix}`);
}

function duplicates(values) {
  const seen = new Set();
  const duplicate = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate].sort();
}

function readMatrixRows() {
  return readFileSync(matrixPath, 'utf8')
    .split('\n')
    .flatMap((line, index) => {
      const id = line.match(/^\|\s*([A-J]-\d+)\s*\|/)?.[1];
      if (!id) return [];
      return [
        {
          id,
          line: index + 1,
          columns: line
            .split('|')
            .slice(1, -1)
            .map((value) => value.trim()),
        },
      ];
    });
}

function readDefaultSettingKeys() {
  const source = readFileSync(
    resolve(electermRoot, 'src/client/common/default-setting.js'),
    'utf8',
  );
  return [...source.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*):/gm)].map((match) => match[1]);
}

function readShortcutNames() {
  const source = readFileSync(
    resolve(electermRoot, 'src/client/components/shortcuts/shortcuts-defaults.js'),
    'utf8',
  );
  const uncommented = source.replace(/^\s*\/\/.*$/gm, '');
  return [...uncommented.matchAll(/name:\s*'([^']+)'/g)].map((match) => match[1]);
}

function compareExact(label, sourceValues, mappedValues) {
  const source = new Set(sourceValues);
  const mapped = new Set(mappedValues);
  const missing = [...source].filter((value) => !mapped.has(value)).sort();
  const unknown = [...mapped].filter((value) => !source.has(value)).sort();
  if (missing.length || unknown.length)
    fail(`${label} map drift`, [
      ...(missing.length ? [`unmapped: ${missing.join(', ')}`] : []),
      ...(unknown.length ? [`not in upstream: ${unknown.join(', ')}`] : []),
    ]);
}

function statusCounts(map) {
  return Object.values(map).reduce((counts, value) => {
    counts[value.status] = (counts[value.status] ?? 0) + 1;
    return counts;
  }, {});
}

export async function runParityAudit() {
  const baseline = assertElectermBaseline();
  const scenarios = readJson(scenarioPath);
  const settingsMap = readJson(settingsMapPath);
  const actionsMap = readJson(actionsMapPath);
  const traceSecurity = await auditInteractionTraces([
    resolve(repositoryRoot, 'tests/parity/screenshots/axterm/traces'),
    resolve(repositoryRoot, 'tests/parity/screenshots/electerm/traces'),
  ]);
  const matrixRows = readMatrixRows();
  const matrixIds = matrixRows.map(({ id }) => id);
  const matrixIdSet = new Set(matrixIds);
  const errors = [];

  if (traceSecurity.findings.length) {
    errors.push(
      ...traceSecurity.findings.map(
        ({ path, entry, kind }) =>
          `unsafe interaction trace ${path.slice(repositoryRoot.length + 1)}:${entry} (${kind})`,
      ),
    );
  }

  const repeatedMatrixIds = duplicates(matrixIds);
  if (repeatedMatrixIds.length)
    errors.push(`duplicate matrix IDs: ${repeatedMatrixIds.join(', ')}`);
  for (const row of matrixRows) {
    if (row.columns.length !== 7) {
      errors.push(
        `${row.id}: matrix row ${row.line} has ${row.columns.length} columns, expected 7`,
      );
      continue;
    }
    const status = row.columns[4];
    const phase = row.columns[5];
    if (
      !['Missing', 'Partial', 'Implemented', 'Certified', 'Not applicable', 'Blocked'].includes(
        status,
      )
    )
      errors.push(`${row.id}: invalid matrix status ${status}`);
    if (!/^(?:1[2-9]|2[01]|10\/21|11\/21)$/.test(phase))
      errors.push(`${row.id}: invalid matrix phase ${phase}`);
  }

  if (
    scenarios.baseline.commit !== expectedElectermCommit ||
    scenarios.baseline.packageVersion !== expectedElectermVersion
  )
    errors.push('scenario baseline does not match baseline.mjs');
  const expectedViewports = ['1280x800', '1440x900', '1920x1080'];
  const actualViewports = scenarios.viewports.map(({ width, height }) => `${width}x${height}`);
  if (JSON.stringify(actualViewports) !== JSON.stringify(expectedViewports))
    errors.push(`unexpected viewport set: ${actualViewports.join(', ')}`);
  if (scenarios.visualPolicy.pixelDifferenceRatio !== 0.05)
    errors.push('pixel difference policy must require at least 95% similarity');
  if (scenarios.visualPolicy.edgeToleranceCssPixels !== 4)
    errors.push('edge tolerance policy must remain 4 CSS pixels');
  const expectedHardDefectChecks = [
    'overlapping-primary-controls',
    'clipped-text-or-actions',
    'unreadable-content-or-contrast',
    'off-viewport-menu-or-dialog',
    'broken-ltr-rtl-direction',
    'broken-keyboard-focus',
    'unreachable-or-nonfunctional-primary-action',
  ];
  if (
    JSON.stringify(scenarios.visualPolicy.hardDefectChecks) !==
    JSON.stringify(expectedHardDefectChecks)
  )
    errors.push('visual hard-defect checks do not match the required acceptance policy');

  const scenarioIds = scenarios.scenarios.map(({ id }) => id);
  const repeatedScenarios = duplicates(scenarioIds);
  if (repeatedScenarios.length) errors.push(`duplicate scenarios: ${repeatedScenarios.join(', ')}`);

  const coveredMatrixIds = [];
  for (const scenario of scenarios.scenarios) {
    if (!Number.isInteger(scenario.phase) || scenario.phase < 12 || scenario.phase > 21)
      errors.push(`${scenario.id}: invalid phase ${scenario.phase}`);
    if (!scenario.states?.length) errors.push(`${scenario.id}: has no states`);
    if (!scenario.upstream?.length) errors.push(`${scenario.id}: has no upstream evidence`);
    for (const path of scenario.upstream ?? []) {
      if (!existsSync(resolve(electermRoot, path))) errors.push(`${scenario.id}: missing ${path}`);
    }
    for (const matrixId of scenario.matrix ?? []) {
      coveredMatrixIds.push(matrixId);
      if (!matrixIdSet.has(matrixId)) errors.push(`${scenario.id}: unknown matrix ID ${matrixId}`);
    }
  }

  const uncovered = matrixIds.filter((id) => !coveredMatrixIds.includes(id));
  if (uncovered.length) errors.push(`matrix IDs without scenarios: ${uncovered.join(', ')}`);
  const unknownCoverage = coveredMatrixIds.filter((id) => !matrixIdSet.has(id));
  if (unknownCoverage.length)
    errors.push(
      `scenarios reference unknown matrix IDs: ${[...new Set(unknownCoverage)].join(', ')}`,
    );

  compareExact('default setting', readDefaultSettingKeys(), Object.keys(settingsMap.settings));
  compareExact('default shortcut', readShortcutNames(), Object.keys(actionsMap.actions));

  for (const [kind, map] of [
    ['setting', settingsMap.settings],
    ['action', actionsMap.actions],
  ]) {
    for (const [source, value] of Object.entries(map)) {
      if (!value.target) errors.push(`${kind} ${source}: missing target`);
      if (!matrixIdSet.has(value.matrix))
        errors.push(`${kind} ${source}: unknown matrix ID ${value.matrix}`);
      if (
        !['missing', 'partial', 'implemented', 'certified', 'not-applicable', 'blocked'].includes(
          value.status,
        )
      )
        errors.push(`${kind} ${source}: invalid status ${value.status}`);
    }
  }

  const css = readFileSync(tokenCssPath, 'utf8');
  const tokenDoc = readFileSync(tokenDocPath, 'utf8');
  const tokens = [...css.matchAll(/^\s*(--ax-[a-z0-9-]+):/gm)].map((match) => match[1]);
  if (tokens.length < 25) errors.push(`expected at least 25 design tokens, found ${tokens.length}`);
  for (const token of tokens)
    if (!tokenDoc.includes(token)) errors.push(`undocumented token ${token}`);

  if (errors.length) fail('Electerm parity audit failed', errors);
  const evidenceIndex = Object.fromEntries(
    matrixIds.map((matrixId) => [
      matrixId,
      scenarios.scenarios
        .filter((scenario) => scenario.matrix.includes(matrixId))
        .map((scenario) => scenario.id),
    ]),
  );
  return {
    baseline,
    scenarios: scenarios.scenarios.length,
    capturedScenarios: scenarios.scenarios.filter(({ capture }) => capture).length,
    matrixItems: matrixIds.length,
    settings: Object.keys(settingsMap.settings).length,
    actions: Object.keys(actionsMap.actions).length,
    designTokens: tokens.length,
    unmapped: { settings: [], actions: [] },
    unimplemented: {
      settings: Object.entries(settingsMap.settings)
        .filter(([, value]) => value.status === 'missing')
        .map(([key]) => key),
      actions: Object.entries(actionsMap.actions)
        .filter(([, value]) => value.status === 'missing')
        .map(([key]) => key),
    },
    statusCounts: {
      matrix: matrixRows.reduce((counts, row) => {
        const status = row.columns[4]?.toLowerCase().replace(' ', '-');
        if (status) counts[status] = (counts[status] ?? 0) + 1;
        return counts;
      }, {}),
      settings: statusCounts(settingsMap.settings),
      actions: statusCounts(actionsMap.actions),
    },
    evidenceIndex,
    interactionTraces: {
      archives: traceSecurity.archives,
      unsafeEntries: traceSecurity.findings.length,
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runParityAudit();
    const outputAt = process.argv.indexOf('--output');
    if (outputAt !== -1) {
      const outputPath = process.argv[outputAt + 1];
      if (!outputPath) throw new Error('--output requires a path');
      mkdirSync(dirname(resolve(outputPath)), { recursive: true });
      writeFileSync(resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`);
    }
    console.log(
      `Parity audit passed: ${result.matrixItems} matrix items, ${result.scenarios} scenarios, ` +
        `${result.settings} settings, ${result.actions} actions, ${result.designTokens} tokens; ` +
        `0 unmapped, ${result.unimplemented.settings.length} settings and ` +
        `${result.unimplemented.actions.length} actions remain unimplemented.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
