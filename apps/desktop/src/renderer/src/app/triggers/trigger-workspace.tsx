import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type { TriggerCollection, TriggerRule, TriggerRuleInput } from '@workspace/contracts';
import { Bell, Braces, Copy, Pencil, Plus, Save, Trash2, Zap } from 'lucide-react';
import { useI18n } from '../../i18n/context';
import type { AxtermMessageKey } from '../../i18n/core';
import './trigger-workspace.css';

type Client = ReturnType<typeof createRuntimeClient>;

const presets: Array<{
  labelKey: AxtermMessageKey;
  nameKey: AxtermMessageKey;
  input: TriggerRuleInput;
}> = [
  {
    labelKey: 'triggers.presetCisco',
    nameKey: 'triggers.presetCiscoName',
    input: ruleInput(
      'Cisco pager: --More--',
      'text',
      '--More--',
      'send',
      ' ',
      false,
      'cooldown',
      500,
    ),
  },
  {
    labelKey: 'triggers.presetAnyKey',
    nameKey: 'triggers.presetAnyKeyName',
    input: ruleInput(
      'Pager: Press any key to continue',
      'regex',
      `press any key|press .* to continue|${String.fromCodePoint(25353, 20219, 24847, 38190)}`,
      'send',
      ' ',
      false,
      'cooldown',
      800,
    ),
  },
  {
    labelKey: 'triggers.presetConfirm',
    nameKey: 'triggers.presetConfirmName',
    input: ruleInput(
      'Confirm: Are you sure? [y/n]',
      'regex',
      'are you sure.*\\[y/n\\]|confirm.*\\(y/n\\)',
      'send',
      'y',
      true,
      'cooldown',
      1_000,
    ),
  },
  {
    labelKey: 'triggers.presetSudo',
    nameKey: 'triggers.presetSudoName',
    input: ruleInput(
      'sudo password prompt → notify',
      'regex',
      '\\[sudo\\]\\s*password',
      'notify',
      '',
      false,
      'cooldown',
      5_000,
    ),
  },
  {
    labelKey: 'triggers.presetClosed',
    nameKey: 'triggers.presetClosedName',
    input: ruleInput(
      'Connection closed → notify',
      'regex',
      'connection (closed|reset|refused)|lost connection',
      'notify',
      '',
      false,
      'cooldown',
      5_000,
    ),
  },
];

export function TriggerWorkspace({ client }: { client: Client }) {
  const { x } = useI18n();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['triggers'], queryFn: client.triggers });
  const [editing, setEditing] = useState<TriggerRule | 'new'>();
  const [draft, setDraft] = useState<TriggerRuleInput>(() => emptyRule(x));
  const [preset, setPreset] = useState('');
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [error, setError] = useState('');
  const collection = query.data;

  function setCollection(next: TriggerCollection) {
    queryClient.setQueryData(['triggers'], next);
  }

  function openNew(input = emptyRule(x)) {
    setEditing('new');
    setDraft(input);
    setError('');
  }

  function openEdit(trigger: TriggerRule) {
    setEditing(trigger);
    setDraft(toInput(trigger));
    setError('');
  }

  async function mutate(operation: (current: TriggerCollection) => Promise<TriggerCollection>) {
    if (!collection) return;
    setError('');
    try {
      const next = await operation(collection);
      setCollection(next);
      return next;
    } catch (cause) {
      setError(messageOf(cause, x));
      await query.refetch();
      return undefined;
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next =
      editing === 'new'
        ? await mutate((current) => client.createTrigger(current, draft))
        : editing
          ? await mutate((current) => client.updateTrigger(current, editing.id, draft))
          : undefined;
    if (next) setEditing(undefined);
  }

  async function toggle(trigger: TriggerRule, enabled: boolean) {
    await mutate((current) => client.updateTrigger(current, trigger.id, { enabled }));
  }

  async function remove(trigger: TriggerRule) {
    const next = await mutate((current) => client.deleteTrigger(current, trigger.id));
    if (next && editing !== 'new' && editing?.id === trigger.id) setEditing(undefined);
  }

  async function duplicate(trigger: TriggerRule) {
    await mutate((current) =>
      client.createTrigger(current, {
        ...toInput(trigger),
        name: x('triggers.copyName', { name: trigger.name }),
      }),
    );
  }

  function openJson() {
    setJsonText(JSON.stringify(collection?.triggers.map(toInput) ?? [], null, 2));
    setJsonOpen(true);
    setError('');
  }

  async function applyJson() {
    if (!collection) return;
    try {
      const parsed = JSON.parse(jsonText) as TriggerRuleInput[];
      const next = await client.replaceTriggers(collection, parsed);
      setCollection(next);
      setJsonOpen(false);
    } catch (cause) {
      setError(messageOf(cause, x));
      await query.refetch();
    }
  }

  return (
    <div className="trigger-workspace" data-testid="trigger-workspace">
      <section className="trigger-library surface">
        <header>
          <div>
            <small>{x('triggers.eyebrow')}</small>
            <h3>{x('triggers.title')}</h3>
          </div>
          <span>{collection?.triggers.length ?? 0}/256</span>
        </header>
        <div className="trigger-toolbar">
          <button className="primary" type="button" onClick={() => openNew()}>
            <Plus size={13} /> {x('triggers.new')}
          </button>
          <select
            aria-label={x('triggers.presets')}
            value={preset}
            onChange={(event) => {
              const selected = presets[Number(event.target.value)];
              setPreset('');
              if (selected)
                openNew({ ...structuredClone(selected.input), name: x(selected.nameKey) });
            }}
          >
            <option value="">{x('triggers.selectPreset')}</option>
            {presets.map((item, index) => (
              <option key={item.labelKey} value={index}>
                {x(item.labelKey)}
              </option>
            ))}
          </select>
          <button type="button" onClick={openJson}>
            <Braces size={13} /> JSON
          </button>
        </div>
        <div className="trigger-list">
          {collection?.triggers.map((trigger) => (
            <article
              key={trigger.id}
              aria-selected={editing !== 'new' && editing?.id === trigger.id}
            >
              <label className="trigger-enabled">
                <input
                  type="checkbox"
                  aria-label={x('triggers.enableNamed', { name: trigger.name })}
                  checked={trigger.enabled}
                  onChange={(event) => void toggle(trigger, event.target.checked)}
                />
              </label>
              <button className="trigger-main" type="button" onClick={() => openEdit(trigger)}>
                <strong>{trigger.name}</strong>
                <small>{matchSummary(trigger, x)}</small>
                <small>{actionSummary(trigger, x)}</small>
              </button>
              <span className="trigger-mode">{trigger.mode}</span>
              <button
                type="button"
                aria-label={x('triggers.editNamed', { name: trigger.name })}
                onClick={() => openEdit(trigger)}
              >
                <Pencil size={13} />
              </button>
              <button
                type="button"
                aria-label={x('triggers.duplicateNamed', { name: trigger.name })}
                onClick={() => void duplicate(trigger)}
              >
                <Copy size={13} />
              </button>
              <button
                type="button"
                aria-label={x('triggers.deleteNamed', { name: trigger.name })}
                onClick={() => void remove(trigger)}
              >
                <Trash2 size={13} />
              </button>
            </article>
          ))}
          {!query.isLoading && !collection?.triggers.length && (
            <div className="trigger-empty">
              <Zap size={28} />
              <p>{x('triggers.emptyDescription')}</p>
            </div>
          )}
        </div>
      </section>

      <section className="trigger-editor surface">
        {error && <div className="trigger-error">{error}</div>}
        {jsonOpen ? (
          <div className="trigger-json-editor">
            <header>
              <div>
                <small>{x('triggers.portableRules')}</small>
                <h3>{x('triggers.jsonEdit')}</h3>
              </div>
            </header>
            <textarea
              aria-label={x('triggers.jsonAria')}
              rows={22}
              spellCheck={false}
              value={jsonText}
              onChange={(event) => setJsonText(event.target.value)}
            />
            <p>{x('triggers.jsonDescription')}</p>
            <footer>
              <button type="button" onClick={() => setJsonOpen(false)}>
                {x('common.cancel')}
              </button>
              <button className="primary" type="button" onClick={() => void applyJson()}>
                <Save size={13} /> {x('triggers.applyJson')}
              </button>
            </footer>
          </div>
        ) : editing ? (
          <form className="trigger-form" onSubmit={(event) => void save(event)}>
            <header>
              <div>
                <small>
                  {x(editing === 'new' ? 'triggers.newEyebrow' : 'triggers.editEyebrow')}
                </small>
                <h3>{editing === 'new' ? x('triggers.newTitle') : editing.name}</h3>
              </div>
            </header>
            <label>
              {x('triggers.name')}
              <input
                aria-label={x('triggers.nameAria')}
                required
                maxLength={100}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
              />
              {x('triggers.enabled')}
            </label>
            <fieldset>
              <legend>{x('triggers.match')}</legend>
              <div className="trigger-inline">
                <select
                  aria-label={x('triggers.matchType')}
                  value={draft.match.type}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      match: { ...draft.match, type: event.target.value as 'text' | 'regex' },
                    })
                  }
                >
                  <option value="text">{x('triggers.text')}</option>
                  <option value="regex">{x('triggers.regex')}</option>
                </select>
                <input
                  aria-label={x('triggers.matchValue')}
                  required
                  maxLength={512}
                  value={draft.match.value}
                  onChange={(event) =>
                    setDraft({ ...draft, match: { ...draft.match, value: event.target.value } })
                  }
                />
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.match.caseSensitive}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      match: { ...draft.match, caseSensitive: event.target.checked },
                    })
                  }
                />
                {x('triggers.caseSensitive')}
              </label>
            </fieldset>
            <fieldset>
              <legend>{x('triggers.action')}</legend>
              <div className="trigger-inline">
                <select
                  aria-label={x('triggers.actionAria')}
                  value={draft.action.type}
                  onChange={(event) => {
                    const type = event.target.value as 'send' | 'notify';
                    setDraft({ ...draft, action: { type, value: '' } });
                  }}
                >
                  <option value="send">{x('triggers.sendText')}</option>
                  <option value="notify">{x('triggers.notifyOnly')}</option>
                </select>
                <input
                  aria-label={x('triggers.sendValue')}
                  disabled={draft.action.type === 'notify'}
                  maxLength={16_384}
                  placeholder={x('triggers.sendPlaceholder')}
                  value={draft.action.value}
                  onChange={(event) =>
                    setDraft({ ...draft, action: { type: 'send', value: event.target.value } })
                  }
                />
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  disabled={draft.action.type === 'notify'}
                  checked={draft.sendEnter}
                  onChange={(event) => setDraft({ ...draft, sendEnter: event.target.checked })}
                />
                {x('triggers.sendEnter')}
              </label>
            </fieldset>
            <fieldset>
              <legend>{x('triggers.frequency')}</legend>
              <div className="trigger-inline">
                <select
                  aria-label={x('triggers.mode')}
                  value={draft.mode}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      mode: event.target.value as TriggerRuleInput['mode'],
                    })
                  }
                >
                  <option value="cooldown">{x('triggers.cooldownMode')}</option>
                  <option value="repeat">{x('triggers.repeatMode')}</option>
                  <option value="once">{x('triggers.onceMode')}</option>
                </select>
                <label>
                  {x('triggers.cooldownMs')}
                  <input
                    aria-label={x('triggers.cooldownTime')}
                    type="number"
                    min={0}
                    max={600_000}
                    disabled={draft.mode !== 'cooldown'}
                    value={draft.cooldownMs}
                    onChange={(event) =>
                      setDraft({ ...draft, cooldownMs: Number(event.target.value) })
                    }
                  />
                </label>
              </div>
            </fieldset>
            <footer>
              <button type="button" onClick={() => setEditing(undefined)}>
                {x('common.cancel')}
              </button>
              <button className="primary">
                <Save size={13} /> {x('triggers.save')}
              </button>
            </footer>
          </form>
        ) : (
          <div className="trigger-editor-empty">
            <Bell size={30} />
            <p>{x('triggers.editorEmpty')}</p>
            <button className="primary" type="button" onClick={() => openNew()}>
              <Plus size={13} /> {x('triggers.newTitle')}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function emptyRule(x: ReturnType<typeof useI18n>['x']): TriggerRuleInput {
  return ruleInput(x('triggers.defaultName'), 'text', '', 'send', '', true, 'cooldown', 500);
}

function ruleInput(
  name: string,
  matchType: 'text' | 'regex',
  matchValue: string,
  actionType: 'send' | 'notify',
  actionValue: string,
  sendEnter: boolean,
  mode: TriggerRuleInput['mode'],
  cooldownMs: number,
): TriggerRuleInput {
  return {
    name,
    enabled: true,
    match: { type: matchType, value: matchValue, caseSensitive: false },
    action:
      actionType === 'send' ? { type: 'send', value: actionValue } : { type: 'notify', value: '' },
    sendEnter,
    mode,
    cooldownMs,
  };
}

function toInput(rule: TriggerRule): TriggerRuleInput {
  return {
    name: rule.name,
    enabled: rule.enabled,
    match: { ...rule.match },
    action: { ...rule.action },
    sendEnter: rule.sendEnter,
    mode: rule.mode,
    cooldownMs: rule.cooldownMs,
  };
}

function matchSummary(trigger: TriggerRule, x: ReturnType<typeof useI18n>['x']): string {
  return `[${x(trigger.match.type === 'regex' ? 'triggers.regexShort' : 'triggers.textShort')}] ${trigger.match.value}`;
}

function actionSummary(trigger: TriggerRule, x: ReturnType<typeof useI18n>['x']): string {
  if (trigger.action.type === 'notify') return x('triggers.notifyShort');
  return x('triggers.sendSummary', {
    value: JSON.stringify(trigger.action.value),
    enter: trigger.sendEnter ? x('triggers.plusEnter') : '',
  });
}

function messageOf(error: unknown, x: ReturnType<typeof useI18n>['x']): string {
  return error instanceof Error ? error.message : x('triggers.operationFailed');
}
