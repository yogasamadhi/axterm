import type {} from '@axterm/infra-client-modules/client';
import type {} from '@axterm/ui/workspace';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@axterm/plugin-api/plugins';
import type { PropsLocale } from '@axterm/ui';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  Textarea,
} from '@axterm/ui/controls';
import type { MarketModel } from './model.ts';
import type { MarketEntry } from '@axterm/plugin-api/market';
import { dictionaries } from './locales.ts';
import styles, { cssText } from './ui.module.css';
export function installMarketUi(ctx: Context, model: MarketModel): void {
  ctx.effect(() => ctx.locale.register('market', dictionaries));
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = '@axterm/plugin-market';
    style.textContent = cssText;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.slots.inject('workspace.toolbar', function* () {
    yield ctx.slots.register(
      { name: 'workspace.toolbar', id: 'market.browser', order: 106, locale: 'market' },
      function MarketEntry({ t }: PropsLocale<'market'>) {
        const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
        const installation = useSyncExternalStore(
          ctx.pluginActions.subscribe,
          ctx.pluginActions.getSnapshot,
        );
        const baseline = state.status === 'ready' ? state.baseline : undefined;
        const livePackages =
          installation.status === 'ready' ? installation.baseline.inventory?.packages : undefined;
        const page = state.status === 'ready' ? state.page : undefined;
        function installationStatus(item: MarketEntry): MarketEntry['installation'] {
          if (!livePackages) return item.installation;
          const installed = livePackages.find((value) => value.name === item.name);
          if (!installed) return 'not-installed';
          if (!installed.installed) return 'provided';
          const preferred =
            item.versions.find(
              (value) =>
                value.compatibility !== 'incompatible' &&
                !value.version.split('+')[0]!.includes('-'),
            ) ??
            item.versions.find((value) => value.compatibility !== 'incompatible') ??
            item.versions[0];
          if (preferred?.version === installed.version) return 'installed';
          const current = item.versions.findIndex((value) => value.version === installed.version),
            target = item.versions.findIndex((value) => value === preferred);
          return current >= 0 && target >= 0 && target < current
            ? 'update-available'
            : 'different-version';
        }

        const [busy, setBusy] = useState(false),
          [notice, setNotice] = useState<keyof typeof dictionaries.en | ''>('');
        const [selected, setSelected] = useState<string>('');
        const active = useRef(false),
          alive = useRef(true);
        useEffect(() => {
          alive.current = true;
          return () => {
            alive.current = false;
          };
        }, []);
        async function run(operation: () => Promise<unknown>) {
          if (active.current) return;
          active.current = true;
          setBusy(true);
          setNotice('');
          try {
            await operation();
            if (alive.current) setNotice('completed');
          } catch {
            if (alive.current) setNotice('failed');
          } finally {
            active.current = false;
            if (alive.current) setBusy(false);
          }
        }
        const chosen = selected.split('\n'),
          entry = page?.entries.find((value) => value.name === chosen[0]),
          version = entry?.versions.find((value) => value.version === chosen[1]);
        return (
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="ghost" data-market-trigger="">
                {t('title')}
              </Button>
            </DialogTrigger>
            <DialogContent className={styles.dialog} data-market-dialog="">
              <DialogTitle>{t('title')}</DialogTitle>
              <DialogDescription>{t('description')}</DialogDescription>
              <DialogClose asChild>
                <Button variant="ghost">{t('close')}</Button>
              </DialogClose>
              {notice && <p role="status">{t(notice)}</p>}
              {!baseline ? (
                <>
                  <p role="status">{t('unavailable')}</p>
                  <Button onClick={() => void run(() => model.retry())}>{t('retry')}</Button>
                </>
              ) : (
                <>
                  <form
                    key={baseline.revision}
                    className={styles.form}
                    onSubmit={(event) => {
                      event.preventDefault();
                      const data = new FormData(event.currentTarget);
                      void run(() =>
                        model.configure(
                          String(data.get('indexes') ?? '')
                            .split('\n')
                            .map((value) => value.trim())
                            .filter(Boolean),
                        ),
                      );
                    }}
                  >
                    <Label htmlFor="market-indexes">{t('indexes')}</Label>
                    <Textarea
                      id="market-indexes"
                      name="indexes"
                      rows={3}
                      maxLength={16384}
                      defaultValue={baseline.indexes.map((index) => index.url).join('\n')}
                      disabled={busy}
                    />
                    <p>{t('indexesHint')}</p>
                    <Button type="submit" disabled={busy}>
                      {t('save')}
                    </Button>
                  </form>
                  {baseline.indexes.length === 0 ? (
                    <p>{t('empty')}</p>
                  ) : (
                    <form
                      className={styles.form}
                      onSubmit={(event) => {
                        event.preventDefault();
                        const data = new FormData(event.currentTarget);
                        setSelected('');
                        void run(() =>
                          model.search({
                            url: String(data.get('index')),
                            text: String(data.get('text') ?? ''),
                            offset: 0,
                            limit: 10,
                            refresh: data.has('refresh'),
                          }),
                        );
                      }}
                    >
                      <Label htmlFor="market-index">{t('source')}</Label>
                      <select id="market-index" name="index" disabled={busy}>
                        {baseline.indexes.map((index) => (
                          <option key={index.url} value={index.url}>
                            {index.title ? index.title + ' — ' : ''}
                            {index.url}
                          </option>
                        ))}
                      </select>
                      <Label htmlFor="market-search">{t('search')}</Label>
                      <Input id="market-search" name="text" maxLength={256} disabled={busy} />
                      <Label>
                        <input type="checkbox" name="refresh" disabled={busy} />
                        {t('refresh')}
                      </Label>
                      <Button type="submit" disabled={busy}>
                        {t('search')}
                      </Button>
                    </form>
                  )}
                  {baseline.indexes.map((index) =>
                    index.error ? (
                      <p key={index.url} role="status">
                        {index.url}: {t('indexFailed')}
                      </p>
                    ) : null,
                  )}
                  {page && (
                    <>
                      <p>
                        {page.title} · {page.total} · {page.fetchedAt}
                      </p>
                      <ul className={styles.results}>
                        {page.entries.map((item) => (
                          <li key={item.name}>
                            <strong>{item.title}</strong>
                            <code>{item.name}</code>
                            <p>{item.description}</p>
                            <p>
                              {t(
                                (
                                  {
                                    'not-installed': 'notInstalled',
                                    installed: 'installed',
                                    'update-available': 'updateAvailable',
                                    'different-version': 'differentVersion',
                                    provided: 'provided',
                                  } as const
                                )[installationStatus(item)],
                              )}
                              {livePackages?.find((value) => value.name === item.name)?.version
                                ? ' ' +
                                  livePackages.find((value) => value.name === item.name)!.version
                                : item.installedVersion
                                  ? ' ' + item.installedVersion
                                  : ''}
                            </p>
                            <Label>
                              {t('version')}
                              <select
                                data-market-version={item.name}
                                value={entry?.name === item.name ? (version?.version ?? '') : ''}
                                onChange={(event) =>
                                  setSelected(item.name + '\n' + event.currentTarget.value)
                                }
                                disabled={busy}
                              >
                                <option value="">{t('choose')}</option>
                                {item.versions.map((value) => (
                                  <option key={value.version} value={value.version}>
                                    {value.version} ·{' '}
                                    {t(
                                      value.compatibility === 'compatible'
                                        ? 'compatible'
                                        : value.compatibility === 'incompatible'
                                          ? 'incompatible'
                                          : 'checkOnInstall',
                                    )}
                                    {!value.install ? ' · ' + t('unsupported') : ''}
                                  </option>
                                ))}
                              </select>
                            </Label>
                          </li>
                        ))}
                      </ul>
                      {page.nextOffset !== null && (
                        <Button disabled={busy} onClick={() => void run(() => model.next())}>
                          {t('next')}
                        </Button>
                      )}
                    </>
                  )}
                  {entry && version && (
                    <form
                      key={selected}
                      className={styles.form}
                      data-market-install=""
                      onSubmit={(event) => {
                        event.preventDefault();
                        const data = new FormData(event.currentTarget);
                        if (!data.has('consent') || !version.install) return;
                        const target = version.install;
                        void run(async () => {
                          const receipt = await ctx.pluginActions.execute({
                            operation: 'install',
                            spec: target.spec,
                            ...(target.registry ? { registry: target.registry } : {}),
                            replace:
                              livePackages?.some(
                                (value) => value.name === entry.name && value.installed,
                              ) ?? false,
                            enabled: true,
                          });
                          if (
                            receipt.status !== 'completed' ||
                            receipt.result?.application === 'failed'
                          )
                            throw new Error('MARKET_INSTALL_NOT_COMPLETED');
                        });
                      }}
                    >
                      <strong>
                        {entry.name}@{version.version}
                      </strong>
                      <code>{version.install?.registry ?? t('configuredRegistry')}</code>
                      <p>{t('trust')}</p>
                      <p>{t('compatibilityHint')}</p>
                      <Label>
                        <input type="checkbox" name="consent" required disabled={busy} />
                        {t('consent')}
                      </Label>
                      <Button
                        type="submit"
                        disabled={
                          busy ||
                          !version.install ||
                          version.compatibility === 'incompatible' ||
                          !livePackages
                        }
                      >
                        {t('install')}
                      </Button>
                    </form>
                  )}
                </>
              )}
            </DialogContent>
          </Dialog>
        );
      },
    );
  });
}
