import { useRef, useState } from 'react';
import axtermLicense from '../../../../../../LICENSE?raw';
import thirdPartyNotices from '../../../../../../THIRD_PARTY_NOTICES.txt?raw';
import thirdPartyComponents from '../../../../../../compliance/THIRD_PARTY_COMPONENTS.json?raw';
import productionSbom from '../../../../../../compliance/AXTERM_PRODUCTION_DEPENDENCIES.spdx.json?raw';
import thirdPartyLicenseTexts from '../../../../../../compliance/THIRD_PARTY_LICENSE_TEXTS.json?raw';
import { useI18n } from '../i18n/context';

const licenseDocuments = Object.entries(
  import.meta.glob<string>('../../../../../../licenses/*.txt', {
    import: 'default',
    query: '?raw',
  }),
)
  .map(([path, load]) => ({ name: path.slice(path.lastIndexOf('/') + 1), load }))
  .sort((left, right) => left.name.localeCompare(right.name, 'en'));

function LicenseTextDocument({ name, load }: { name: string; load: () => Promise<string> }) {
  const { x } = useI18n();
  const [content, setContent] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const loading = useRef(false);

  function loadOnce() {
    if (content !== null || loading.current) return;
    loading.current = true;
    setFailed(false);
    void load()
      .then(setContent)
      .catch(() => setFailed(true))
      .finally(() => {
        loading.current = false;
      });
  }

  return (
    <details onToggle={(event) => event.currentTarget.open && loadOnce()}>
      <summary>{name}</summary>
      {content !== null ? (
        <pre tabIndex={0}>{content}</pre>
      ) : failed ? (
        <button type="button" onClick={loadOnce}>
          {x('app.retry')}
        </button>
      ) : (
        <p role="status" aria-busy="true">
          {x('connectionProfiles.loading')}
        </p>
      )}
    </details>
  );
}

const packageLicenseTexts = JSON.parse(thirdPartyLicenseTexts) as {
  limitations: string[];
  missingCopyrightDeclarations: Array<{ name: string; version: string }>;
  components: Array<{
    name: string;
    version: string;
    files: Array<{ name: string; content: string }>;
    attribution: {
      manifestPublisherRecords: Array<{
        field: 'author' | 'contributors';
        value: string | Record<string, unknown>;
      }>;
      manifestCopyright: string | null;
      rootLicenseCopyrightLines: Array<{ file: string; line: string }>;
    };
  }>;
};

const packageAttributionMetadata = JSON.stringify(
  {
    source:
      'Package manifest author/contributor and copyright fields plus copyright lines extracted from installed root LICENSE/COPYING/NOTICE files.',
    reviewQueue: packageLicenseTexts.missingCopyrightDeclarations,
    components: packageLicenseTexts.components.map(({ name, version, attribution }) => ({
      name,
      version,
      ...attribution,
    })),
    limitations: packageLicenseTexts.limitations,
  },
  null,
  2,
);

function RuntimeLegalDocument({ id, title }: { id: 'electron' | 'chromium'; title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{title}</summary>
      {open && (
        <iframe
          className="legal-runtime-license-frame"
          referrerPolicy="no-referrer"
          sandbox=""
          src={`axterm-license://${id}/`}
          title={title}
        />
      )}
    </details>
  );
}

export function LegalNoticesPanel() {
  const { x } = useI18n();
  return (
    <section className="surface legal-notices-panel" aria-label={x('legal.title')}>
      <h2>{x('legal.productLicense')}</h2>
      <p className="hint">{x('legal.productDescription')}</p>
      <details>
        <summary>{x('legal.readProductLicense')}</summary>
        <pre tabIndex={0}>{axtermLicense}</pre>
      </details>
      <h2>{x('legal.thirdPartyNotices')}</h2>
      <p className="hint">{x('legal.thirdPartyDescription')}</p>
      <details>
        <summary>{x('legal.readThirdPartyNotices')}</summary>
        <pre tabIndex={0}>{thirdPartyNotices}</pre>
      </details>
      <details>
        <summary>{x('legal.readElectronRuntimeLicenses')}</summary>
        <p className="hint">{x('legal.electronRuntimeLicenseDescription')}</p>
        <RuntimeLegalDocument id="electron" title={x('legal.electronLicense')} />
        <RuntimeLegalDocument id="chromium" title={x('legal.chromiumNotices')} />
      </details>
      {licenseDocuments.map(({ name, load }) => (
        <LicenseTextDocument key={name} name={name} load={load} />
      ))}
      <details>
        <summary>THIRD_PARTY_COMPONENTS.json</summary>
        <pre tabIndex={0}>{thirdPartyComponents}</pre>
      </details>
      <details>
        <summary>AXTERM_PRODUCTION_DEPENDENCIES.spdx.json</summary>
        <pre tabIndex={0}>{productionSbom}</pre>
      </details>
      <details>
        <summary>THIRD_PARTY_LICENSE_TEXTS.json</summary>
        <details>
          <summary>{x('legal.readThirdPartyAttributions')}</summary>
          <pre tabIndex={0}>{packageAttributionMetadata}</pre>
        </details>
        {packageLicenseTexts.components.flatMap(({ name, version, files }) =>
          files.map((file) => (
            <details key={`${name}@${version}/${file.name}`}>
              <summary>{`${name}@${version}/${file.name}`}</summary>
              <pre tabIndex={0}>{file.content}</pre>
            </details>
          )),
        )}
      </details>
    </section>
  );
}
