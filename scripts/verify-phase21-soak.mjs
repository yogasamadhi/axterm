import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const phase21CertificationDurationMs = 30 * 60 * 1_000;
export const phase21MinimumCertificationCycles = 1_500;
export const phase21MinimumCertificationSamples = 30;

/** @param {unknown} value */
export function verifyPhase21SoakReport(value) {
  const report = record(value, 'report');
  equal(report.schemaVersion, 1, 'schemaVersion');
  equal(report.state, 'passed', 'state');
  equal(report.evidenceKind, '30-minute-certification', 'evidenceKind');
  equal(report.targetDurationMs, phase21CertificationDurationMs, 'targetDurationMs');
  const elapsedMs = positiveNumber(report.elapsedMs, 'elapsedMs');
  if (elapsedMs < phase21CertificationDurationMs)
    fail(`elapsedMs must be at least ${phase21CertificationDurationMs}`);

  const startedAt = timestamp(report.startedAt, 'startedAt');
  const finishedAt = timestamp(report.finishedAt, 'finishedAt');
  if (finishedAt - startedAt < phase21CertificationDurationMs)
    fail('finishedAt must be at least 30 minutes after startedAt');
  if (report.error !== undefined && report.error !== null) fail('error must be absent');

  const violations = array(report.violations, 'violations');
  if (violations.length) fail('violations must be empty');

  const counters = record(report.counters, 'counters');
  const cycles = integer(counters.cycles, 'counters.cycles');
  if (cycles < phase21MinimumCertificationCycles)
    fail(`counters.cycles must be at least ${phase21MinimumCertificationCycles}`);
  equal(
    integer(counters.terminalRoundTrips, 'counters.terminalRoundTrips'),
    cycles,
    'terminalRoundTrips',
  );
  equal(integer(counters.sftpLists, 'counters.sftpLists'), cycles, 'sftpLists');
  equal(integer(counters.widgets, 'counters.widgets'), cycles, 'widgets');
  equal(integer(counters.transfers, 'counters.transfers'), Math.floor(cycles / 2), 'transfers');
  equal(integer(counters.tunnels, 'counters.tunnels'), Math.floor(cycles / 3), 'tunnels');
  equal(integer(counters.mcpCalls, 'counters.mcpCalls'), Math.floor(cycles / 5), 'mcpCalls');

  const ceilings = record(report.ceilings, 'ceilings');
  const measurements = record(report.measurements, 'measurements');
  for (const [measurementName, ceilingName] of [
    ['rssGrowthBytes', 'rssGrowthBytes'],
    ['heapGrowthBytes', 'heapGrowthBytes'],
    ['databaseGrowthBytes', 'databaseGrowthBytes'],
    ['eventLoopP99Ms', 'eventLoopP99Ms'],
    ['operationP95Ms', 'operationP95Ms'],
  ]) {
    const measurement = nonNegativeNumber(
      measurements[measurementName],
      `measurements.${measurementName}`,
    );
    const ceiling = positiveNumber(ceilings[ceilingName], `ceilings.${ceilingName}`);
    if (measurement > ceiling) fail(`${measurementName} exceeds its ceiling`);
  }

  const samples = array(measurements.samples, 'measurements.samples');
  if (samples.length < phase21MinimumCertificationSamples)
    fail(
      `measurements.samples must contain at least ${phase21MinimumCertificationSamples} checkpoints`,
    );
  const sampleTimes = samples.map((sample, index) =>
    timestamp(
      record(sample, `measurements.samples[${index}]`).at,
      `measurements.samples[${index}].at`,
    ),
  );
  for (let index = 1; index < sampleTimes.length; index++)
    if (sampleTimes[index] - sampleTimes[index - 1] > 2 * 60_000)
      fail(`measurements.samples has an interruption after index ${index - 1}`);
  if (sampleTimes[0] - startedAt > 2 * 60_000) fail('first checkpoint is too far from startedAt');
  if (finishedAt - sampleTimes.at(-1) > 2 * 60_000)
    fail('last checkpoint is too far from finishedAt');
  const baseline = record(measurements.baseline, 'measurements.baseline');
  const latest = record(measurements.latest, 'measurements.latest');
  equal(
    timestamp(baseline.at, 'measurements.baseline.at'),
    sampleTimes[0],
    'measurements.baseline.at',
  );
  equal(
    timestamp(latest.at, 'measurements.latest.at'),
    sampleTimes.at(-1),
    'measurements.latest.at',
  );
  const resources = record(latest.resources, 'measurements.latest.resources');
  const requiredResources = [
    'terminals',
    'terminalStartupSequences',
    'terminalInformationCaches',
    'terminalInformationRequests',
    'widgetInstances',
    'terminalTransfers',
    'connections',
    'batchOperations',
    'triggerSessions',
    'ftpConnections',
    'transfers',
    'externalEditors',
    'tunnels',
    'interactions',
    'rdpSessions',
    'vncSessions',
    'spiceSessions',
    'webSessions',
    'realtimeSubscribers',
    'syncRuns',
    'desktopLifecycle',
  ];
  for (const name of requiredResources)
    integer(resources[name], `measurements.latest.resources.${name}`);
  for (const [name, value] of Object.entries(resources)) {
    const count = integer(value, `measurements.latest.resources.${name}`);
    const allowed = name === 'desktopLifecycle' ? 1 : 0;
    if (count > allowed) fail(`${name} final owner count must be at most ${allowed}`);
  }

  return {
    cycles,
    elapsedMs,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
  };
}

/** @param {unknown} value @param {string} name */
function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${name} must be an object`);
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} name */
function array(value, name) {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  return value;
}

/** @param {unknown} value @param {string} name */
function positiveNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    fail(`${name} must be a positive number`);
  return value;
}

/** @param {unknown} value @param {string} name */
function nonNegativeNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    fail(`${name} must be a non-negative number`);
  return value;
}

/** @param {unknown} value @param {string} name */
function integer(value, name) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0)
    fail(`${name} must be a non-negative safe integer`);
  return /** @type {number} */ (value);
}

/** @param {unknown} value @param {string} name */
function timestamp(value, name) {
  if (typeof value !== 'string') fail(`${name} must be an ISO timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(`${name} must be an ISO timestamp`);
  if (new Date(milliseconds).toISOString() !== value)
    fail(`${name} must be a canonical ISO timestamp`);
  return milliseconds;
}

/** @param {unknown} actual @param {unknown} expected @param {string} name */
function equal(actual, expected, name) {
  if (actual !== expected) fail(`${name} must equal ${String(expected)}`);
}

/** @param {string} message */
function fail(message) {
  throw new Error(`Invalid Phase 21 soak report: ${message}`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const path = resolve(process.argv[2] ?? 'test-results/phase21-soak/latest.json');
  try {
    const summary = verifyPhase21SoakReport(JSON.parse(await readFile(path, 'utf8')));
    process.stdout.write(
      `Phase 21 soak certification verified: ${summary.cycles} cycles, ${summary.startedAt} → ${summary.finishedAt}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
