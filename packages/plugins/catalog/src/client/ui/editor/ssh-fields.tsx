import { useState, useRef, useEffect } from 'react';
import { Plus, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { DEFAULT_SSH_STARTUP, type Host } from '@axterm/plugin-api/catalog';
import { useI18n } from '../i18n.tsx';
type Translator = ReturnType<typeof useI18n>['x'];
export class HostFormInputError extends Error {}
import styles from './editor.module.css';
const classes = (value: string) =>
  value
    .split(/\s+/u)
    .filter(Boolean)
    .map((name) => name + ' ' + (styles[name] ?? ''))
    .join(' ');
export const SSH_KEX_OPTIONS = [
  'curve25519-sha256',
  'curve25519-sha256@libssh.org',
  'diffie-hellman-group14-sha256',
  'diffie-hellman-group16-sha512',
  'ecdh-sha2-nistp256',
] as const;
export const SSH_CIPHER_OPTIONS = [
  'chacha20-poly1305@openssh.com',
  'aes128-gcm@openssh.com',
  'aes256-gcm@openssh.com',
  'aes128-ctr',
  'aes192-ctr',
  'aes256-ctr',
] as const;
export const SSH_HOST_KEY_OPTIONS = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
] as const;
export const SSH_HMAC_OPTIONS = [
  'hmac-sha2-256-etm@openssh.com',
  'hmac-sha2-512-etm@openssh.com',
  'hmac-sha2-256',
  'hmac-sha2-512',
] as const;
export function SshAlgorithmField({
  label,
  name,
  options,
  selected,
}: {
  label: string;
  name: string;
  options: readonly string[];
  selected: string[];
}) {
  return (
    <label>
      {label}
      <select aria-label={label} defaultValue={selected} multiple name={name} size={4}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}
type StartupScriptRow = Host['startup']['runScripts'][number] & {
  id: number;
};
export function SshStartupFields({ host }: { host: Host | undefined }) {
  const { x } = useI18n();
  const startup = host?.startup ?? DEFAULT_SSH_STARTUP;
  const initialRows = (rows: Host['startup']['loginScripts']): StartupScriptRow[] =>
    rows.map((row, id) => ({ ...row, id }));
  const [loginScripts, setLoginScripts] = useState(() => initialRows(startup.loginScripts));
  const [runScripts, setRunScripts] = useState(() => initialRows(startup.runScripts));
  const renderScripts = (
    kind: 'sshLoginScript' | 'sshRunScript',
    rows: StartupScriptRow[],
    update: (rows: StartupScriptRow[]) => void,
  ) => (
    <div className={classes('ssh-startup-script-group')}>
      <div className={classes('ssh-startup-script-heading')}>
        <strong>
          {kind === 'sshLoginScript' ? x('sshStartup.loginScripts') : x('sshStartup.runScripts')}
        </strong>
        <button
          type="button"
          disabled={rows.length >= 16}
          onClick={() =>
            update([
              ...rows,
              {
                id: rows.reduce((maximum, row) => Math.max(maximum, row.id), -1) + 1,
                command: '',
                delayMs: 500,
                sendEnter: true,
                waitForOutput: true,
                settleIdleMs: 400,
                settleTimeoutMs: 3000,
              },
            ])
          }
        >
          <Plus size={13} aria-hidden="true" /> {x('sshStartup.addScript')}
        </button>
      </div>
      {rows.map((row, index) => (
        <div className={classes('ssh-startup-script-row')} key={row.id}>
          <label>
            {x('sshStartup.delay')}
            <input
              aria-label={x(
                kind === 'sshLoginScript'
                  ? 'sshStartup.loginScriptDelayAria'
                  : 'sshStartup.runScriptDelayAria',
                { number: index + 1 },
              )}
              defaultValue={row.delayMs}
              max="60000"
              min="0"
              name={`${kind}Delay`}
              required
              type="number"
            />
          </label>
          <label>
            {x('sshStartup.command')}
            <textarea
              aria-label={x(
                kind === 'sshLoginScript'
                  ? 'sshStartup.loginScriptCommandAria'
                  : 'sshStartup.runScriptCommandAria',
                { number: index + 1 },
              )}
              defaultValue={row.command}
              maxLength={4096}
              name={`${kind}Command`}
              required
              rows={2}
            />
          </label>
          <div className={classes('ssh-startup-script-options')}>
            <label>
              {x('sshStartup.sendMode')}
              <select defaultValue={row.sendEnter ? 'enter' : 'raw'} name={`${kind}SendMode`}>
                <option value="enter">{x('sshStartup.sendWithEnter')}</option>
                <option value="raw">{x('sshStartup.sendTextOnly')}</option>
              </select>
            </label>
            <label>
              {x('sshStartup.nextWait')}
              <select defaultValue={row.waitForOutput ? 'idle' : 'delay'} name={`${kind}WaitMode`}>
                <option value="idle">{x('sshStartup.waitForIdle')}</option>
                <option value="delay">{x('sshStartup.fixedDelayOnly')}</option>
              </select>
            </label>
            <label>
              {x('sshStartup.idleTime')}
              <input
                defaultValue={row.settleIdleMs}
                max="2000"
                min="50"
                name={`${kind}SettleIdle`}
                required
                type="number"
              />
            </label>
            <label>
              {x('sshStartup.maxWait')}
              <input
                defaultValue={row.settleTimeoutMs}
                max="10000"
                min="250"
                name={`${kind}SettleTimeout`}
                required
                type="number"
              />
            </label>
          </div>
          <button
            aria-label={x(
              kind === 'sshLoginScript'
                ? 'sshStartup.deleteLoginScriptAria'
                : 'sshStartup.deleteRunScriptAria',
              { number: index + 1 },
            )}
            type="button"
            onClick={() => update(rows.filter(({ id }) => id !== row.id))}
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
      {!rows.length && <p className={classes('hint')}>{x('sshStartup.empty')}</p>}
    </div>
  );
  return (
    <details
      className={classes('ssh-startup-settings full-field host-form-field')}
      data-tab="settings"
    >
      <summary>{x('sshStartup.title')}</summary>
      <p className={classes('hint')}>{x('sshStartup.hint')}</p>
      <label>
        {x('sshStartup.directory')}
        <input
          defaultValue={startup.directory ?? ''}
          maxLength={4096}
          name="sshStartupDirectory"
          placeholder="/home/operator/project"
        />
      </label>
      <label>
        {x('sshStartup.environment')}
        <textarea
          defaultValue={Object.entries(startup.environment)
            .map(([name, value]) => `${name}=${value}`)
            .join('\n')}
          name="sshStartupEnvironment"
          placeholder={'LANG=zh_CN.UTF-8\nAPP_ENV=staging'}
          rows={3}
        />
        <small>{x('sshStartup.environmentHint')}</small>
      </label>
      {renderScripts('sshLoginScript', loginScripts, setLoginScripts)}
      {renderScripts('sshRunScript', runScripts, setRunScripts)}
    </details>
  );
}
export function parseSshStartupEnvironment(input: string, x: Translator): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [index, source] of input.split(/\r?\n/gu).entries()) {
    if (!source.trim()) continue;
    const separator = source.indexOf('=');
    if (separator <= 0)
      throw new HostFormInputError(x('hosts.environmentLineInvalid', { line: index + 1 }));
    const name = source.slice(0, separator).trim();
    if (name in environment)
      throw new HostFormInputError(x('hosts.environmentDuplicate', { name }));
    environment[name] = source.slice(separator + 1);
  }
  return environment;
}
export function readSshStartupScripts(
  form: FormData,
  kind: 'sshLoginScript' | 'sshRunScript',
): Host['startup']['runScripts'] {
  const commands = form.getAll(`${kind}Command`).map((value) => String(value).trim());
  const delays = form.getAll(`${kind}Delay`).map(Number);
  const sendModes = form.getAll(`${kind}SendMode`).map(String);
  const waitModes = form.getAll(`${kind}WaitMode`).map(String);
  const settleIdle = form.getAll(`${kind}SettleIdle`).map(Number);
  const settleTimeout = form.getAll(`${kind}SettleTimeout`).map(Number);
  return commands.map((command, index) => ({
    command,
    delayMs: delays[index] ?? 0,
    sendEnter: sendModes[index] !== 'raw',
    waitForOutput: waitModes[index] !== 'delay',
    settleIdleMs: settleIdle[index] ?? 400,
    settleTimeoutMs: settleTimeout[index] ?? 3000,
  }));
}
export function HostJumpChainFields({ host, hosts }: { host: Host | undefined; hosts: Host[] }) {
  const { x } = useI18n();
  const initial = host?.jumpHostIds.length
    ? host.jumpHostIds
    : legacyJumpPath(host?.jumpHostId ?? null, hosts);
  const [ids, setIds] = useState(initial);
  const [candidate, setCandidate] = useState('');
  const [targetName, setTargetName] = useState(host?.name || x('jumpChain.targetHost'));
  const root = useRef<HTMLFieldSetElement>(null);
  const available = hosts.filter((item) => item.id !== host?.id && !ids.includes(item.id));
  useEffect(() => {
    const input = root.current?.closest('form')?.elements.namedItem('name');
    if (!(input instanceof HTMLInputElement)) return;
    const update = () => setTargetName(input.value.trim() || x('jumpChain.targetHost'));
    update();
    input.addEventListener('input', update);
    return () => input.removeEventListener('input', update);
  }, [x]);
  function move(index: number, offset: -1 | 1) {
    const destination = index + offset;
    if (destination < 0 || destination >= ids.length) return;
    setIds((current) => {
      const next = [...current];
      [next[index], next[destination]] = [next[destination]!, next[index]!];
      return next;
    });
  }
  return (
    <fieldset
      ref={root}
      className={classes('host-jump-chain host-form-field full-field')}
      data-tab="hops"
    >
      <legend>{x('jumpChain.title')}</legend>
      <p id="ssh-bookmark-hops" className={classes('hint')}>
        {x('jumpChain.hint')}
      </p>
      <div className={classes('host-jump-chain-add')}>
        <label>
          {x('jumpChain.addSavedHost')}
          <select
            aria-label={x('jumpChain.addAria')}
            value={candidate}
            onChange={(event) => setCandidate(event.target.value)}
          >
            <option value="">{x('jumpChain.selectHost')}</option>
            {available.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} — {item.username}@{item.hostname}:{item.port}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!candidate || ids.length >= 8}
          onClick={() => {
            if (!candidate || ids.includes(candidate) || ids.length >= 8) return;
            setIds((current) => [...current, candidate]);
            setCandidate('');
          }}
        >
          <Plus size={13} aria-hidden="true" /> {x('jumpChain.add')}
        </button>
      </div>
      <ol className={classes('host-jump-chain-list')} aria-label={x('jumpChain.order')}>
        {ids.map((id, index) => {
          const item = hosts.find((candidateHost) => candidateHost.id === id);
          if (!item) return null;
          return (
            <li key={id}>
              <input name="jumpHostIds" type="hidden" value={id} />
              <span className={classes('host-jump-chain-index')}>{index + 1}</span>
              <span>
                <strong>{item.name}</strong>
                <small>
                  {item.username}@{item.hostname}:{item.port}
                </small>
              </span>
              <button
                aria-label={x('jumpChain.moveUp', { name: item.name })}
                type="button"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ChevronUp size={14} aria-hidden="true" />
              </button>
              <button
                aria-label={x('jumpChain.moveDown', { name: item.name })}
                type="button"
                disabled={index === ids.length - 1}
                onClick={() => move(index, 1)}
              >
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              <button
                aria-label={x('jumpChain.remove', { name: item.name })}
                type="button"
                onClick={() => setIds((current) => current.filter((value) => value !== id))}
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ol>
      {!ids.length && (
        <p className={classes('hint host-jump-chain-empty')}>{x('jumpChain.direct')}</p>
      )}
      <p className={classes('host-jump-chain-path')} aria-label={x('jumpChain.path')}>
        <span>{x('jumpChain.localMachine')}</span>
        {ids.map((id) => (
          <span key={id}>
            {hosts.find((item) => item.id === id)?.name ?? x('jumpChain.unknownHost')}
          </span>
        ))}
        <span>{targetName}</span>
      </p>
    </fieldset>
  );
}
function legacyJumpPath(jumpHostId: string | null, hosts: Host[]): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let cursor = jumpHostId;
  while (cursor && !seen.has(cursor) && path.length < 8) {
    seen.add(cursor);
    path.unshift(cursor);
    cursor = hosts.find(({ id }) => id === cursor)?.jumpHostId ?? null;
  }
  return path;
}
