/**
 * Platform-neutral Quick Connect parser.
 *
 * This module intentionally has no logging or persistence hooks. Credentials
 * parsed from a URL or `opts` are exposed only through `temporarySecret` and
 * must be forwarded directly to the session-creation request by callers.
 */

export const QUICK_CONNECT_INPUT_PROTOCOLS = [
  'ssh',
  'telnet',
  'vnc',
  'rdp',
  'spice',
  'serial',
  'ftp',
  'http',
  'https',
  'local',
  'axterm',
  'electerm',
] as const;

export type QuickConnectInputProtocol = (typeof QUICK_CONNECT_INPUT_PROTOCOLS)[number];
export type QuickConnectProtocol = Exclude<QuickConnectInputProtocol, 'axterm' | 'electerm'>;

export const QUICK_CONNECT_DEFAULT_PORTS = {
  ssh: 22,
  telnet: 23,
  vnc: 5900,
  rdp: 3389,
  spice: 5900,
  serial: undefined,
  ftp: 21,
  http: 80,
  https: 443,
  local: undefined,
  axterm: 22,
  electerm: 22,
} as const satisfies Readonly<Record<QuickConnectInputProtocol, number | undefined>>;

export const QUICK_CONNECT_LIMITS = Object.freeze({
  inputBytes: 16_384,
  queryBytes: 8_192,
  optsBytes: 8_192,
  titleBytes: 256,
  hostnameBytes: 253,
  usernameBytes: 256,
  secretBytes: 4_096,
  serialPathBytes: 1_024,
  optionStringBytes: 1_024,
  maxOptsProperties: 24,
  maxTunnels: 8,
  maxHops: 8,
});

export type QuickConnectSshTunnelKind =
  'forwardRemoteToLocal' | 'forwardLocalToRemote' | 'dynamicForward';

export interface QuickConnectSshTunnel {
  sshTunnel: QuickConnectSshTunnelKind;
  name?: string;
  sshTunnelLocalHost?: string;
  sshTunnelLocalPort?: number;
  sshTunnelRemoteHost?: string;
  sshTunnelRemotePort?: number;
}

export interface QuickConnectHop {
  hostname: string;
  port: number;
  username?: string;
  temporarySecret?: string;
  authType?: 'password' | 'agent';
  profile?: string;
}

interface QuickConnectBase<P extends QuickConnectProtocol> {
  protocol: P;
  title?: string;
  /** Ephemeral session credential. Callers must never persist this value. */
  temporarySecret?: string;
}

interface QuickConnectNetworkBase<
  P extends Exclude<QuickConnectProtocol, 'serial' | 'http' | 'https'>,
> extends QuickConnectBase<P> {
  hostname: string;
  port: number;
  username?: string;
}

export interface QuickConnectSshTarget extends QuickConnectNetworkBase<'ssh'> {
  enableSsh: boolean;
  enableSftp: boolean;
  useSshAgent: boolean;
  authType: 'password' | 'privateKey' | 'agent';
  term: string;
  encode: string;
  envLang: string;
  credentialGrantId?: string;
  temporaryPassphrase?: string;
  environment?: Readonly<Record<string, string>>;
  initialDirectoryGrantId?: string;
  sshTunnels?: readonly QuickConnectSshTunnel[];
  connectionHoppings?: readonly QuickConnectHop[];
}

export interface QuickConnectTelnetTarget extends QuickConnectNetworkBase<'telnet'> {
  loginPrompt?: string;
  passwordPrompt?: string;
}

export interface QuickConnectVncTarget extends QuickConnectNetworkBase<'vnc'> {
  viewOnly: boolean;
  clipViewport: boolean;
  scaleViewport: boolean;
  qualityLevel: number;
  compressionLevel: number;
  shared: boolean;
}

export interface QuickConnectRdpTarget extends QuickConnectNetworkBase<'rdp'> {
  domain?: string;
}

export interface QuickConnectSpiceTarget extends QuickConnectNetworkBase<'spice'> {
  viewOnly: boolean;
  scaleViewport: boolean;
}

export interface QuickConnectFtpTarget extends QuickConnectNetworkBase<'ftp'> {
  encode: string;
  secure: boolean;
}

export interface QuickConnectSerialTarget extends QuickConnectBase<'serial'> {
  path: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 1.5 | 2;
  parity: 'none' | 'even' | 'odd' | 'mark' | 'space';
  lock: boolean;
  rtscts: boolean;
  xon: boolean;
  xoff: boolean;
  xany: boolean;
  term: string;
  displayRaw: boolean;
}

export interface QuickConnectWebTarget extends QuickConnectBase<'http' | 'https'> {
  /** Complete web destination, including path, query and fragment but without URL userinfo. */
  url: string;
  username?: string;
  userAgent?: string;
}

export interface QuickConnectLocalTarget extends QuickConnectBase<'local'> {
  initialDirectoryGrantId?: string;
  batchOperationGrantId?: string;
}

export type QuickConnectTarget =
  | QuickConnectSshTarget
  | QuickConnectTelnetTarget
  | QuickConnectVncTarget
  | QuickConnectRdpTarget
  | QuickConnectSpiceTarget
  | QuickConnectFtpTarget
  | QuickConnectSerialTarget
  | QuickConnectWebTarget
  | QuickConnectLocalTarget;

type JsonRecord = Record<string, unknown>;

const INVALID = Symbol('invalid-quick-connect');
const ignoredUpstreamKeys = new Set(['host', 'type']);

const commonOptionKeys = ['title', 'username', 'password', 'port'] as const;
const allowedOptionKeys: Readonly<Record<QuickConnectProtocol, ReadonlySet<string>>> = {
  ssh: new Set([
    ...commonOptionKeys,
    'enableSsh',
    'enableSftp',
    'useSshAgent',
    'authType',
    'term',
    'encode',
    'envLang',
    'sshTunnels',
    'connectionHoppings',
    'credentialGrantId',
    'temporaryPassphrase',
    'environment',
    'initialDirectoryGrantId',
  ]),
  telnet: new Set([...commonOptionKeys, 'loginPrompt', 'passwordPrompt']),
  vnc: new Set([
    ...commonOptionKeys,
    'viewOnly',
    'clipViewport',
    'scaleViewport',
    'qualityLevel',
    'compressionLevel',
    'shared',
  ]),
  rdp: new Set([...commonOptionKeys, 'domain']),
  spice: new Set([...commonOptionKeys, 'viewOnly', 'scaleViewport']),
  ftp: new Set([...commonOptionKeys, 'user', 'encode', 'secure']),
  serial: new Set([
    'title',
    'baudRate',
    'dataBits',
    'stopBits',
    'parity',
    'lock',
    'rtscts',
    'xon',
    'xoff',
    'xany',
    'term',
    'displayRaw',
  ]),
  http: new Set(['title', 'username', 'password', 'useragent', 'userAgent']),
  https: new Set(['title', 'username', 'password', 'useragent', 'userAgent']),
  local: new Set(['title', 'initialDirectoryGrantId', 'batchOperationGrantId']),
};

function fail(): never {
  throw INVALID;
}

function utf8Bytes(value: string): number {
  let length = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 0x7f) length += 1;
    else if (codePoint <= 0x7ff) length += 2;
    else if (codePoint <= 0xffff) length += 3;
    else length += 4;
  }
  return length;
}

function withinBytes(value: string, maximum: number): boolean {
  return utf8Bytes(value) <= maximum;
}

function hasUnsafeControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return fail();
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function optionalString(
  record: JsonRecord,
  key: string,
  maximum: number = QUICK_CONNECT_LIMITS.optionStringBytes,
): string | undefined {
  if (!hasOwn(record, key)) return undefined;
  const value = record[key];
  if (typeof value !== 'string' || hasUnsafeControl(value) || !withinBytes(value, maximum)) fail();
  return value;
}

function optionalNonEmptyString(
  record: JsonRecord,
  key: string,
  maximum: number = QUICK_CONNECT_LIMITS.optionStringBytes,
): string | undefined {
  const value = optionalString(record, key, maximum);
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) fail();
  return trimmed;
}

function optionalBoolean(record: JsonRecord, key: string): boolean | undefined {
  if (!hasOwn(record, key)) return undefined;
  const value = record[key];
  if (typeof value !== 'boolean') fail();
  return value;
}

function optionalInteger(
  record: JsonRecord,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (!hasOwn(record, key)) return undefined;
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum)
    fail();
  return value;
}

function optionalNumberFromSet<const T extends number>(
  record: JsonRecord,
  key: string,
  allowed: readonly T[],
): T | undefined {
  if (!hasOwn(record, key)) return undefined;
  const value = record[key];
  if (typeof value !== 'number' || !allowed.includes(value as T)) fail();
  return value as T;
}

function optionalEnum<const T extends string>(
  record: JsonRecord,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = optionalString(record, key);
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) fail();
  return value as T;
}

function optionalEnvironment(record: JsonRecord): Readonly<Record<string, string>> | undefined {
  if (!hasOwn(record, 'environment')) return undefined;
  const value = record.environment;
  if (!isRecord(value) || Object.keys(value).length > 64) fail();
  const result: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof item !== 'string') fail();
    if (hasUnsafeControl(item) || !withinBytes(item, 4_096)) fail();
    result[name] = item;
  }
  return result;
}

function validateHostname(value: string): string {
  const normalized = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (
    !normalized ||
    hasUnsafeControl(normalized) ||
    /\s/.test(normalized) ||
    !withinBytes(normalized, QUICK_CONNECT_LIMITS.hostnameBytes)
  )
    fail();
  return normalized;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  if (!/^\d{1,5}$/.test(value)) fail();
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) fail();
  return parsed;
}

function validateOptsKeys(protocol: QuickConnectProtocol, opts: JsonRecord): void {
  const keys = Object.keys(opts);
  if (keys.length > QUICK_CONNECT_LIMITS.maxOptsProperties) fail();
  const allowed = allowedOptionKeys[protocol];
  for (const key of keys) {
    if (ignoredUpstreamKeys.has(key)) continue;
    if (!allowed.has(key)) fail();
  }
}

function unwrapOptsString(raw: string): string {
  let value = raw.trim();
  if (!value) fail();
  const first = value[0];
  if (first === "'" || first === '"') {
    if (value.at(-1) !== first) fail();
    value = value.slice(1, -1);
  }
  return value;
}

function parseOpts(raw: string | undefined): JsonRecord {
  if (raw === undefined) return {};
  if (!withinBytes(raw, QUICK_CONNECT_LIMITS.optsBytes)) fail();

  const direct = unwrapOptsString(raw);
  const candidates = [direct];
  if (/%[\da-f]{2}/i.test(direct) || direct.includes('+')) {
    const decoded = decodeComponent(direct.replace(/\+/g, ' '));
    candidates.push(unwrapOptsString(decoded));
  }

  for (const candidate of candidates) {
    if (!withinBytes(candidate, QUICK_CONNECT_LIMITS.optsBytes)) fail();
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (!isRecord(parsed)) fail();
      return parsed;
    } catch (error) {
      if (error === INVALID) throw error;
    }
  }
  return fail();
}

interface ExtractedInput {
  source: string;
  opts?: string;
}

function extractOpts(source: string): ExtractedInput {
  const fragmentIndex = source.indexOf('#');
  const match = /[?&]opts=/.exec(source);
  if (!match) return { source };
  if (fragmentIndex >= 0 && match.index > fragmentIndex) fail();
  const valueStart = match.index + match[0].length;
  return {
    source: source.slice(0, match.index),
    opts: source.slice(valueStart),
  };
}

function queryOf(source: string): string {
  const queryStart = source.indexOf('?');
  if (queryStart < 0) return '';
  const fragmentStart = source.indexOf('#', queryStart + 1);
  const query = source.slice(queryStart + 1, fragmentStart < 0 ? undefined : fragmentStart);
  if (!withinBytes(query, QUICK_CONNECT_LIMITS.queryBytes)) fail();
  return query;
}

function optionalQueryTitle(params: URLSearchParams): string | undefined {
  const title = params.get('title');
  if (title === null) return undefined;
  if (hasUnsafeControl(title) || !withinBytes(title, QUICK_CONNECT_LIMITS.titleBytes)) fail();
  return title;
}

function parseSshTunnels(opts: JsonRecord): readonly QuickConnectSshTunnel[] | undefined {
  if (!hasOwn(opts, 'sshTunnels')) return undefined;
  const value = opts.sshTunnels;
  if (!Array.isArray(value) || value.length > QUICK_CONNECT_LIMITS.maxTunnels) fail();
  return value.map((item): QuickConnectSshTunnel => {
    if (!isRecord(item)) fail();
    const allowed = new Set([
      'sshTunnel',
      'name',
      'sshTunnelLocalHost',
      'sshTunnelLocalPort',
      'sshTunnelRemoteHost',
      'sshTunnelRemotePort',
    ]);
    if (Object.keys(item).some((key) => !allowed.has(key))) fail();
    const sshTunnel = optionalEnum(item, 'sshTunnel', [
      'forwardRemoteToLocal',
      'forwardLocalToRemote',
      'dynamicForward',
    ] as const);
    if (!sshTunnel) fail();
    const name = optionalString(item, 'name', QUICK_CONNECT_LIMITS.titleBytes);
    const localHostValue = optionalNonEmptyString(
      item,
      'sshTunnelLocalHost',
      QUICK_CONNECT_LIMITS.hostnameBytes,
    );
    const remoteHostValue = optionalNonEmptyString(
      item,
      'sshTunnelRemoteHost',
      QUICK_CONNECT_LIMITS.hostnameBytes,
    );
    const sshTunnelLocalHost =
      localHostValue === undefined ? undefined : validateHostname(localHostValue);
    const sshTunnelRemoteHost =
      remoteHostValue === undefined ? undefined : validateHostname(remoteHostValue);
    const sshTunnelLocalPort = optionalInteger(item, 'sshTunnelLocalPort', 1, 65_535);
    const sshTunnelRemotePort = optionalInteger(item, 'sshTunnelRemotePort', 1, 65_535);
    if (sshTunnel === 'dynamicForward' && sshTunnelLocalPort === undefined) fail();
    if (
      sshTunnel !== 'dynamicForward' &&
      (sshTunnelLocalPort === undefined ||
        sshTunnelRemoteHost === undefined ||
        sshTunnelRemotePort === undefined)
    )
      fail();
    return {
      sshTunnel,
      ...(name === undefined ? {} : { name }),
      ...(sshTunnelLocalHost === undefined ? {} : { sshTunnelLocalHost }),
      ...(sshTunnelLocalPort === undefined ? {} : { sshTunnelLocalPort }),
      ...(sshTunnelRemoteHost === undefined ? {} : { sshTunnelRemoteHost }),
      ...(sshTunnelRemotePort === undefined ? {} : { sshTunnelRemotePort }),
    };
  });
}

function parseConnectionHoppings(opts: JsonRecord): readonly QuickConnectHop[] | undefined {
  if (!hasOwn(opts, 'connectionHoppings')) return undefined;
  const value = opts.connectionHoppings;
  if (!Array.isArray(value) || value.length > QUICK_CONNECT_LIMITS.maxHops) fail();
  return value.map((item): QuickConnectHop => {
    if (!isRecord(item)) fail();
    const allowed = new Set(['host', 'port', 'username', 'password', 'authType', 'profile']);
    if (Object.keys(item).some((key) => !allowed.has(key))) fail();
    const host = optionalNonEmptyString(item, 'host', QUICK_CONNECT_LIMITS.hostnameBytes);
    if (!host) fail();
    const hostname = validateHostname(host);
    const port = optionalInteger(item, 'port', 1, 65_535) ?? 22;
    const username = optionalNonEmptyString(item, 'username', QUICK_CONNECT_LIMITS.usernameBytes);
    const temporarySecret = optionalString(item, 'password', QUICK_CONNECT_LIMITS.secretBytes);
    const authType = optionalEnum(item, 'authType', ['password', 'agent'] as const);
    const profile = optionalNonEmptyString(item, 'profile', QUICK_CONNECT_LIMITS.optionStringBytes);
    return {
      hostname,
      port,
      ...(username === undefined ? {} : { username }),
      ...(temporarySecret === undefined ? {} : { temporarySecret }),
      ...(authType === undefined ? {} : { authType }),
      ...(profile === undefined ? {} : { profile }),
    };
  });
}

function credentialsFrom(
  url: URL,
  opts: JsonRecord,
): {
  username?: string;
  temporarySecret?: string;
} {
  const urlUsername = url.username ? decodeComponent(url.username) : undefined;
  const urlSecret = url.password ? decodeComponent(url.password) : undefined;
  const optsUsername = optionalNonEmptyString(opts, 'username', QUICK_CONNECT_LIMITS.usernameBytes);
  const optsSecret = optionalString(opts, 'password', QUICK_CONNECT_LIMITS.secretBytes);
  const username = optsUsername ?? urlUsername;
  const temporarySecret = optsSecret ?? urlSecret;
  if (
    username !== undefined &&
    (hasUnsafeControl(username) || !withinBytes(username, QUICK_CONNECT_LIMITS.usernameBytes))
  )
    fail();
  if (
    temporarySecret !== undefined &&
    (hasUnsafeControl(temporarySecret) ||
      !withinBytes(temporarySecret, QUICK_CONNECT_LIMITS.secretBytes))
  )
    fail();
  return {
    ...(username === undefined || username === '' ? {} : { username }),
    ...(temporarySecret === undefined || temporarySecret === '' ? {} : { temporarySecret }),
  };
}

function titleFrom(params: URLSearchParams, opts: JsonRecord): string | undefined {
  return (
    optionalString(opts, 'title', QUICK_CONNECT_LIMITS.titleBytes) ?? optionalQueryTitle(params)
  );
}

function withSpicePasswordSyntax(source: string): string {
  const scheme = /^([a-z][a-z\d+.-]*):\/\//i.exec(source);
  if (!scheme) return source;
  const authorityStart = scheme[0].length;
  const rest = source.slice(authorityStart);
  const authorityEndOffset = rest.search(/[/?#]/);
  const authority = authorityEndOffset < 0 ? rest : rest.slice(0, authorityEndOffset);
  if (authority.includes('@') || authority.includes('[')) return source;
  const lastColon = authority.lastIndexOf(':');
  if (lastColon <= 0 || !/^\d{1,5}$/.test(authority.slice(lastColon + 1))) return source;
  const beforePort = authority.slice(0, lastColon);
  const passwordSeparator = beforePort.lastIndexOf(':');
  if (passwordSeparator <= 0) return source;
  const password = beforePort.slice(0, passwordSeparator);
  const hostname = beforePort.slice(passwordSeparator + 1);
  if (!hostname) return source;
  const suffix = authorityEndOffset < 0 ? '' : rest.slice(authorityEndOffset);
  return `${scheme[1]}://:${encodeURIComponent(password)}@${hostname}:${authority.slice(lastColon + 1)}${suffix}`;
}

function parseUrl(source: string, protocol: QuickConnectProtocol): URL {
  try {
    return new URL(source);
  } catch {
    if (protocol !== 'spice') fail();
    try {
      return new URL(withSpicePasswordSyntax(source));
    } catch {
      return fail();
    }
  }
}

function serialPathFrom(source: string): { path: string; baudRate?: number } {
  const scheme = /^[a-z][a-z\d+.-]*:\/\//i.exec(source);
  if (!scheme) fail();
  const rest = source.slice(scheme[0].length);
  const end = rest.search(/[?#]/);
  let path = end < 0 ? rest : rest.slice(0, end);
  let baudRate: number | undefined;
  const colon = path.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(path.slice(colon + 1))) {
    baudRate = Number(path.slice(colon + 1));
    path = path.slice(0, colon);
  }
  path = decodeComponent(path);
  if (!path || hasUnsafeControl(path) || !withinBytes(path, QUICK_CONNECT_LIMITS.serialPathBytes))
    fail();
  if (
    baudRate !== undefined &&
    (!Number.isInteger(baudRate) || baudRate < 1 || baudRate > 4_000_000)
  )
    fail();
  return { path, ...(baudRate === undefined ? {} : { baudRate }) };
}

function queryInteger(
  params: URLSearchParams,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = params.get(key);
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) fail();
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) fail();
  return parsed;
}

function parseSerial(
  source: string,
  params: URLSearchParams,
  opts: JsonRecord,
): QuickConnectSerialTarget {
  validateOptsKeys('serial', opts);
  const parsedPath = serialPathFrom(source);
  const baudRate =
    optionalInteger(opts, 'baudRate', 1, 4_000_000) ??
    queryInteger(params, 'baudRate', 1, 4_000_000) ??
    parsedPath.baudRate ??
    9600;
  const dataBits = optionalNumberFromSet(opts, 'dataBits', [5, 6, 7, 8] as const) ?? 8;
  const stopBits = optionalNumberFromSet(opts, 'stopBits', [1, 1.5, 2] as const) ?? 1;
  const parity =
    optionalEnum(opts, 'parity', ['none', 'even', 'odd', 'mark', 'space'] as const) ?? 'none';
  const title = titleFrom(params, opts);
  return {
    protocol: 'serial',
    path: parsedPath.path,
    baudRate,
    dataBits,
    stopBits,
    parity,
    lock: optionalBoolean(opts, 'lock') ?? true,
    rtscts: optionalBoolean(opts, 'rtscts') ?? false,
    xon: optionalBoolean(opts, 'xon') ?? false,
    xoff: optionalBoolean(opts, 'xoff') ?? false,
    xany: optionalBoolean(opts, 'xany') ?? false,
    term: optionalNonEmptyString(opts, 'term') ?? 'xterm-256color',
    displayRaw: optionalBoolean(opts, 'displayRaw') ?? false,
    ...(title === undefined ? {} : { title }),
  };
}

function webUrl(
  url: URL,
  protocol: 'http' | 'https',
  params: URLSearchParams,
  hadExplicitPath: boolean,
): string {
  params.delete('opts');
  const hostname = url.hostname;
  if (!hostname) fail();
  const explicitPort = url.port ? Number(url.port) : undefined;
  if (
    explicitPort !== undefined &&
    (!Number.isInteger(explicitPort) || explicitPort < 1 || explicitPort > 65_535)
  )
    fail();
  const port =
    explicitPort === undefined || explicitPort === QUICK_CONNECT_DEFAULT_PORTS[protocol]
      ? ''
      : `:${explicitPort}`;
  const path = url.pathname === '/' && !hadExplicitPath ? '' : url.pathname;
  const query = params.toString();
  return `${protocol}://${hostname}${port}${path}${query ? `?${query}` : ''}${url.hash}`;
}

function parseWeb(
  source: string,
  protocol: 'http' | 'https',
  params: URLSearchParams,
  opts: JsonRecord,
  fromElecterm: boolean,
): QuickConnectWebTarget {
  validateOptsKeys(protocol, opts);
  const url = parseUrl(source, protocol);
  if (fromElecterm) {
    params.delete('type');
    params.delete('tp');
  }
  const afterAuthority = source.slice(source.indexOf('://') + 3).split(/[?#]/, 1)[0] ?? '';
  const authorityWithoutUserInfo = afterAuthority.slice(afterAuthority.lastIndexOf('@') + 1);
  const hadExplicitPath = authorityWithoutUserInfo.includes('/');
  const credentials = credentialsFrom(url, opts);
  const title = titleFrom(params, opts);
  const userAgent = optionalString(opts, 'userAgent') ?? optionalString(opts, 'useragent');
  return {
    protocol,
    url: webUrl(url, protocol, params, hadExplicitPath),
    ...credentials,
    ...(title === undefined ? {} : { title }),
    ...(userAgent === undefined ? {} : { userAgent }),
  };
}

function parseLocal(
  source: string,
  params: URLSearchParams,
  opts: JsonRecord,
): QuickConnectLocalTarget {
  validateOptsKeys('local', opts);
  const url = parseUrl(source, 'local');
  if (url.hostname !== 'terminal' || (url.pathname !== '' && url.pathname !== '/') || url.hash)
    fail();
  const title = titleFrom(params, opts);
  const initialDirectoryGrantId = optionalNonEmptyString(opts, 'initialDirectoryGrantId', 256);
  const batchOperationGrantId = optionalNonEmptyString(opts, 'batchOperationGrantId', 256);
  if (initialDirectoryGrantId && batchOperationGrantId) fail();
  return {
    protocol: 'local',
    ...(title === undefined ? {} : { title }),
    ...(initialDirectoryGrantId === undefined ? {} : { initialDirectoryGrantId }),
    ...(batchOperationGrantId === undefined ? {} : { batchOperationGrantId }),
  };
}

function parseNetwork(
  source: string,
  protocol: Exclude<QuickConnectProtocol, 'serial' | 'http' | 'https' | 'local'>,
  params: URLSearchParams,
  opts: JsonRecord,
): QuickConnectTarget {
  validateOptsKeys(protocol, opts);
  const url = parseUrl(source, protocol);
  if (!url.hostname || (url.pathname !== '' && url.pathname !== '/') || url.hash) fail();
  const hostname = validateHostname(url.hostname);
  const optsPort = optionalInteger(opts, 'port', 1, 65_535);
  const defaultPort = QUICK_CONNECT_DEFAULT_PORTS[protocol];
  const port = optsPort ?? parsePort(url.port || undefined, defaultPort);
  const credentials = credentialsFrom(url, opts);
  const title = titleFrom(params, opts);
  const common = {
    hostname,
    port,
    ...credentials,
    ...(title === undefined ? {} : { title }),
  };

  switch (protocol) {
    case 'ssh': {
      const sshTunnels = parseSshTunnels(opts);
      const connectionHoppings = parseConnectionHoppings(opts);
      const credentialGrantId = optionalNonEmptyString(opts, 'credentialGrantId', 256);
      const temporaryPassphrase = optionalString(
        opts,
        'temporaryPassphrase',
        QUICK_CONNECT_LIMITS.secretBytes,
      );
      const environment = optionalEnvironment(opts);
      const initialDirectoryGrantId = optionalNonEmptyString(opts, 'initialDirectoryGrantId', 256);
      return {
        protocol,
        ...common,
        enableSsh: optionalBoolean(opts, 'enableSsh') ?? true,
        enableSftp: optionalBoolean(opts, 'enableSftp') ?? true,
        useSshAgent: optionalBoolean(opts, 'useSshAgent') ?? true,
        authType:
          optionalEnum(opts, 'authType', ['password', 'privateKey', 'agent'] as const) ??
          'password',
        term: optionalNonEmptyString(opts, 'term') ?? 'xterm-256color',
        encode: optionalNonEmptyString(opts, 'encode') ?? 'utf-8',
        envLang: optionalNonEmptyString(opts, 'envLang') ?? 'en_US.UTF-8',
        ...(sshTunnels === undefined ? {} : { sshTunnels }),
        ...(connectionHoppings === undefined ? {} : { connectionHoppings }),
        ...(credentialGrantId === undefined ? {} : { credentialGrantId }),
        ...(temporaryPassphrase === undefined ? {} : { temporaryPassphrase }),
        ...(environment === undefined ? {} : { environment }),
        ...(initialDirectoryGrantId === undefined ? {} : { initialDirectoryGrantId }),
      };
    }
    case 'telnet': {
      const loginPrompt = optionalString(opts, 'loginPrompt');
      const passwordPrompt = optionalString(opts, 'passwordPrompt');
      return {
        protocol,
        ...common,
        ...(loginPrompt === undefined ? {} : { loginPrompt }),
        ...(passwordPrompt === undefined ? {} : { passwordPrompt }),
      };
    }
    case 'vnc':
      return {
        protocol,
        ...common,
        viewOnly: optionalBoolean(opts, 'viewOnly') ?? false,
        clipViewport: optionalBoolean(opts, 'clipViewport') ?? false,
        scaleViewport: optionalBoolean(opts, 'scaleViewport') ?? true,
        qualityLevel: optionalInteger(opts, 'qualityLevel', 0, 9) ?? 3,
        compressionLevel: optionalInteger(opts, 'compressionLevel', 0, 9) ?? 1,
        shared: optionalBoolean(opts, 'shared') ?? true,
      };
    case 'rdp': {
      const domain = optionalString(opts, 'domain');
      return {
        protocol,
        ...common,
        ...(domain === undefined ? {} : { domain }),
      };
    }
    case 'spice':
      return {
        protocol,
        ...common,
        viewOnly: optionalBoolean(opts, 'viewOnly') ?? false,
        scaleViewport: optionalBoolean(opts, 'scaleViewport') ?? true,
      };
    case 'ftp': {
      const optsUser = optionalNonEmptyString(opts, 'user', QUICK_CONNECT_LIMITS.usernameBytes);
      return {
        protocol,
        ...common,
        ...(optsUser === undefined ? {} : { username: optsUser }),
        encode: optionalNonEmptyString(opts, 'encode') ?? 'utf-8',
        secure: optionalBoolean(opts, 'secure') ?? false,
      };
    }
  }
}

function resolvedProtocol(
  inputProtocol: QuickConnectInputProtocol,
  params: URLSearchParams,
): { protocol: QuickConnectProtocol; fromElecterm: boolean } {
  if (inputProtocol !== 'electerm' && inputProtocol !== 'axterm')
    return { protocol: inputProtocol, fromElecterm: false };
  const requested = (params.get('type') ?? params.get('tp') ?? 'ssh').toLowerCase();
  if (requested === 'electerm' || requested === 'web') fail();
  if (!(QUICK_CONNECT_INPUT_PROTOCOLS as readonly string[]).includes(requested)) fail();
  return { protocol: requested as QuickConnectProtocol, fromElecterm: true };
}

/**
 * Parse an Electerm-compatible Quick Connect address into a bounded, typed
 * Axterm session target. Invalid input returns `null`; this function never logs.
 */
export function parseQuickConnect(input: unknown): QuickConnectTarget | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || !withinBytes(trimmed, QUICK_CONNECT_LIMITS.inputBytes)) return null;

  try {
    const extracted = extractOpts(trimmed);
    let source = extracted.source;
    const explicitScheme = /^([a-z][a-z\d+.-]*):\/\//i.exec(source);
    let inputProtocol: QuickConnectInputProtocol;
    if (explicitScheme) {
      const candidate = explicitScheme[1]?.toLowerCase();
      if (!candidate || !(QUICK_CONNECT_INPUT_PROTOCOLS as readonly string[]).includes(candidate))
        return null;
      inputProtocol = candidate as QuickConnectInputProtocol;
    } else {
      if (source.includes('://')) return null;
      inputProtocol = 'ssh';
      source = `ssh://${source}`;
    }

    const query = queryOf(source);
    const params = new URLSearchParams(query);
    const { protocol, fromElecterm } = resolvedProtocol(inputProtocol, params);
    const opts = parseOpts(extracted.opts);

    if (protocol === 'local') return parseLocal(source, params, opts);
    if (protocol === 'serial') return parseSerial(source, params, opts);
    if (protocol === 'http' || protocol === 'https')
      return parseWeb(source, protocol, params, opts, fromElecterm);
    return parseNetwork(source, protocol, params, opts);
  } catch {
    return null;
  }
}

export function getDefaultQuickConnectPort(
  protocol: QuickConnectInputProtocol,
): number | undefined {
  return QUICK_CONNECT_DEFAULT_PORTS[protocol];
}

export function getSupportedQuickConnectProtocols(): QuickConnectInputProtocol[] {
  return [...QUICK_CONNECT_INPUT_PROTOCOLS];
}
