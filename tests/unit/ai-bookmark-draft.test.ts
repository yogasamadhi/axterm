import { describe, expect, it } from 'vitest';
import { parseAiBookmarkDraft } from '../../apps/desktop/src/renderer/src/app/ai-bookmark-draft';

const valid = {
  name: 'Production API',
  title: 'Production API',
  hostname: 'api.example.com',
  port: 22,
  username: 'deploy',
  authType: 'privateKey',
  description: 'Primary application host',
  favorite: true,
} as const;

describe('AI bookmark draft', () => {
  it('accepts exact JSON and an optional JSON fence', () => {
    expect(parseAiBookmarkDraft(JSON.stringify(valid))).toEqual(valid);
    expect(parseAiBookmarkDraft(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``)).toEqual(valid);
  });

  it.each(['password', 'privateKey', 'passphrase', 'token', 'credentialRef'])(
    'rejects secret-bearing or unknown field %s',
    (field) => {
      expect(() =>
        parseAiBookmarkDraft(JSON.stringify({ ...valid, [field]: 'sensitive' })),
      ).toThrow();
    },
  );

  it('rejects malformed values and invalid SSH metadata', () => {
    expect(() => parseAiBookmarkDraft('{')).toThrow();
    expect(() => parseAiBookmarkDraft(JSON.stringify({ ...valid, port: 70_000 }))).toThrow();
    expect(() => parseAiBookmarkDraft(`Here is your bookmark: ${JSON.stringify(valid)}`)).toThrow();
  });
});
