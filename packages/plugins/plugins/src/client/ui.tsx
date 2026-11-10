import type {} from '@axterm/infra-client-modules/client';
import type { PropsLocale } from '@axterm/ui';
import { dictionaries } from './locales.ts';
import { useState, useRef, useEffect, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PluginCommandInput } from '@axterm/plugin-api/plugins';
import type { PluginsModel } from './model.ts';
import type {} from '@axterm/ui/workspace';
import {
  Button,
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  Input,
  Label,
} from '@axterm/ui/controls';
import styles, { cssText } from './ui.module.css';
export function installPluginsUi(ctx: Context, model: PluginsModel): void {
  ctx.effect(() => ctx.locale.register('plugins', dictionaries));
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = '@axterm/plugin-plugins';
    style.textContent = cssText;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.slots.inject('workspace.toolbar', function* () {
    yield ctx.slots.register(
      { name: 'workspace.toolbar', id: 'plugins.manager', order: 105, locale: 'plugins' },
      function PluginsEntry({ t }: PropsLocale<'plugins'>) {
        const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
        const clientState = useSyncExternalStore(
          ctx.modules.entries.state.subscribe,
          ctx.modules.entries.state.getSnapshot,
        );
        const inventory = state.status === 'ready' ? state.snapshot.inventory : null;
        const [busy, setBusy] = useState(false),
          [notice, setNotice] = useState<keyof typeof dictionaries.en | ''>(''),
          [build, setBuild] = useState<{ id: string; name: string; version: string }>();
        const active = useRef(false),
          alive = useRef(true);
        useEffect(() => {
          alive.current = true;
          return () => {
            alive.current = false;
          };
        }, []);
        async function run(input: PluginCommandInput) {
          if (active.current) return;
          active.current = true;
          setBusy(true);
          setNotice('');
          try {
            const result = await model.execute(input);
            if (alive.current)
              setNotice(
                result.status !== 'completed'
                  ? 'failed'
                  : result.result?.application === 'overridden'
                    ? 'overridden'
                    : result.result?.application === 'restart-required'
                      ? result.result.restartReason === 'offline-upgrade-required'
                        ? 'offlineUpgrade'
                        : 'restartRequired'
                      : 'completed',
              );
          } catch {
            if (alive.current) setNotice('failed');
          } finally {
            active.current = false;
            if (alive.current) setBusy(false);
          }
        }
        function submit(form: HTMLFormElement) {
          const data = new FormData(form);
          if (!data.has('consent')) return;
          void run({
            operation: 'install',
            spec: String(data.get('spec') ?? '').trim(),
            replace: data.has('replace'),
            enabled: data.has('enable'),
          });
        }
        return (
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="ghost" data-plugins-manager-trigger="">
                {t('title')}
              </Button>
            </DialogTrigger>
            <DialogContent className={styles.dialog} data-plugins-manager="">
              <DialogTitle>{t('title')}</DialogTitle>
              <DialogDescription>{t('trust')}</DialogDescription>
              <Button
                variant="secondary"
                onClick={() => {
                  void model.retry().catch(() => setNotice('failed'));
                }}
              >
                {t('refresh')}
              </Button>
              {notice && <p role="status">{t(notice)}</p>}
              {!inventory && <p role="status">{t('loading')}</p>}
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  submit(event.currentTarget);
                }}
                className={styles.form}
              >
                <Label htmlFor="plugin-spec">{t('spec')}</Label>
                <Input
                  id="plugin-spec"
                  name="spec"
                  required
                  maxLength={512}
                  placeholder="@example/plugin@1.0.0"
                  disabled={busy}
                />
                <Label>
                  <input type="checkbox" name="replace" disabled={busy} />
                  {t('replace')}
                </Label>
                <Label>
                  <input type="checkbox" name="enable" defaultChecked disabled={busy} />
                  {t('enable')}
                </Label>
                <Label>
                  <input type="checkbox" name="consent" required disabled={busy} />
                  {t('consent')}
                </Label>
                <Button type="submit" disabled={busy}>
                  {t('install')}
                </Button>
              </form>
              <ul className={styles.packages}>
                {inventory?.packages.map((pkg) => (
                  <li key={pkg.name}>
                    <strong>{pkg.name}</strong> <span>{pkg.version}</span>
                    {pkg.problem && <code>{pkg.problem}</code>}
                    <div className={styles.actions}>
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          void run({ operation: 'bundle', name: pkg.name, enabled: !pkg.enabled })
                        }
                      >
                        {pkg.enabled ? t('off') : t('on')}
                      </Button>
                      {pkg.installed && (
                        <>
                          <Button
                            variant="secondary"
                            disabled={busy}
                            onClick={() =>
                              void run({
                                operation: 'install',
                                spec: pkg.name + '@latest',
                                replace: true,
                                enabled: pkg.enabled,
                              })
                            }
                          >
                            {t('upgrade')}
                          </Button>
                          <Button
                            variant="destructive"
                            disabled={busy}
                            onClick={() => void run({ operation: 'remove', name: pkg.name })}
                          >
                            {t('remove')}
                          </Button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              <ul className={styles.packages}>
                {inventory?.entries.map((row) => (
                  <li key={row.id}>
                    <code>{row.id}</code>
                    {row.state && (
                      <span>
                        {t(
                          (
                            {
                              active: 'entryActive',
                              loading: 'entryLoading',
                              failed: 'entryFailed',
                              pending: 'entryPending',
                              unloading: 'entryUnloading',
                              'not-running': 'entryNotRunning',
                              offline: 'entryOffline',
                            } as const
                          )[row.state],
                        )}
                      </span>
                    )}
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        void run({ operation: 'entry', id: row.id, enabled: row.disabled })
                      }
                    >
                      {row.disabled ? t('on') : t('off')}
                    </Button>
                  </li>
                ))}
              </ul>
              <h3>{t('builds')}</h3>
              <ul className={styles.packages}>
                {inventory?.builds.map((item) => (
                  <li key={item.id}>
                    {item.name}@{item.version}
                    <Button variant="secondary" disabled={busy} onClick={() => setBuild(item)}>
                      {t('approve')}
                    </Button>
                  </li>
                ))}
              </ul>
              <Dialog
                open={!!build}
                onOpenChange={(open) => {
                  if (!open) setBuild(undefined);
                }}
              >
                <DialogContent>
                  <DialogTitle>{t('confirmBuild')}</DialogTitle>
                  <DialogDescription>
                    {build?.name}@{build?.version}
                  </DialogDescription>
                  <Button variant="secondary" onClick={() => setBuild(undefined)}>
                    {t('cancel')}
                  </Button>
                  <Button
                    disabled={busy || !build}
                    onClick={() => {
                      const selected = build;
                      setBuild(undefined);
                      if (selected)
                        void run({ operation: 'build', ids: [selected.id], confirmed: true });
                    }}
                  >
                    {t('confirm')}
                  </Button>
                </DialogContent>
              </Dialog>
              {inventory && inventory.transactions.length > 0 && (
                <p role="alert">{t('recovery')}</p>
              )}
              <h3>{t('versionRisk')}</h3>
              <form
                className={styles.form}
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  void run({
                    operation: 'compatibility',
                    packageVersion: String(data.get('packageVersion') ?? ''),
                    runtimeVersion: String(data.get('runtimeVersion') ?? ''),
                    enabled: true,
                    acceptRisk: data.has('risk'),
                  });
                }}
              >
                <Label htmlFor="plugin-version">{t('packageVersion')}</Label>
                <Input id="plugin-version" name="packageVersion" required maxLength={512} />
                <Label htmlFor="plugin-runtime-version">{t('runtimeVersion')}</Label>
                <Input
                  id="plugin-runtime-version"
                  name="runtimeVersion"
                  required
                  maxLength={128}
                  defaultValue={
                    state.status === 'ready' ? (state.snapshot.runtimeVersion ?? '') : ''
                  }
                />
                <Label>
                  <input type="checkbox" name="risk" required disabled={busy} />
                  {t('riskConsent')}
                </Label>
                <Button disabled={busy}>{t('allow')}</Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={(event) => {
                    const form = event.currentTarget.form;
                    if (!form) return;
                    const data = new FormData(form);
                    void run({
                      operation: 'compatibility',
                      packageVersion: String(data.get('packageVersion') ?? ''),
                      runtimeVersion: String(data.get('runtimeVersion') ?? ''),
                      enabled: false,
                      acceptRisk: false,
                    });
                  }}
                >
                  {t('revoke')}
                </Button>
              </form>

              <h3>{t('clientComponents')}</h3>
              {clientState.failures.map((failure) => (
                <p role="alert" key={failure.id}>
                  <strong>{failure.id}</strong> {t('clientFailed')}
                </p>
              ))}
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  void ctx.modules.entries.retry().catch(() => setNotice('failed'));
                }}
              >
                {t('retryClient')}
              </Button>
              <h3>{t('commands')}</h3>
              <ul className={styles.packages}>
                {state.status === 'ready' &&
                  state.snapshot.commands.map((item) => (
                    <li key={item.id}>
                      <strong>
                        {t(
                          (
                            {
                              install: 'install',
                              remove: 'remove',
                              bundle: 'opBundle',
                              entry: 'opEntry',
                              compatibility: 'opCompatibility',
                              build: 'opBuild',
                            } as const
                          )[item.operation],
                        )}
                      </strong>
                      {item.target && <span>{item.target}</span>}
                      <span>
                        {t(
                          (
                            {
                              running: 'statusRunning',
                              completed: 'statusCompleted',
                              failed: 'statusFailed',
                              uncertain: 'statusUncertain',
                              interrupted: 'statusInterrupted',
                            } as const
                          )[item.status],
                        )}
                      </span>
                      {item.result?.application === 'overridden' && <span>{t('overridden')}</span>}
                      {item.result?.application === 'restart-required' && (
                        <span>
                          {t(
                            item.result.restartReason === 'offline-upgrade-required'
                              ? 'offlineUpgrade'
                              : 'restartRequired',
                          )}
                        </span>
                      )}
                    </li>
                  ))}
              </ul>
            </DialogContent>
          </Dialog>
        );
      },
    );
  });
}
