import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import type { LegalDocumentDescriptor } from '@axterm/plugin-api/configuration';
import type { SettingsModel } from './index.ts';
import { LegalDocumentsModel } from './legal.ts';
import dictionaries from './legal-locales.json' with { type: 'json' };
import styles, { cssText } from './legal.module.css';
declare module '@axterm/ui' {
  interface LocaleNamespaceMap {
    legal: keyof typeof dictionaries.en;
  }
}
const cls = (...names: string[]) =>
  names.map((name) => name + ' ' + (styles[name] ?? '')).join(' ');
type Text = PropsLocale<'legal'>['t'];
type LegalBundle = {
  components: Array<{
    name: string;
    version: string;
    files: Array<{ name: string; content: string }>;
    attribution: unknown;
  }>;
  limitations: unknown;
  missingCopyrightDeclarations: unknown;
};
function parseLegalBundle(content: string): LegalBundle | undefined {
  try {
    const value = JSON.parse(content) as LegalBundle;
    if (
      !Array.isArray(value.components) ||
      !value.components.every(
        (component) =>
          typeof component.name === 'string' &&
          typeof component.version === 'string' &&
          Array.isArray(component.files) &&
          component.files.every(
            (file) => typeof file.name === 'string' && typeof file.content === 'string',
          ),
      )
    )
      return;
    return value;
  } catch {
    return;
  }
}
function Document({
  document,
  model,
  title,
  t,
  bundle = false,
}: {
  document: LegalDocumentDescriptor;
  model: LegalDocumentsModel;
  title: string;
  t: Text;
  bundle?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [content, setContent] = useState<string>(),
    [failed, setFailed] = useState(false),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open || content !== undefined) return;
    const abort = new AbortController();
    void Promise.resolve()
      .then(() => {
        abort.signal.throwIfAborted();
        setFailed(false);
        return model.read(document.id, abort.signal);
      })
      .then(
        (text) => {
          if (!abort.signal.aborted) setContent(text);
        },
        () => {
          if (!abort.signal.aborted) setFailed(true);
        },
      );
    return () => abort.abort();
  }, [open, content, attempt, document.id, model]);
  let nested: ReactNode;
  if (content !== undefined && bundle) {
    const parsed = parseLegalBundle(content);
    nested = parsed ? (
      <>
        <details>
          <summary>{t('legal.readThirdPartyAttributions')}</summary>
          <pre tabIndex={0}>
            {JSON.stringify(
              {
                source:
                  'Package manifest author/contributor and copyright fields plus copyright lines extracted from installed root LICENSE/COPYING/NOTICE files.',
                reviewQueue: parsed.missingCopyrightDeclarations,
                components: parsed.components.map(({ name, version, attribution }) => ({
                  name,
                  version,
                  ...(attribution as object),
                })),
                limitations: parsed.limitations,
              },
              null,
              2,
            )}
          </pre>
        </details>
        {parsed.components.flatMap((component) =>
          component.files.map((file, index) => (
            <details key={component.name + component.version + index}>
              <summary>{component.name + '@' + component.version + '/' + file.name}</summary>
              <pre tabIndex={0}>{file.content}</pre>
            </details>
          )),
        )}
      </>
    ) : (
      <p role="alert">{t('common.operationFailed')}</p>
    );
  }
  return (
    <details
      data-legal-document={document.id}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{title}</summary>
      {!bundle ? (
        <>
          <pre tabIndex={0} aria-busy={open && content === undefined && !failed}>
            {content ?? t(failed ? 'common.operationFailed' : 'connectionProfiles.loading')}
          </pre>
          {failed && (
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>
              {t('common.retry')}
            </button>
          )}
        </>
      ) : content !== undefined ? (
        nested
      ) : failed ? (
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          {t('common.retry')}
        </button>
      ) : open ? (
        <p role="status" aria-busy="true">
          {t('connectionProfiles.loading')}
        </p>
      ) : null}
    </details>
  );
}
export function installLegalUi(ctx: Context, settings: SettingsModel): void {
  const model = new LegalDocumentsModel(ctx, settings);
  ctx.effect(() => () => model.close());
  ctx.effect(() => ctx.locale.register('legal', dictionaries));
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = '@axterm/plugin-configuration';
    style.textContent = cssText;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.slots.inject('settings.legal', function* () {
    yield ctx.slots.register(
      { name: 'settings.legal', id: 'configuration.legal', locale: 'legal' },
      function Legal({ t }: PropsLocale<'legal'>) {
        const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
        useEffect(() => {
          void model.load().catch(() => {});
        }, []);
        const documents = state.status === 'ready' ? state.baseline.documents : [],
          find = (name: string) => documents.find((value) => value.name === name),
          product = find('LICENSE'),
          notices = find('THIRD_PARTY_NOTICES.txt');
        return (
          <section
            className={cls('surface', 'legal-notices-panel')}
            aria-label={t('legal.title')}
            data-legal-notices=""
          >
            <h2>{t('legal.productLicense')}</h2>
            <p className={cls('hint')}>{t('legal.productDescription')}</p>
            {product && (
              <Document
                key={product.sha256}
                document={product}
                model={model}
                title={t('legal.readProductLicense')}
                t={t}
              />
            )}
            <h2>{t('legal.thirdPartyNotices')}</h2>
            <p className={cls('hint')}>{t('legal.thirdPartyDescription')}</p>
            {notices && (
              <Document
                key={notices.sha256}
                document={notices}
                model={model}
                title={t('legal.readThirdPartyNotices')}
                t={t}
              />
            )}
            {location.protocol === 'axterm-app:' && (
              <details>
                <summary>{t('legal.readElectronRuntimeLicenses')}</summary>
                <p className={cls('hint')}>{t('legal.electronRuntimeLicenseDescription')}</p>
                {(['electron', 'chromium'] as const).map((id) => (
                  <RuntimeDocument
                    key={id}
                    id={id}
                    title={t(id === 'electron' ? 'legal.electronLicense' : 'legal.chromiumNotices')}
                  />
                ))}
              </details>
            )}
            {documents
              .filter((value) => value !== product && value !== notices)
              .map((document) => (
                <Document
                  key={document.sha256 + document.id}
                  document={document}
                  model={model}
                  title={document.name.split('/').at(-1)!}
                  t={t}
                  bundle={document.name === 'compliance/THIRD_PARTY_LICENSE_TEXTS.json'}
                />
              ))}
            {state.status === 'connecting' && (
              <p role="status">{t('connectionProfiles.loading')}</p>
            )}
            {state.status === 'error' && (
              <p role="alert">
                {t('common.operationFailed')}
                <button
                  onClick={() => {
                    void model.load().catch(() => {});
                  }}
                >
                  {t('common.retry')}
                </button>
              </p>
            )}
          </section>
        );
      },
    );
  });
}
function RuntimeDocument({ id, title }: { id: 'electron' | 'chromium'; title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{title}</summary>
      {open && (
        <iframe
          className={cls('legal-runtime-license-frame')}
          referrerPolicy="no-referrer"
          sandbox=""
          src={'axterm-app://app/desktop/licenses/' + id}
          title={title}
        />
      )}
    </details>
  );
}
