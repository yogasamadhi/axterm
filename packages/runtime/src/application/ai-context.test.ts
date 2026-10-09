import { describe, expect, it } from 'vitest';
import {
  buildAiModelContext,
  redact,
  AI_CONTEXT_BASE_CHARACTERS,
  AI_CONTEXT_TOTAL_CHARACTERS,
} from './ai-context';

const input = {
  prompt: 'review',
  context: '',
  useCase: 'diagnose' as const,
  history: [],
  historyCount: 0,
  includeConversationHistory: true,
  attachments: [],
};

describe('bounded model context sources', () => {
  it('uses Pi-loaded skill bodies and keeps generation reply-only even in work mode', () => {
    const generated = buildAiModelContext({ ...input, mode: 'work', useCase: 'generateCommand' });
    expect(generated.system).toContain('<skill name="generate-command">');
    expect(generated.system).toContain('Do not execute');
    expect(generated.system).not.toContain('use workspace_exec');
    expect(buildAiModelContext({ ...input, mode: 'work' }).system).toContain('use workspace_exec');
    expect(buildAiModelContext({ ...input, useCase: 'chat' }).system).not.toContain(
      'use workspace_exec',
    );
  });
  it('redacts an incomplete private key, JSON values, short authorization and cloud key patterns idempotently', () => {
    const raw = [
      'Authorization: Basic dXNlcjpwYXNz',
      'Bearer short',
      '{"password": "phrase with spaces"}',
      `sk-proj-${'a'.repeat(20)}`,
      `AKIA${'1'.repeat(16)}`,
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'private body without closing marker',
    ].join('\n');
    const safe = redact(raw);
    expect(safe).not.toMatch(/dXNlcj|short|phrase with spaces|a{20}|1{16}|private body/u);
    expect(redact(safe)).toBe(safe);
  });
  it('retains at most 32 recent messages and reports both selection and character truncation', () => {
    const history = Array.from({ length: 40 }, (_, i) => ({
      role: 'user' as const,
      content: `message${i}\n${'h'.repeat(2_000)}`,
    }));
    const built = buildAiModelContext({ ...input, history, historyCount: 40 });
    expect(built.context.length).toBe(AI_CONTEXT_BASE_CHARACTERS);
    expect(built.context).toContain('message39');
    expect(built.context).not.toContain('message7\n');
    expect(built.sources.find((x) => x.kind === 'history')).toMatchObject({
      selectedItems: 32,
      availableItems: 40,
      truncated: true,
      includedBytes: AI_CONTEXT_BASE_CHARACTERS,
    });
    const omitted = buildAiModelContext({
      ...input,
      history,
      historyCount: 40,
      includeConversationHistory: false,
    });
    expect(omitted.context).toBe('');
    expect(omitted.sources.some((x) => x.kind === 'history')).toBe(false);
  });
  it('accounts for the exact retained context portion instead of treating character counts as UTF-8 bytes', () => {
    const built = buildAiModelContext({
      ...input,
      context: '界'.repeat(30_000),
      history: [{ role: 'user', content: 'old history' }],
      historyCount: 1,
    });
    expect(built.context.length).toBe(AI_CONTEXT_BASE_CHARACTERS);
    expect(built.sources.find((x) => x.kind === 'context')).toMatchObject({
      originalBytes: 90_000,
      includedBytes: AI_CONTEXT_BASE_CHARACTERS * 3,
      truncated: true,
    });
    expect(built.sources.find((x) => x.kind === 'history')).toMatchObject({
      includedBytes: 0,
      truncated: true,
    });
  });
  it('describes content cropping caused by escaped file names at the final assembled cap', () => {
    const content = 'x'.repeat(12_800);
    const attachments = Array.from({ length: 8 }, (_, i) => ({
      content,
      preview: {
        id: String(i),
        name: "'".repeat(255),
        size: 12_800,
        includedBytes: 12_800,
        truncated: false,
        redacted: false,
        preview: content.slice(0, 8_192),
        expiresAt: '2026-10-03T20:00:00.000Z',
      },
    }));
    const built = buildAiModelContext({
      ...input,
      context: 'b'.repeat(AI_CONTEXT_BASE_CHARACTERS),
      attachments,
    });
    expect(built.context.length).toBe(AI_CONTEXT_TOTAL_CHARACTERS);
    expect(built.sources.find((x) => x.kind === 'context')?.truncated).toBe(true);
    expect(built.sources.filter((x) => x.kind === 'attachment')).toHaveLength(8);
    expect(
      built.sources.filter((x) => x.kind === 'attachment').every((x) => x.includedBytes === 12_800),
    ).toBe(true);
  });
  it('bounds redaction expansion and redacts configured system instructions before preview or send', () => {
    const built = buildAiModelContext({
      ...input,
      prompt: 'token=x '.repeat(2_000),
      role: 'password=role-secret',
    });
    expect(built.prompt.length).toBe(16_384);
    expect(built.sources.find((x) => x.kind === 'prompt')).toMatchObject({
      redacted: true,
      truncated: true,
    });
    expect(built.system).not.toContain('role-secret');
    expect(built.system).toContain('password=[REDACTED]');
  });
});
