import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = resolve('.github/workflows/check.yml');
const immutableAction = /\suses:\s+([^\s@]+)@([a-f0-9]{40})(?:\s+#\s+(v\d+(?:\.\d+){0,2}))?$/gmu;

describe('independent-release GitHub Actions provenance', () => {
  it('pins every external action to the reviewed release commit', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const actions = [...workflow.matchAll(immutableAction)].map((match) => ({
      action: match[1],
      commit: match[2],
      release: match[3],
    }));

    expect(actions).toEqual([
      {
        action: 'actions/checkout',
        commit: '11bd71901bbe5b1630ceea73d27597364c9af683',
        release: 'v4.2.2',
      },
      {
        action: 'actions/setup-node',
        commit: '49933ea5288caeca8642d1e84afbd3f7d6820020',
        release: 'v4.4.0',
      },
      {
        action: 'oven-sh/setup-bun',
        commit: '0c5077e51419868618aeaa5fe8019c62421857d6',
        release: 'v2.2.0',
      },
      ...Array.from({ length: 3 }, () => ({
        action: 'actions/upload-artifact',
        commit: 'ea165f8d65b6e75b540449e92b4886f43607fa02',
        release: 'v4.6.2',
      })),
      ...Array.from({ length: 3 }, () => ({
        action: 'actions/download-artifact',
        commit: 'd3f86a106a0bac45b974a628896c90dbdf5c8093',
        release: 'v4.3.0',
      })),
      ...Array.from({ length: 2 }, () => ({
        action: 'actions/upload-artifact',
        commit: 'ea165f8d65b6e75b540449e92b4886f43607fa02',
        release: 'v4.6.2',
      })),
    ]);

    const allUsesLines = workflow.split('\n').filter((line) => /^\s*(?:-\s+)?uses:\s+/u.test(line));
    expect(actions).toHaveLength(allUsesLines.length);
    expect(workflow).toMatch(
      /actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4\.2\.2\n\s+with:\n\s+[^\n]*\n\s+persist-credentials: false/u,
    );
  });
});
