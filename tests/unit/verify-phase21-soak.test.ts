import { describe, expect, it } from 'vitest';
import {
  phase21CertificationDurationMs,
  phase21MinimumCertificationCycles,
  verifyPhase21SoakReport,
} from '../../scripts/verify-phase21-soak.mjs';

function validReport() {
  const cycles = 1_800;
  const startedAt = Date.parse('2026-09-14T00:00:00.000Z');
  const resources = Object.fromEntries(
    [
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
    ].map((name) => [name, name === 'desktopLifecycle' ? 1 : 0]),
  );
  const samples = Array.from({ length: 31 }, (_, index) => ({
    at: new Date(startedAt + index * 60_000).toISOString(),
  }));
  return {
    schemaVersion: 1,
    state: 'passed',
    evidenceKind: '30-minute-certification',
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: '2026-09-14T00:30:01.000Z',
    targetDurationMs: phase21CertificationDurationMs,
    elapsedMs: phase21CertificationDurationMs + 1_000,
    counters: {
      cycles,
      terminalRoundTrips: cycles,
      sftpLists: cycles,
      transfers: Math.floor(cycles / 2),
      tunnels: Math.floor(cycles / 3),
      widgets: cycles,
      mcpCalls: Math.floor(cycles / 5),
    },
    ceilings: {
      rssGrowthBytes: 256 * 1024 * 1024,
      heapGrowthBytes: 128 * 1024 * 1024,
      databaseGrowthBytes: 128 * 1024 * 1024,
      eventLoopP99Ms: 500,
      operationP95Ms: 8_000,
    },
    measurements: {
      baseline: { at: samples[0]!.at },
      latest: { at: samples.at(-1)!.at, resources },
      samples,
      rssGrowthBytes: 1,
      heapGrowthBytes: 1,
      databaseGrowthBytes: 1,
      eventLoopP99Ms: 20,
      operationP95Ms: 200,
    },
    violations: [] as string[],
  };
}

describe('Phase 21 soak report verifier', () => {
  it('accepts only a complete bounded 30-minute report', () => {
    expect(verifyPhase21SoakReport(validReport())).toMatchObject({
      cycles: 1_800,
      elapsedMs: phase21CertificationDurationMs + 1_000,
    });
  });

  it.each([
    ['running state', (report: ReturnType<typeof validReport>) => (report.state = 'running')],
    ['short duration', (report: ReturnType<typeof validReport>) => (report.elapsedMs = 60_000)],
    [
      'insufficient cycles',
      (report: ReturnType<typeof validReport>) => {
        const cycles = phase21MinimumCertificationCycles - 1;
        report.counters.cycles = cycles;
        report.counters.terminalRoundTrips = cycles;
        report.counters.sftpLists = cycles;
        report.counters.widgets = cycles;
        report.counters.transfers = Math.floor(cycles / 2);
        report.counters.tunnels = Math.floor(cycles / 3);
        report.counters.mcpCalls = Math.floor(cycles / 5);
      },
    ],
    [
      'counter mismatch',
      (report: ReturnType<typeof validReport>) => (report.counters.transfers = 0),
    ],
    ['budget violation', (report: ReturnType<typeof validReport>) => report.violations.push('rss')],
    [
      'checkpoint interruption',
      (report: ReturnType<typeof validReport>) =>
        (report.measurements.samples[15]!.at = '2026-09-14T00:18:00.000Z'),
    ],
    [
      'leaked owner',
      (report: ReturnType<typeof validReport>) =>
        (report.measurements.latest.resources.terminals = 1),
    ],
    [
      'unknown leaked owner',
      (report: ReturnType<typeof validReport>) =>
        (report.measurements.latest.resources.futureResource = 1),
    ],
    [
      'mismatched latest sample',
      (report: ReturnType<typeof validReport>) =>
        (report.measurements.latest.at = '2026-09-14T12:00:00.000Z'),
    ],
  ])('rejects %s', (_name, mutate) => {
    const report = validReport();
    mutate(report);
    expect(() => verifyPhase21SoakReport(report)).toThrow('Invalid Phase 21 soak report');
  });
});
