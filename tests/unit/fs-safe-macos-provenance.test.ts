import { describe, expect, it } from 'vitest';
import { fsSafeMacProvenanceViolations } from '../../scripts/commercialization/verify-fs-safe-macos-provenance.mjs';

const binarySha256 = '78ca69b52d05da239bf50a6768867134265aace0195c8494f64f65b6d1ba6db0';
const tarballSha512 =
  '7723c239f31524c5da3f6c89208c99aef2b74f242908476e86fbdf1f765b730ff84ab74a3f9ef8aa086024cf950958364fd4c41d337860134eeb3e768a2308de';

function matchingEvidence() {
  return {
    audit: {
      invalid: [],
      missing: [],
      verified: [
        {
          name: '@openclaw/fs-safe-darwin-arm64',
          version: '0.13.1',
          registry: 'https://registry.npmjs.org',
          attestations: { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } },
        },
      ],
    },
    statement: {
      _type: 'https://in-toto.io/Statement/v1',
      predicateType: 'https://slsa.dev/provenance/v1',
      subject: [
        {
          name: 'pkg:npm/%40openclaw/fs-safe-darwin-arm64@0.13.1',
          digest: { sha512: tarballSha512 },
        },
      ],
      predicate: {
        buildDefinition: {
          externalParameters: {
            workflow: {
              repository: 'https://github.com/openclaw/fs-safe',
              ref: 'refs/tags/v0.13.1',
              path: '.github/workflows/release.yml',
            },
          },
          resolvedDependencies: [
            {
              uri: 'git+https://github.com/openclaw/fs-safe@refs/tags/v0.13.1',
              digest: { gitCommit: '7022a0a10c53e36f34a467df68ed5614a1db1741' },
            },
          ],
        },
        runDetails: {
          metadata: {
            invocationId: 'https://github.com/openclaw/fs-safe/actions/runs/35153270431/attempts/1',
          },
        },
      },
    },
    run: {
      id: 35153270431,
      run_attempt: 1,
      status: 'completed',
      conclusion: 'success',
      event: 'push',
      head_branch: 'v0.13.1',
      head_sha: '7022a0a10c53e36f34a467df68ed5614a1db1741',
      path: '.github/workflows/release.yml',
    },
    archiveSha512: tarballSha512,
    archiveIntegrity:
      'sha512-dyPCOfMVJMXaP2yJIIyZrvK3TyQpCEduhvvfH3Zbcw/4SrdKP574qghgJM+VCVg2T9TEHTN4YBNO6z52iiMI3g==',
    archiveBinarySha256: binarySha256,
    installedBinarySha256: binarySha256,
    packagedBinarySha256: binarySha256,
  };
}

describe('fs-safe published macOS native provenance', () => {
  it('accepts an attested official-registry tarball linked to the packaged binary', () => {
    expect(fsSafeMacProvenanceViolations(matchingEvidence())).toEqual([]);
  });

  it('rejects a mirror, wrong source commit, changed tarball and changed packaged binary', () => {
    const evidence = matchingEvidence();
    evidence.audit.verified[0]!.registry = 'https://registry.npmmirror.com';
    evidence.statement.predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit =
      '0000000000000000000000000000000000000000';
    evidence.archiveSha512 = '0'.repeat(128);
    evidence.packagedBinarySha256 = '0'.repeat(64);
    expect(fsSafeMacProvenanceViolations(evidence)).toEqual([
      'npm CLI did not verify the exact official-registry provenance',
      'Verified SLSA statement does not describe the pinned tag, commit and run',
      'Official registry tarball bytes/integrity differ from the attested subject',
      'Archive, installed or packaged macOS native binding bytes differ',
    ]);
  });
});
