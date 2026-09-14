import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalInformationSnapshot } from '@workspace/contracts';
import type { TerminalChannel } from '../ports/terminal-channel';
import type { ConnectionService } from './connection-service';
import {
  parseTerminalInformationGroup,
  REMOTE_TERMINAL_INFORMATION_COMMANDS,
} from './terminal-information-model';
import { TerminalInformationService } from './terminal-information-service';
import { TerminalService } from './terminal-service';

class FakeChannel implements TerminalChannel {
  shellIntegrationKind = 'unsupported' as const;
  write() {}
  resize() {}
  signal() {}
  pause() {}
  resume() {}
  onData() {
    return () => {};
  }
  onExit() {
    return () => {};
  }
  async close() {}
}

const outputs = {
  sysinfo: 'Linux\nmonitor-host\n6.8.0\nx86_64\nPRETTY_NAME="Fixture Linux"\n/bin/bash\n',
  cpu: 'cpu  100 0 100 800 0 0 0 0\ncpu  120 0 110 870 0 0 0 0\n',
  memory:
    'MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 400 kB\nSwapTotal: 200 kB\nSwapFree: 150 kB\n',
  uptime: '93784.5 0\n',
  users: 'alice pts/0 2026-09-13 10:00 (192.0.2.10)\nbob pts/1 2026-09-13 10:10\n',
  network: 'default\teth0\niface\teth0\tstate=up\tipv4=192.0.2.2/24\trx=1000\ttx=2000\n',
  disks:
    'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 250 750 25% /\ntmpfs 100 1 99 1% /run\n',
  activities: '12 root 82.5 1024 node api_key=visible-secret\n13 alice 2.5 512 sleep 10\n',
} as const;

describe('terminal information model', () => {
  it('parses bounded system, usage, network, disk and redacted activity data', () => {
    const sampledAt = Date.parse('2026-09-13T10:30:00.000Z');
    expect(parseTerminalInformationGroup('sysinfo', outputs.sysinfo, sampledAt)).toMatchObject({
      os: 'Fixture Linux',
      hostname: 'monitor-host',
      kernel: '6.8.0',
      shell: 'bash',
    });
    expect(parseTerminalInformationGroup('cpu', outputs.cpu, sampledAt)).toBeCloseTo(30);
    expect(parseTerminalInformationGroup('memory', outputs.memory, sampledAt)).toMatchObject({
      totalBytes: 1_024_000,
      usedBytes: 614_400,
      percent: 60,
    });
    expect(parseTerminalInformationGroup('uptime', outputs.uptime, sampledAt)).toMatchObject({
      seconds: 93_784.5,
    });
    expect(parseTerminalInformationGroup('users', outputs.users, sampledAt)).toMatchObject({
      users: ['alice', 'bob'],
    });
    expect(parseTerminalInformationGroup('network', outputs.network, sampledAt)).toMatchObject({
      defaultInterface: 'eth0',
      interfaces: [{ name: 'eth0', ipv4: '192.0.2.2' }],
    });
    expect(parseTerminalInformationGroup('disks', outputs.disks, sampledAt)).toEqual([
      expect.objectContaining({ mount: '/', percent: 25 }),
    ]);
    expect(parseTerminalInformationGroup('activities', outputs.activities, sampledAt)).toEqual([
      expect.objectContaining({ pid: 12, command: 'node api_key=[REDACTED]' }),
      expect.objectContaining({ pid: 13 }),
    ]);
  });

  it('derives network rates only from monotonic counters and actual elapsed time', () => {
    const firstAt = 1_000;
    const first = parseTerminalInformationGroup('network', outputs.network, firstAt) as NonNullable<
      TerminalInformationSnapshot['groups']['network']['data']
    >;
    const second = parseTerminalInformationGroup(
      'network',
      'default\teth0\niface\teth0\tstate=up\tipv4=192.0.2.2/24\trx=3000\ttx=3000\n',
      3_000,
      { data: first, sampledAt: firstAt },
    ) as NonNullable<TerminalInformationSnapshot['groups']['network']['data']>;
    expect(second?.interfaces[0]).toMatchObject({ receiveRate: 1_000, transmitRate: 500 });
  });
});

describe('TerminalInformationService', () => {
  it('shares TTL-bound SSH samples, retains CPU history and releases closed-session caches', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T10:30:00.000Z'));
    const terminalService = new TerminalService({ open: () => new FakeChannel() });
    const connectionId = randomUUID();
    const terminalId = randomUUID();
    terminalService.registerExternal(
      {
        id: terminalId,
        kind: 'ssh',
        title: 'monitor-host',
        state: 'ready',
        connectionId,
        appearance: {
          fontFamily: 'monospace',
          fontSize: 14,
          lineHeight: 1.2,
          cursorStyle: 'block',
          cursorBlink: false,
        },
        behavior: {
          scrollback: 3_000,
          rendererPreference: 'dom',
          unicodeVersion: '11',
          ligaturesEnabled: false,
          imageSequencesEnabled: false,
          wordSeparator: ' ',
          backspaceMode: '^?',
          shiftEnterMode: '\\n',
          encoding: 'utf-8',
          displayRaw: false,
          logTimestamps: false,
          pasteProtection: true,
          osc52Enabled: false,
          osc52ReadPolicy: 'deny',
          osc52WritePolicy: 'deny',
        },
        createdAt: new Date().toISOString(),
      },
      new FakeChannel(),
    );
    const exec = vi.fn(async ({ command }: { command: string }) => {
      const name = Object.entries(REMOTE_TERMINAL_INFORMATION_COMMANDS).find(
        ([, candidate]) => candidate === command,
      )?.[0] as keyof typeof outputs;
      return { stdout: outputs[name], stderr: '', exitCode: 0 };
    });
    const service = new TerminalInformationService(terminalService, {
      exec: (_id: string, input: { command: string }) => exec(input),
    } as unknown as ConnectionService);
    try {
      const first = await service.snapshot(terminalId);
      expect(first.groups.sysinfo.data?.hostname).toBe('monitor-host');
      expect(first.groups.cpu.state).toBe('ready');
      expect(first.cpuHistory).toHaveLength(1);
      expect(exec).toHaveBeenCalledTimes(8);

      const shared = await service.snapshot(terminalId);
      expect(shared.cpuHistory).toHaveLength(1);
      expect(exec).toHaveBeenCalledTimes(8);

      await vi.advanceTimersByTimeAsync(5_001);
      const refreshed = await service.snapshot(terminalId);
      expect(refreshed.cpuHistory).toHaveLength(2);
      expect(exec).toHaveBeenCalledTimes(13);
      expect(service.cacheCount()).toBe(1);

      await terminalService.close(terminalId);
      expect(service.cacheCount()).toBe(0);
      expect(service.inFlightCount()).toBe(0);
    } finally {
      service.dispose();
      await terminalService.closeAll();
      vi.useRealTimers();
    }
  });
});
