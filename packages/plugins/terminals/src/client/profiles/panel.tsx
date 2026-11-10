import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { Terminal as TerminalIcon } from 'lucide-react';
import type { TranslateNS } from '@axterm/ui';
import {
  DEFAULT_TERMINAL_TYPE,
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_BEHAVIOR,
  TERMINAL_ENCODINGS,
  terminalProfileInputSchema,
  type TerminalProfile,
  type TerminalProfileInput,
} from '@axterm/plugin-api/terminals';
import type { ConfigurationClientActions } from '@axterm/plugin-api/configuration';
import type { TerminalFactsModel } from '../facts.ts';
import type { TerminalProfileCommands } from './commands.ts';
import styles from './profiles.module.css';
type Translator = TranslateNS<'terminals'>;
const cx = (value: string) =>
  value
    .split(/\s+/u)
    .map((name) => name + ' ' + (styles[name] ?? ''))
    .join(' ');
export function TerminalProfilesPanel({
  model,
  configuration,
  commands,
  t: x,
}: {
  model: TerminalFactsModel;
  configuration: ConfigurationClientActions;
  commands: TerminalProfileCommands;
  t: Translator;
}) {
  const facts = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const settings = useSyncExternalStore(configuration.subscribe, configuration.getSnapshot);
  const command = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
  const [editingProfile, setEditingProfile] = useState<TerminalProfile>();
  const [message, setMessage] = useState('');
  const profiles = facts.status === 'ready' ? facts.baseline.profiles : [];
  const busy = command.busy || command.uncertain || facts.status !== 'ready';
  const defaultId =
    settings.status === 'ready' ? settings.baseline.settings.terminal.defaultProfileId : null;
  async function run(invoke: () => Promise<void>, form?: HTMLFormElement) {
    setMessage('');
    try {
      await invoke();
      const result = commands.getSnapshot();
      if (result.failed) setMessage(x('profileOperationFailed'));
      else if (!result.uncertain) {
        form?.reset();
        setEditingProfile(undefined);
        setMessage(x(editingProfile ? 'terminalProfile.updated' : 'terminalProfile.saved'));
      }
    } catch {
      setMessage(x('profileOperationFailed'));
    }
  }
  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    await run(
      () =>
        commands.save(
          terminalProfileInputSchema.parse(terminalProfileInput(new FormData(form), x)),
          editingProfile,
        ),
      form,
    );
  }
  return (
    <section className={cx('settings-item-terminal')} data-terminal-profiles>
      {message && <p role="status">{message}</p>}
      {command.uncertain && (
        <p role="alert">
          {x('profileOperationFailed')}{' '}
          <button
            type="button"
            onClick={() => {
              void run(() => commands.retry());
            }}
          >
            {x('retry')}
          </button>
        </p>
      )}
      <section
        className={cx('surface stack terminal-default-profile-settings')}
        aria-labelledby="terminal-default-profile-title"
      >
        <h2 id="terminal-default-profile-title">{x('shell.terminalProfile')}</h2>
        <label className={cx('field compact-field')}>
          <span>{x('terminalRecovery.defaultProfile')}</span>
          <select
            aria-label={x('terminalRecovery.defaultProfile')}
            value={defaultId ?? ''}
            disabled={busy || settings.status !== 'ready'}
            onChange={(event) => {
              const id = event.target.value || null;
              void run(() => commands.setDefault(id));
            }}
          >
            <option value="">{x('terminalRecovery.platformDefault')}</option>
            {defaultId && !profiles.some((profile) => profile.id === defaultId) && (
              <option value={defaultId} disabled>
                {x('terminalRecovery.deletedProfile')}
              </option>
            )}
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
          <small className={cx('hint')}>{x('terminalRecovery.profileHint')}</small>
        </label>
      </section>
      <div className={cx('two-column terminal-profile-settings')}>
        <form
          data-terminal-profile-form
          className={cx('stack surface')}
          key={editingProfile?.id ?? 'new-terminal-profile'}
          onSubmit={(event) => void saveProfile(event)}
        >
          <h3
            aria-label={
              editingProfile ? x('terminalProfile.editAria') : x('terminalProfile.createAria')
            }
          >
            <TerminalIcon size={15} aria-hidden="true" />{' '}
            {editingProfile ? x('terminalProfile.editTitle') : x('terminalProfile.createTitle')}
          </h3>
          <label className={cx('terminal-setting-profile')}>
            {x('terminalProfile.name')}
            <input disabled={busy} name="name" required defaultValue={editingProfile?.name} />
          </label>
          <label className={cx('terminal-setting-profile')}>
            Shell
            <input
              disabled={busy}
              name="shell"
              placeholder={x('terminalProfile.shellPlaceholder')}
              defaultValue={editingProfile?.shell ?? ''}
            />
          </label>
          <label className={cx('terminal-setting-profile')}>
            {x('terminalProfile.shellArguments')}
            <textarea
              disabled={busy}
              name="shellArgs"
              rows={3}
              defaultValue={editingProfile?.shellArgs.join('\n') ?? ''}
            />
          </label>
          <label className={cx('terminal-setting-profile')}>
            {x('terminalProfile.workingDirectory')}
            <input disabled={busy} name="cwd" defaultValue={editingProfile?.cwd ?? ''} />
          </label>
          <label className={cx('terminal-setting-term')}>
            TERM
            <input
              disabled={busy}
              name="term"
              required
              defaultValue={editingProfile?.term ?? DEFAULT_TERMINAL_TYPE}
            />
          </label>
          <label className={cx('terminal-setting-profile')}>
            LANG
            <input
              disabled={busy}
              name="lang"
              placeholder={x('terminalProfile.langPlaceholder')}
              defaultValue={editingProfile?.lang ?? ''}
            />
          </label>
          <label className={cx('terminal-setting-profile')}>
            {x('terminalProfile.environment')}
            <textarea
              disabled={busy}
              name="env"
              rows={4}
              placeholder={'EDITOR=vim\nCOLORTERM=truecolor'}
              defaultValue={formatTerminalEnvironment(editingProfile?.env ?? {})}
            />
            <small className={cx('hint')}>{x('terminalProfile.environmentHint')}</small>
          </label>
          <label className={cx('terminal-setting-font-family')}>
            {x('terminalProfile.fontFamily')}
            <input
              disabled={busy}
              name="fontFamily"
              required
              defaultValue={editingProfile?.fontFamily ?? DEFAULT_TERMINAL_APPEARANCE.fontFamily}
            />
          </label>
          <label className={cx('terminal-setting-font-size')}>
            {x('terminalProfile.fontSize')}
            <input
              disabled={busy}
              name="fontSize"
              type="number"
              min="8"
              max="72"
              step="1"
              defaultValue={editingProfile?.fontSize ?? DEFAULT_TERMINAL_APPEARANCE.fontSize}
            />
          </label>
          <label className={cx('terminal-setting-advanced')}>
            {x('terminalProfile.lineHeight')}
            <input
              disabled={busy}
              name="lineHeight"
              type="number"
              min="1"
              max="2"
              step="0.05"
              defaultValue={editingProfile?.lineHeight ?? DEFAULT_TERMINAL_APPEARANCE.lineHeight}
            />
          </label>
          <label className={cx('terminal-setting-advanced')}>
            {x('terminalProfile.cursorStyle')}
            <select
              disabled={busy}
              name="cursorStyle"
              defaultValue={editingProfile?.cursorStyle ?? DEFAULT_TERMINAL_APPEARANCE.cursorStyle}
            >
              <option value="block">{x('terminalProfile.cursorBlock')}</option>
              <option value="underline">{x('terminalProfile.cursorUnderline')}</option>
              <option value="bar">{x('terminalProfile.cursorBar')}</option>
            </select>
          </label>
          <label className={cx('check terminal-setting-profile')}>
            <input
              disabled={busy}
              name="loginShell"
              type="checkbox"
              defaultChecked={editingProfile?.loginShell}
            />
            {x('terminalProfile.loginShell')}
          </label>
          <label className={cx('check terminal-setting-advanced')}>
            <input
              disabled={busy}
              name="cursorBlink"
              type="checkbox"
              defaultChecked={editingProfile?.cursorBlink}
            />
            {x('terminalProfile.cursorBlink')}
          </label>
          <fieldset className={cx('terminal-security-settings')}>
            <legend>{x('terminalProfile.renderingCompatibility')}</legend>
            <label className={cx('terminal-setting-scrollback')}>
              {x('terminalProfile.scrollback')}
              <input
                disabled={busy}
                name="scrollback"
                type="number"
                min="0"
                max="100000"
                step="100"
                defaultValue={editingProfile?.scrollback ?? DEFAULT_TERMINAL_BEHAVIOR.scrollback}
              />
            </label>
            <label className={cx('terminal-setting-renderer')}>
              {x('terminalProfile.renderer')}
              <select
                disabled={busy}
                name="rendererPreference"
                defaultValue={
                  editingProfile?.rendererPreference ?? DEFAULT_TERMINAL_BEHAVIOR.rendererPreference
                }
              >
                <option value="dom">{x('terminalProfile.domCompatible')}</option>
                <option value="webgl">{x('terminalProfile.webglAccelerated')}</option>
              </select>
            </label>
            <label className={cx('terminal-setting-advanced')}>
              {x('terminalProfile.unicodeWidth')}
              <select
                disabled={busy}
                name="unicodeVersion"
                defaultValue={
                  editingProfile?.unicodeVersion ?? DEFAULT_TERMINAL_BEHAVIOR.unicodeVersion
                }
              >
                <option value="11">Unicode 11</option>
                <option value="6">Unicode 6</option>
              </select>
            </label>
            <label className={cx('terminal-setting-advanced')}>
              {x('terminalProfile.wordSeparator')}
              <input
                disabled={busy}
                name="wordSeparator"
                maxLength={256}
                defaultValue={
                  editingProfile?.wordSeparator ?? DEFAULT_TERMINAL_BEHAVIOR.wordSeparator
                }
              />
            </label>
            <label className={cx('terminal-setting-advanced')}>
              {x('terminalProfile.backspaceSequence')}
              <select
                disabled={busy}
                name="backspaceMode"
                defaultValue={
                  editingProfile?.backspaceMode ?? DEFAULT_TERMINAL_BEHAVIOR.backspaceMode
                }
              >
                <option value="^?">^?</option>
                <option value="^H">^H</option>
              </select>
            </label>
            <label className={cx('full-field terminal-setting-advanced')}>
              {x('terminalProfile.shiftEnterSends')}
              <input
                disabled={busy}
                name="shiftEnterMode"
                maxLength={256}
                defaultValue={
                  editingProfile?.shiftEnterMode ?? DEFAULT_TERMINAL_BEHAVIOR.shiftEnterMode
                }
              />
            </label>
            <label className={cx('terminal-setting-advanced')}>
              {x('terminalProfile.outputEncoding')}
              <select
                disabled={busy}
                name="encoding"
                defaultValue={editingProfile?.encoding ?? DEFAULT_TERMINAL_BEHAVIOR.encoding}
              >
                {TERMINAL_ENCODINGS.map((encoding) => (
                  <option key={encoding} value={encoding}>
                    {encoding.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <label className={cx('check terminal-setting-advanced')}>
              <input
                disabled={busy}
                name="displayRaw"
                type="checkbox"
                defaultChecked={editingProfile?.displayRaw ?? DEFAULT_TERMINAL_BEHAVIOR.displayRaw}
              />
              {x('terminalProfile.displayRaw')}
            </label>
            <label className={cx('check terminal-setting-advanced')}>
              <input
                disabled={busy}
                name="logTimestamps"
                type="checkbox"
                defaultChecked={
                  editingProfile?.logTimestamps ?? DEFAULT_TERMINAL_BEHAVIOR.logTimestamps
                }
              />
              {x('terminalProfile.logTimestamps')}
            </label>
            <small className={cx('hint terminal-setting-advanced')}>
              {x('terminalProfile.keySequenceHint')}
            </small>
            <label className={cx('check terminal-setting-advanced')}>
              <input
                disabled={busy}
                name="ligaturesEnabled"
                type="checkbox"
                defaultChecked={
                  editingProfile?.ligaturesEnabled ?? DEFAULT_TERMINAL_BEHAVIOR.ligaturesEnabled
                }
              />
              {x('terminalProfile.ligatures')}
            </label>
            <label className={cx('check terminal-setting-advanced')}>
              <input
                disabled={busy}
                name="imageSequencesEnabled"
                type="checkbox"
                defaultChecked={
                  editingProfile?.imageSequencesEnabled ??
                  DEFAULT_TERMINAL_BEHAVIOR.imageSequencesEnabled
                }
              />
              {x('terminalProfile.imageSequences')}
            </label>
            <small className={cx('hint terminal-setting-advanced')}>
              {x('terminalProfile.imageSequencesHint')}
            </small>
          </fieldset>
          <fieldset className={cx('terminal-security-settings')}>
            <legend>{x('terminalProfile.clipboardSecurity')}</legend>
            <label className={cx('check')}>
              <input
                disabled={busy}
                name="pasteProtection"
                type="checkbox"
                defaultChecked={
                  editingProfile?.pasteProtection ?? DEFAULT_TERMINAL_BEHAVIOR.pasteProtection
                }
              />
              {x('terminalProfile.pasteProtection')}
            </label>
            <label className={cx('check')}>
              <input
                disabled={busy}
                name="osc52Enabled"
                type="checkbox"
                defaultChecked={
                  editingProfile?.osc52Enabled ?? DEFAULT_TERMINAL_BEHAVIOR.osc52Enabled
                }
              />
              {x('terminalProfile.osc52Enabled')}
            </label>
            <label>
              {x('terminalProfile.osc52Read')}
              <select
                disabled={busy}
                name="osc52ReadPolicy"
                defaultValue={
                  editingProfile?.osc52ReadPolicy ?? DEFAULT_TERMINAL_BEHAVIOR.osc52ReadPolicy
                }
              >
                <option value="deny">{x('terminalProfile.deny')}</option>
                <option value="allow">{x('terminalProfile.allow')}</option>
              </select>
            </label>
            <label>
              {x('terminalProfile.osc52Write')}
              <select
                disabled={busy}
                name="osc52WritePolicy"
                defaultValue={
                  editingProfile?.osc52WritePolicy ?? DEFAULT_TERMINAL_BEHAVIOR.osc52WritePolicy
                }
              >
                <option value="deny">{x('terminalProfile.deny')}</option>
                <option value="allow">{x('terminalProfile.allow')}</option>
              </select>
            </label>
            <small className={cx('hint')}>{x('terminalProfile.osc52Hint')}</small>
          </fieldset>
          <div className={cx('modal-actions')}>
            {editingProfile && (
              <button disabled={busy} type="button" onClick={() => setEditingProfile(undefined)}>
                {x('terminalProfile.cancelEdit')}
              </button>
            )}
            <button disabled={busy} className={cx('primary')}>
              {editingProfile ? x('terminalProfile.update') : x('terminalProfile.save')}
            </button>
          </div>
        </form>
        <div className={cx('surface list')}>
          <h3>{x('terminalProfile.savedProfiles')}</h3>
          {profiles.map((profile) => (
            <div className={cx('list-row')} key={profile.id}>
              <TerminalIcon size={14} />
              <div>
                <strong>{profile.name}</strong>
                <small>
                  {x('terminalProfile.summary', {
                    shell: profile.shell ?? x('terminalProfile.systemDefault'),
                    term: profile.term,
                    fontSize: profile.fontSize,
                    lineHeight: profile.lineHeight,
                    encoding: profile.encoding.toUpperCase(),
                    raw: x(profile.displayRaw ? 'terminalProfile.on' : 'terminalProfile.off'),
                    paste: x(
                      profile.pasteProtection ? 'terminalProfile.on' : 'terminalProfile.off',
                    ),
                    osc52: x(profile.osc52Enabled ? 'terminalProfile.on' : 'terminalProfile.off'),
                  })}
                </small>
              </div>
              <button disabled={busy} type="button" onClick={() => setEditingProfile(profile)}>
                {x('terminalProfile.edit')}
              </button>
              <button
                disabled={busy}
                type="button"
                onClick={() => {
                  if (window.confirm(x('profileDeleteConfirm', { name: profile.name })))
                    void run(() => commands.remove(profile));
                }}
              >
                {x('profileDelete')}
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
export function terminalProfileInput(form: FormData, x: Translator): TerminalProfileInput {
  return {
    name: String(form.get('name') ?? '').trim(),
    shell: String(form.get('shell') ?? '').trim() || null,
    shellArgs: String(form.get('shellArgs') ?? '')
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean),
    cwd: String(form.get('cwd') ?? '').trim() || null,
    loginShell: form.get('loginShell') === 'on',
    env: parseTerminalEnvironment(String(form.get('env') ?? ''), x),
    term: String(form.get('term') ?? '').trim(),
    lang: String(form.get('lang') ?? '').trim() || null,
    fontFamily: String(form.get('fontFamily') ?? '').trim(),
    fontSize: Number(form.get('fontSize')),
    lineHeight: Number(form.get('lineHeight')),
    cursorStyle: String(form.get('cursorStyle')) as TerminalProfileInput['cursorStyle'],
    cursorBlink: form.get('cursorBlink') === 'on',
    scrollback: Number(form.get('scrollback')),
    rendererPreference: String(
      form.get('rendererPreference'),
    ) as TerminalProfileInput['rendererPreference'],
    unicodeVersion: String(form.get('unicodeVersion')) as TerminalProfileInput['unicodeVersion'],
    ligaturesEnabled: form.get('ligaturesEnabled') === 'on',
    imageSequencesEnabled: form.get('imageSequencesEnabled') === 'on',
    wordSeparator: String(form.get('wordSeparator') ?? ''),
    backspaceMode: String(form.get('backspaceMode')) as TerminalProfileInput['backspaceMode'],
    shiftEnterMode: String(form.get('shiftEnterMode') ?? ''),
    encoding: String(form.get('encoding')) as TerminalProfileInput['encoding'],
    displayRaw: form.get('displayRaw') === 'on',
    logTimestamps: form.get('logTimestamps') === 'on',
    pasteProtection: form.get('pasteProtection') === 'on',
    osc52Enabled: form.get('osc52Enabled') === 'on',
    osc52ReadPolicy: String(form.get('osc52ReadPolicy')) as TerminalProfileInput['osc52ReadPolicy'],
    osc52WritePolicy: String(
      form.get('osc52WritePolicy'),
    ) as TerminalProfileInput['osc52WritePolicy'],
  };
}
function parseTerminalEnvironment(source: string, x: Translator): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    if (!rawLine.trim()) continue;
    const separator = rawLine.indexOf('=');
    if (separator < 1) throw new Error(x('hosts.environmentLineInvalid', { line: index + 1 }));
    const name = rawLine.slice(0, separator).trim();
    if (Object.hasOwn(result, name)) throw new Error(x('hosts.environmentDuplicate', { name }));
    result[name] = rawLine.slice(separator + 1);
  }
  return result;
}
function formatTerminalEnvironment(environment: Record<string, string>): string {
  return Object.entries(environment)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');
}
