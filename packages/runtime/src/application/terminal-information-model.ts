import type {
  TerminalInformationGroupName,
  TerminalInformationSnapshot,
} from '@workspace/contracts';

export const REMOTE_TERMINAL_INFORMATION_COMMANDS: Record<TerminalInformationGroupName, string> = {
  sysinfo:
    'uname -s; hostname; uname -r; uname -m; pretty=$(grep \'^PRETTY_NAME=\' /etc/os-release 2>/dev/null || true); printf \'%s\\n%s\\n\' "$pretty" "${SHELL:-}"',
  cpu: "grep '^cpu ' /proc/stat; sleep 0.1; grep '^cpu ' /proc/stat",
  memory: 'cat /proc/meminfo',
  uptime: 'cat /proc/uptime',
  users: 'who',
  network:
    '[ -d /sys/class/net ] || exit 127; default_if=$(ip route show default 2>/dev/null | awk \'NR==1 {print $5}\'); printf \'default\\t%s\\n\' "$default_if"; for d in /sys/class/net/*; do [ -d "$d" ] || continue; n=${d##*/}; [ "$n" = lo ] && continue; state=$(cat "$d/operstate" 2>/dev/null || true); ipv4=$(ip -o -4 addr show dev "$n" 2>/dev/null | awk \'NR==1 {print $4}\'); rx=$(cat "$d/statistics/rx_bytes" 2>/dev/null || true); tx=$(cat "$d/statistics/tx_bytes" 2>/dev/null || true); printf \'iface\\t%s\\tstate=%s\\tipv4=%s\\trx=%s\\ttx=%s\\n\' "$n" "$state" "$ipv4" "$rx" "$tx"; done',
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
  const samples = output
    .split(/\r?\n/u)
    .filter((line) => /^\s*cpu\s/u.test(line))
    .map((line) => line.trim().split(/\s+/u).slice(1, 9).map(Number))
    .filter((values) => values.length >= 4 && values.every(Number.isFinite));
  const first = samples[0];
  const second = samples[1];
  if (!first || !second || first.length !== second.length) return null;
  const deltas = second.map((value, index) => value - first[index]!);
  if (deltas.some((value) => value < 0)) return null;
  const total = deltas.reduce((sum, value) => sum + value, 0);
  if (!total) return null;
  const idle = (deltas[3] ?? 0) + (deltas[4] ?? 0);
  return clampPercent(((total - idle) / total) * 100);
}

function parseMemory(output: string) {
  const values = new Map<string, number>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^([^:]+):\s*(\d+(?:\.\d+)?)\s*([A-Za-z]+)?\s*$/u.exec(line);
    if (!match) continue;
    const multiplier = /^(?:kb|kib)$/iu.test(match[3] ?? '') ? 1024 : 1;
    values.set(match[1]!, Number(match[2]) * multiplier);
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
  let defaultInterface: string | null = null;
  const interfaces: NetworkData['interfaces'] = [];
  for (const line of output.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    if (fields[0] === 'default') {
      defaultInterface = fields[1]?.slice(0, 128) || null;
      continue;
    }
    if (fields[0] !== 'iface' || !fields[1] || fields[1] === 'lo') continue;
    const attributes = Object.fromEntries(
      fields.slice(2).map((field) => {
        const separator = field.indexOf('=');
        return separator < 0
          ? [field, '']
          : [field.slice(0, separator), field.slice(separator + 1)];
      }),
    );
    const receivedBytes = counter(attributes.rx);
    const transmittedBytes = counter(attributes.tx);
    const old = previous?.data.interfaces.find(({ name }) => name === fields[1]);
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
      name: fields[1].slice(0, 128),
      state: attributes.state?.slice(0, 32) || null,
      ipv4: attributes.ipv4?.split('/')[0]?.slice(0, 64) || null,
      receivedBytes,
      transmittedBytes,
      receiveRate: ratesValid ? (receivedBytes - old.receivedBytes!) / elapsed : null,
      transmitRate: ratesValid ? (transmittedBytes - old.transmittedBytes!) / elapsed : null,
    });
    if (interfaces.length >= 32) break;
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
