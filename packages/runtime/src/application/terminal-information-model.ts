import type {
  TerminalInformationGroupName,
  TerminalInformationSnapshot,
} from '@workspace/contracts';

const NETWORK_ROUTE_MARKER = 'AXTERM-NET-ROUTE-V1';
const NETWORK_ADDRESS_MARKER = 'AXTERM-NET-ADDRESS-V1';
const NETWORK_LINK_MARKER = 'AXTERM-NET-LINK-V1';

export const REMOTE_TERMINAL_INFORMATION_COMMANDS: Record<TerminalInformationGroupName, string> = {
  sysinfo:
    'uname -s; hostname; uname -r; uname -m; pretty=$(grep \'^PRETTY_NAME=\' /etc/os-release 2>/dev/null || true); printf \'%s\\n%s\\n\' "$pretty" "${SHELL:-}"',
  cpu: 'head -n 1 /proc/stat; sleep 0.1; head -n 1 /proc/stat',
  memory: 'cat /proc/meminfo',
  uptime: 'cat /proc/uptime',
  users: 'who',
  network: [
    'cat /proc/net/dev 2>/dev/null || exit 127',
    `printf '\\n${NETWORK_ROUTE_MARKER}\\n'`,
    'ip -o route show default 2>/dev/null || true',
    `printf '${NETWORK_ADDRESS_MARKER}\\n'`,
    'ip -o -4 addr show 2>/dev/null || true',
    `printf '${NETWORK_LINK_MARKER}\\n'`,
    'ip -o link show 2>/dev/null || true',
  ].join('; '),
  disks: 'df -Pk',
  activities: 'ps -eo pid=,user=,pcpu=,rss=,args= --sort=-pcpu | head -n 50',
};

export const TERMINAL_INFORMATION_TTL_MS: Record<TerminalInformationGroupName, number> = {
  sysinfo: 5 * 60_000,
  cpu: 5_000,
  memory: 5_000,
  uptime: 5_000,
  users: 30_000,
  network: 5_000,
  disks: 10_000,
  activities: 5_000,
};

type GroupData = TerminalInformationSnapshot['groups'][TerminalInformationGroupName]['data'];
type NetworkData = NonNullable<TerminalInformationSnapshot['groups']['network']['data']>;

export function parseTerminalInformationGroup(
  name: TerminalInformationGroupName,
  output: string,
  sampledAt: number,
  previousNetwork?: { data: NetworkData; sampledAt: number },
): GroupData {
  if (name === 'sysinfo') return parseSystemInformation(output);
  if (name === 'cpu') return parseCpu(output);
  if (name === 'memory') return parseMemory(output);
  if (name === 'uptime') return parseUptime(output, sampledAt);
  if (name === 'users') return parseUsers(output);
  if (name === 'network') return parseNetwork(output, sampledAt, previousNetwork);
  if (name === 'disks') return parseDisks(output);
  return parseActivities(output);
}

function parseSystemInformation(output: string) {
  const lines = output.split(/\r?\n/u);
  if (lines.length < 4 || lines.slice(0, 4).some((line) => !line.trim())) return null;
  const system = lines[0]!;
  const hostname = lines[1]!;
  const kernel = lines[2]!;
  const arch = lines[3]!;
  const pretty = lines[4] ?? '';
  const shell = lines[5] ?? '';
  const prettyName = pretty
    .trim()
    .replace(/^PRETTY_NAME=/u, '')
    .replace(/^"|"$/gu, '');
  return {
    os: prettyName || (system.trim() === 'Darwin' ? 'macOS' : system.trim()),
    hostname: hostname.trim().slice(0, 255),
    kernel: kernel.trim().slice(0, 256),
    arch: arch.trim().slice(0, 64),
    shell: shell.trim().split('/').at(-1)?.slice(0, 128) ?? '',
  };
}

function parseCpu(output: string) {
  const samples: Array<{ ticks: number[]; total: number; idle: number }> = [];
  for (const line of output.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    if (fields[0] !== 'cpu') continue;
    const ticks = fields.slice(1, 9).map(Number);
    if (ticks.length < 4 || ticks.some((tick) => !Number.isSafeInteger(tick) || tick < 0)) continue;
    samples.push({
      ticks,
      total: ticks.reduce((sum, tick) => sum + tick, 0),
      idle: ticks[3]! + (ticks[4] ?? 0),
    });
    if (samples.length === 2) break;
  }
  if (samples.length < 2) return null;
  if (samples[1]!.ticks.some((tick, index) => tick < samples[0]!.ticks[index]!)) return null;
  const elapsedTicks = samples[1]!.total - samples[0]!.total;
  const idleTicks = samples[1]!.idle - samples[0]!.idle;
  if (elapsedTicks <= 0 || idleTicks < 0 || idleTicks > elapsedTicks) return null;
  return clampPercent(100 * (1 - idleTicks / elapsedTicks));
}

function parseMemory(output: string) {
  const wanted = new Set(['MemTotal', 'MemAvailable', 'MemFree', 'SwapTotal', 'SwapFree']);
  const values = new Map<string, number>();
  for (const line of output.split(/\r?\n/u)) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const name = line.slice(0, separator);
    if (!wanted.has(name)) continue;
    const amount = /^\s*(\d+)\s*(kB)?\s*$/iu.exec(line.slice(separator + 1));
    if (!amount) continue;
    const bytes = Number(amount[1]) * (amount[2] ? 1_024 : 1);
    if (Number.isSafeInteger(bytes)) values.set(name, bytes);
  }
  const totalBytes = values.get('MemTotal');
  if (!totalBytes) return null;
  const availableBytes = Math.min(
    totalBytes,
    Math.max(0, values.get('MemAvailable') ?? values.get('MemFree') ?? 0),
  );
  const usedBytes = totalBytes - availableBytes;
  const swapTotalBytes = values.get('SwapTotal') ?? null;
  const swapFreeBytes = values.get('SwapFree') ?? null;
  return {
    totalBytes,
    availableBytes,
    usedBytes,
    swapTotalBytes,
    swapUsedBytes:
      swapTotalBytes === null || swapFreeBytes === null
        ? null
        : Math.max(0, swapTotalBytes - Math.min(swapTotalBytes, swapFreeBytes)),
    percent: clampPercent((usedBytes / totalBytes) * 100),
  };
}

function parseUptime(output: string, sampledAt: number) {
  const seconds = Number(/^\s*(\d+(?:\.\d+)?)/u.exec(output)?.[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return { seconds, bootTime: new Date(sampledAt - seconds * 1_000).toISOString() };
}

function parseUsers(output: string) {
  const sessions = output
    .split(/\r?\n/u)
    .map((line) => /^(\S+)\s+(\S+)\s+(.+?)(?:\s+\(([^)]*)\))?\s*$/u.exec(line.trim()))
    .filter((match): match is RegExpExecArray => !!match)
    .slice(0, 64)
    .map((match) => ({
      username: match[1]!.slice(0, 128),
      terminal: match[2]!.slice(0, 128),
      startedAt: match[3]!.slice(0, 128),
      source: match[4]?.slice(0, 255) ?? null,
    }));
  if (output.trim() && !sessions.length) return null;
  return { users: [...new Set(sessions.map(({ username }) => username))].slice(0, 64), sessions };
}

function parseNetwork(
  output: string,
  sampledAt: number,
  previous?: { data: NetworkData; sampledAt: number },
): NetworkData | null {
  type Section = 'counters' | 'route' | 'address' | 'link';
  let section: Section = 'counters';
  let defaultInterface: string | null = null;
  const counters: Array<{
    name: string;
    receivedBytes: number | null;
    transmittedBytes: number | null;
  }> = [];
  const addresses = new Map<string, string>();
  const states = new Map<string, string>();

  let lineCount = 0;
  for (const line of output.split(/\r?\n/u)) {
    if (++lineCount > 512) break;
    if (line === NETWORK_ROUTE_MARKER) {
      section = 'route';
      continue;
    }
    if (line === NETWORK_ADDRESS_MARKER) {
      section = 'address';
      continue;
    }
    if (line === NETWORK_LINK_MARKER) {
      section = 'link';
      continue;
    }
    if (line.length > 4_096) continue;

    if (section === 'counters') {
      const separator = line.lastIndexOf(':');
      if (separator < 0) continue;
      const name = line.slice(0, separator).trim();
      if (!name || name === 'lo') continue;
      const values = line
        .slice(separator + 1)
        .trim()
        .split(/\s+/u);
      if (values.length < 9 || counters.length >= 32) continue;
      counters.push({
        name: name.slice(0, 128),
        receivedBytes: counter(values[0]),
        transmittedBytes: counter(values[8]),
      });
      continue;
    }
    if (section === 'route' && !defaultInterface && line.startsWith('default ')) {
      defaultInterface = /\bdev\s+(\S+)/u.exec(line)?.[1]?.slice(0, 128) ?? null;
    } else if (section === 'address') {
      const match = /^\d+:\s+(\S+)\s+inet\s+([^\s/]+)/u.exec(line);
      if (match && addresses.size < 64) addresses.set(match[1]!.split('@')[0]!, match[2]!);
    } else if (section === 'link') {
      const match = /^\d+:\s+(\S+):.*\bstate\s+(\S+)/u.exec(line);
      if (match && states.size < 64) states.set(match[1]!.split('@')[0]!, match[2]!.toLowerCase());
    }
  }

  const interfaces: NetworkData['interfaces'] = [];
  for (const entry of counters) {
    const { name, receivedBytes, transmittedBytes } = entry;
    const old = previous?.data.interfaces.find((item) => item.name === name);
    const elapsed = previous ? (sampledAt - previous.sampledAt) / 1_000 : 0;
    const ratesValid =
      !!old &&
      elapsed > 0 &&
      receivedBytes !== null &&
      transmittedBytes !== null &&
      old.receivedBytes !== null &&
      old.transmittedBytes !== null &&
      receivedBytes >= old.receivedBytes &&
      transmittedBytes >= old.transmittedBytes;
    interfaces.push({
      name,
      state: states.get(name)?.slice(0, 32) ?? null,
      ipv4: addresses.get(name)?.slice(0, 64) ?? null,
      receivedBytes,
      transmittedBytes,
      receiveRate: ratesValid ? (receivedBytes - old.receivedBytes!) / elapsed : null,
      transmitRate: ratesValid ? (transmittedBytes - old.transmittedBytes!) / elapsed : null,
    });
  }
  return interfaces.length ? { defaultInterface, interfaces } : null;
}

const PSEUDO_FILE_SYSTEMS = /^(?:tmpfs|devtmpfs|proc|sysfs|cgroup\d?|devpts|squashfs|securityfs)$/u;

function parseDisks(output: string) {
  const disks = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/u.exec(line.trim());
    if (!match || PSEUDO_FILE_SYSTEMS.test(match[1]!)) continue;
    const mount = match[6]!
      .replaceAll('\\040', ' ')
      .replaceAll('\\011', '\t')
      .replaceAll('\\134', '\\');
    if (match[1] === 'overlay' && mount !== '/') continue;
    disks.push({
      filesystem: match[1]!.slice(0, 255),
      totalBytes: Number(match[2]) * 1_024,
      usedBytes: Number(match[3]) * 1_024,
      availableBytes: Number(match[4]) * 1_024,
      percent: clampPercent(Number(match[5])),
      mount: mount.slice(0, 4_096),
    });
    if (disks.length >= 64) break;
  }
  return disks.length ? disks : null;
}

function parseActivities(output: string) {
  const activities = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const cpuPercent = Number(match[3]);
    const memoryBytes = Number(match[4]) * 1_024;
    if (![pid, cpuPercent, memoryBytes].every(Number.isFinite) || pid <= 0) continue;
    activities.push({
      pid,
      username: match[2]!.slice(0, 128),
      cpuPercent,
      memoryBytes,
      command: redactProcessCommand(match[5]!).slice(0, 256),
    });
    if (activities.length >= 50) break;
  }
  return activities.length ? activities : null;
}

function redactProcessCommand(value: string) {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}/giu, '$1[REDACTED]')
    .replace(
      /\b(api[_-]?key|password|passphrase|token|secret)\s*[:=]\s*[^\s,;]+/giu,
      '$1=[REDACTED]',
    );
}

function counter(value: string | undefined) {
  if (!value || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function clampPercent(value: number) {
  return Math.min(100, Math.max(0, value));
}
