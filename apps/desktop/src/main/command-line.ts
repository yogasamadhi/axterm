import { isAbsolute, resolve } from 'node:path';
import { parseQuickConnect } from '@workspace/shared';

const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 16_384;
const MAX_TOTAL_BYTES = 32_768;
const supportedProtocols = new Set([
  'ssh',
  'telnet',
  'rdp',
  'vnc',
  'serial',
  'spice',
  'ftp',
  'http',
  'https',
  'local',
]);
const directSourcePattern =
  /^(?:ssh|telnet|rdp|vnc|serial|spice|ftp|https?|axterm|electerm|local):\/\//i;

export const DESKTOP_COMMAND_LINE_HELP = `Axterm command line

Usage:
  axterm [options] [user@]host[:port]
  axterm <local|ssh|telnet|rdp|vnc|serial|spice|ftp|http|https|axterm|electerm>://...

Session options:
  -t,  --title <name>             tab title
  -l,  --user <user>              SSH/login username
  -P,  --port <port>              connection port
  -bo, --batch-op <path>          run a bounded batch-operation JSON file
  -pw, --password <password>      transient session password
  -i,  --private-key-path <path>  transient SSH private key file
  -ps, --passphrase <value>       transient private-key passphrase
  -se, --set-env <A=1 B=2>        SSH environment values
  -so, --sftp-only                open an SSH connection for file access
  -d,  --init-folder <path>       local terminal or file-workspace directory
  -tp, --tp <type>                connection type
  -opts, --opts <json>            Electerm-compatible typed connection options
       --new-window               create another application window
  -h,  --help                     show this help
  -V,  --version                  show the Axterm version

Secrets supplied on the command line are used for this launch only and are not saved.`;

export type DesktopCommandLineResult =
  | { kind: 'none'; newWindow: boolean }
  | { kind: 'help'; newWindow: boolean }
  | { kind: 'version'; newWindow: boolean }
  | { kind: 'error'; newWindow: boolean; errorCode: string }
  | {
      kind: 'session';
      newWindow: boolean;
      source: string;
      privateKeyPath?: string;
      initialDirectoryPath?: string;
      batchOperationPath?: string;
    };

interface ParsedArguments {
  values: Record<string, string>;
  flags: Set<string>;
  positional: string[];
  newWindow: boolean;
}

const valueOptions = new Map<string, string>([
  ['-t', 'title'],
  ['--title', 'title'],
  ['-l', 'user'],
  ['--user', 'user'],
  ['-P', 'port'],
  ['--port', 'port'],
  ['-pw', 'password'],
  ['--password', 'password'],
  ['-i', 'privateKeyPath'],
  ['--private-key-path', 'privateKeyPath'],
  ['-ps', 'passphrase'],
  ['--passphrase', 'passphrase'],
  ['-se', 'setEnv'],
  ['--set-env', 'setEnv'],
  ['-d', 'initialDirectory'],
  ['--init-folder', 'initialDirectory'],
  ['-tp', 'protocol'],
  ['--tp', 'protocol'],
  ['-opts', 'opts'],
  ['--opts', 'opts'],
]);
const flagOptions = new Map<string, string>([
  ['-so', 'sftpOnly'],
  ['--sftp-only', 'sftpOnly'],
  ['-h', 'help'],
  ['--help', 'help'],
  ['-V', 'version'],
  ['--version', 'version'],
  ['--new-window', 'newWindow'],
]);
const ignoredElectronOptions = [
  '--user-data-dir',
  '--inspect',
  '--inspect-brk',
  '--remote-debugging-port',
  '--disable-gpu',
  '--no-sandbox',
  '--enable-logging',
];

export function parseDesktopCommandLine(
  argv: readonly string[],
  workingDirectory = process.cwd(),
): DesktopCommandLineResult {
  try {
    const parsed = parseArguments(argv);
    const base = { newWindow: parsed.newWindow };
    if (parsed.flags.has('help')) return { kind: 'help', ...base };
    if (parsed.flags.has('version')) return { kind: 'version', ...base };
    if (parsed.values.serverPort)
      return { kind: 'error', ...base, errorCode: 'CLI_FIXED_RUNTIME_PORT_UNSUPPORTED' };

    if (parsed.values.batchOperation) {
      const source = 'local://terminal';
      return {
        kind: 'session',
        ...base,
        source,
        batchOperationPath: resolveCommandLinePath(parsed.values.batchOperation, workingDirectory),
      };
    }

    const direct = parsed.positional.find((value) => directSourcePattern.test(value));
    if (direct) {
      if (!parseQuickConnect(direct))
        return { kind: 'error', ...base, errorCode: 'CLI_INVALID_TARGET' };
      return { kind: 'session', ...base, source: direct };
    }

    const rawOptions = parseOptionsJson(parsed.values.opts);
    const protocol = normalizedProtocol(parsed.values.protocol ?? rawOptions.type ?? 'ssh');
    delete rawOptions.type;
    if (parsed.values.initialDirectory && protocol !== 'local' && protocol !== 'ssh')
      return { kind: 'error', ...base, errorCode: 'CLI_INIT_FOLDER_REQUIRES_LOCAL' };
    const target = parsed.positional.at(-1) ?? stringOption(rawOptions.host);
    delete rawOptions.host;

    const privateKeyPath = parsed.values.privateKeyPath;
    if (privateKeyPath && protocol !== 'ssh')
      return { kind: 'error', ...base, errorCode: 'CLI_PRIVATE_KEY_REQUIRES_SSH' };
    if (privateKeyPath) rawOptions.authType = 'privateKey';
    if (parsed.values.title !== undefined) rawOptions.title = parsed.values.title;
    if (parsed.values.user !== undefined) rawOptions.username = parsed.values.user;
    if (parsed.values.password !== undefined) rawOptions.password = parsed.values.password;
    if (parsed.values.passphrase !== undefined)
      rawOptions.temporaryPassphrase = parsed.values.passphrase;
    if (parsed.values.port !== undefined) rawOptions.port = parsePort(parsed.values.port);
    if (parsed.flags.has('sftpOnly')) {
      rawOptions.enableSsh = false;
      rawOptions.enableSftp = true;
    }
    if (parsed.values.setEnv !== undefined)
      rawOptions.environment = parseEnvironment(parsed.values.setEnv);

    let source: string;
    if (protocol === 'local') source = withOptions('local://terminal', rawOptions);
    else if (protocol === 'serial') {
      const serialPath = target ?? stringOption(rawOptions.port);
      delete rawOptions.port;
      if (!serialPath) return { kind: 'error', ...base, errorCode: 'CLI_TARGET_REQUIRED' };
      source = withOptions(`serial://${encodeURIComponent(serialPath)}`, rawOptions);
    } else {
      if (!target) return { kind: 'none', ...base };
      const host = normalizeTarget(target, protocol, rawOptions);
      source = withOptions(`${protocol}://${host}`, rawOptions);
    }
    if (!parseQuickConnect(source))
      return { kind: 'error', ...base, errorCode: 'CLI_INVALID_TARGET' };
    return {
      kind: 'session',
      ...base,
      source,
      ...(privateKeyPath
        ? { privateKeyPath: resolveCommandLinePath(privateKeyPath, workingDirectory) }
        : {}),
      ...(parsed.values.initialDirectory
        ? {
            initialDirectoryPath: resolveCommandLinePath(
              parsed.values.initialDirectory,
              workingDirectory,
            ),
          }
        : {}),
    };
  } catch (error) {
    return {
      kind: 'error',
      newWindow: argv.includes('--new-window'),
      errorCode: error instanceof CommandLineError ? error.code : 'CLI_INVALID_ARGUMENTS',
    };
  }
}

export function materializeDesktopCommandLine(
  parsed: Extract<DesktopCommandLineResult, { kind: 'session' }>,
  grants: {
    privateKeyGrantId?: string;
    initialDirectoryGrantId?: string;
    batchOperationGrantId?: string;
  } = {},
): string {
  if (!grants.privateKeyGrantId && !grants.initialDirectoryGrantId && !grants.batchOperationGrantId)
    return parsed.source;
  const extracted = extractOptions(parsed.source);
  const options = parseOptionsJson(extracted.options);
  if (grants.privateKeyGrantId) options.credentialGrantId = grants.privateKeyGrantId;
  if (grants.initialDirectoryGrantId)
    options.initialDirectoryGrantId = grants.initialDirectoryGrantId;
  if (grants.batchOperationGrantId) options.batchOperationGrantId = grants.batchOperationGrantId;
  return withOptions(extracted.source, options);
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  if (argv.length > MAX_ARGUMENTS) throw new CommandLineError('CLI_TOO_MANY_ARGUMENTS');
  if (argv.reduce((size, value) => size + Buffer.byteLength(value), 0) > MAX_TOTAL_BYTES)
    throw new CommandLineError('CLI_ARGUMENTS_TOO_LARGE');
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const positional: string[] = [];
  let literal = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (Buffer.byteLength(argument) > MAX_ARGUMENT_BYTES)
      throw new CommandLineError('CLI_ARGUMENT_TOO_LARGE');
    if (!literal && argument === '--') {
      literal = true;
      continue;
    }
    if (!literal) {
      const equals = argument.startsWith('--') ? argument.indexOf('=') : -1;
      const key = equals > 0 ? argument.slice(0, equals) : argument;
      const inlineValue = equals > 0 ? argument.slice(equals + 1) : undefined;
      const valueName = valueOptions.get(key);
      if (valueName) {
        const value = inlineValue ?? argv[++index];
        if (value === undefined || (!inlineValue && value.startsWith('-')))
          throw new CommandLineError('CLI_OPTION_VALUE_REQUIRED');
        values[valueName] = value;
        continue;
      }
      const flagName = flagOptions.get(key);
      if (flagName) {
        flags.add(flagName);
        continue;
      }
      if (key === '-bo' || key === '--batch-op' || key === '-sp' || key === '--server-port') {
        const value = inlineValue ?? argv[++index];
        if (value === undefined || (!inlineValue && value.startsWith('-')))
          throw new CommandLineError('CLI_OPTION_VALUE_REQUIRED');
        values[key === '-bo' || key === '--batch-op' ? 'batchOperation' : 'serverPort'] = value;
        continue;
      }
      if (shouldIgnoreElectronArgument(argument, positional.length === 0)) continue;
      if (argument.startsWith('-')) throw new CommandLineError('CLI_UNKNOWN_OPTION');
    }
    positional.push(argument);
  }
  return { values, flags, positional, newWindow: flags.has('newWindow') };
}

function shouldIgnoreElectronArgument(argument: string, beforePositional: boolean): boolean {
  if (
    ignoredElectronOptions.some(
      (option) => argument === option || argument.startsWith(`${option}=`),
    )
  )
    return true;
  return beforePositional && (isAbsolute(argument) || argument.endsWith('apps/desktop'));
}

function parseOptionsJson(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  if (Buffer.byteLength(value) > 8_192) throw new CommandLineError('CLI_OPTIONS_TOO_LARGE');
  try {
    const parsed: unknown = JSON.parse(stripOuterQuotes(value));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
    return { ...(parsed as Record<string, unknown>) };
  } catch {
    throw new CommandLineError('CLI_INVALID_OPTIONS_JSON');
  }
}

function stripOuterQuotes(value: string): string {
  return (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
    ? value.slice(1, -1)
    : value;
}

function normalizedProtocol(value: unknown): string {
  if (typeof value !== 'string') throw new CommandLineError('CLI_INVALID_PROTOCOL');
  const protocol = value.toLowerCase();
  if (!supportedProtocols.has(protocol)) throw new CommandLineError('CLI_INVALID_PROTOCOL');
  return protocol;
}

function stringOption(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new CommandLineError('CLI_INVALID_PORT');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new CommandLineError('CLI_INVALID_PORT');
  return port;
}

function normalizeTarget(
  target: string,
  protocol: string,
  options: Record<string, unknown>,
): string {
  if (target.includes('://')) throw new CommandLineError('CLI_INVALID_TARGET');
  if (protocol === 'http' || protocol === 'https') return target;
  const at = target.lastIndexOf('@');
  if (at >= 0) {
    if (options.username === undefined) options.username = target.slice(0, at);
    return target.slice(at + 1);
  }
  return target;
}

function parseEnvironment(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  const matches: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (const character of value) {
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (/\s/.test(character)) {
      if (current) matches.push(current);
      current = '';
    } else current += character;
  }
  if (quote) throw new CommandLineError('CLI_INVALID_ENVIRONMENT');
  if (current) matches.push(current);
  if (!matches.length || matches.length > 64) throw new CommandLineError('CLI_INVALID_ENVIRONMENT');
  for (const entry of matches) {
    const equals = entry.indexOf('=');
    if (equals <= 0) throw new CommandLineError('CLI_INVALID_ENVIRONMENT');
    const name = entry.slice(0, equals);
    const item = entry.slice(equals + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new CommandLineError('CLI_INVALID_ENVIRONMENT');
    if (item.includes('\0') || Buffer.byteLength(item) > 4_096)
      throw new CommandLineError('CLI_INVALID_ENVIRONMENT');
    result[name] = item;
  }
  return result;
}

function withOptions(source: string, options: Record<string, unknown>): string {
  if (!Object.keys(options).length) return source;
  return `${source}${source.includes('?') ? '&' : '?'}opts=${encodeURIComponent(JSON.stringify(options))}`;
}

function extractOptions(source: string): { source: string; options?: string } {
  const url = new URL(source);
  const options = url.searchParams.get('opts') ?? undefined;
  url.searchParams.delete('opts');
  const value = url.toString();
  return {
    source: value.endsWith('/') && !source.includes('/?') ? value.slice(0, -1) : value,
    ...(options === undefined ? {} : { options }),
  };
}

function resolveCommandLinePath(value: string, workingDirectory: string): string {
  if (value.includes('\0') || Buffer.byteLength(value) > 4_096)
    throw new CommandLineError('CLI_INVALID_PATH');
  return resolve(workingDirectory, value);
}

class CommandLineError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
