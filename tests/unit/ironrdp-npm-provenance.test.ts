import { describe, expect, it } from 'vitest';
import { inspectIronRdpNpmProvenance } from '../../scripts/commercialization/verify-ironrdp-npm-provenance.mjs';

const name = '@devolutions/iron-remote-desktop-rdp';
const version = '0.7.0';
const registry = 'https://registry.npmjs.org/';
const integrity =
  'sha512-CclAh4OS9aBoPJT0l7bih7ETOHPnB9KjT0drB0a6r5+Qh95pTEuQCx7uFN/XA2AlkFlrqx+DBAMDGYXmgsjHAQ==';
const digest = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');
const publishPredicate = 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1';
const provenancePredicate = 'https://slsa.dev/provenance/v1';

function bundle(predicateType: string, predicate: Record<string, unknown>, subjectDigest = digest) {
  return {
    predicateType,
    bundle: {
      dsseEnvelope: {
        payload: Buffer.from(
          JSON.stringify({
            predicateType,
            subject: [
              {
                name: 'pkg:npm/%40devolutions/iron-remote-desktop-rdp@0.7.0',
                digest: { sha512: subjectDigest },
              },
            ],
            predicate,
          }),
        ).toString('base64'),
      },
    },
  };
}

function verifiedReport(commit = 'e45f68c7e52297ca50d33b44c0ace36c9940fbe6') {
  return {
    invalid: [] as Array<{ name: string }>,
    missing: [] as Array<{ name: string }>,
    verified: [
      {
        name,
        version,
        registry,
        attestationBundles: [
          bundle(publishPredicate, { name, version, registry: new URL(registry).origin }),
          bundle(provenancePredicate, {
            buildDefinition: {
              externalParameters: {
                workflow: {
                  repository: 'https://github.com/Devolutions/IronRDP',
                  path: '.github/workflows/npm-publish.yml',
                  ref: 'refs/heads/master',
                },
              },
              internalParameters: { github: { event_name: 'workflow_dispatch' } },
              resolvedDependencies: [
                {
                  uri: 'git+https://github.com/Devolutions/IronRDP@refs/heads/master',
                  digest: { gitCommit: commit },
                },
              ],
            },
            runDetails: {
              builder: { id: 'https://github.com/actions/runner/github-hosted' },
              metadata: {
                invocationId:
                  'https://github.com/Devolutions/IronRDP/actions/runs/26511159700/attempts/1',
              },
            },
          }),
        ],
      },
    ],
  };
}

describe('IronRDP npm publisher-provenance inspection', () => {
  it('binds the verified tarball to the reviewed Devolutions release workflow', () => {
    expect(inspectIronRdpNpmProvenance(verifiedReport())).toMatchObject({
      package: `${name}@${version}`,
      npmIntegrity: integrity,
      sourceCommit: 'e45f68c7e52297ca50d33b44c0ace36c9940fbe6',
      verifiedAttestations: [publishPredicate, provenancePredicate],
    });
  });

  it('rejects a different source commit even when npm reports a verified package', () => {
    expect(() => inspectIronRdpNpmProvenance(verifiedReport('0'.repeat(40)))).toThrow(
      'source commit or publisher workflow changed',
    );
  });

  it('rejects a signed subject that does not match the reviewed tarball', () => {
    const report = verifiedReport();
    report.verified[0]!.attestationBundles[1] = bundle(provenancePredicate, {}, '0'.repeat(128));
    expect(() => inspectIronRdpNpmProvenance(report)).toThrow(
      'Attestation subject differs from the locked',
    );
  });

  it('rejects missing, invalid or non-official-registry verification results', () => {
    const missing = verifiedReport();
    missing.missing.push({ name });
    expect(() => inspectIronRdpNpmProvenance(missing)).toThrow('missing registry signature');
    const invalid = verifiedReport();
    invalid.invalid.push({ name });
    expect(() => inspectIronRdpNpmProvenance(invalid)).toThrow('invalid registry signature');
    const mirror = verifiedReport();
    mirror.verified[0]!.registry = 'https://registry.npmmirror.com/';
    expect(() => inspectIronRdpNpmProvenance(mirror)).toThrow('identity or registry changed');
  });
});
