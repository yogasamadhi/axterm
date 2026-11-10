import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ownedAiPolicy } from '../fixtures/level3-ai-policy.ts';
import {
  AI_ATTACHMENT_FILE_BYTES,
  AI_ATTACHMENT_TOTAL_BYTES,
} from '../../packages/plugins/ai/src/application/ai-service.ts';
describe('actual AI attachment policy and audit', () => {
  it('prepares redacted text attachments, persists metadata only, and consumes drafts once', async () => {
    const owned = await ownedAiPolicy();
    const database = owned.domain,
      repository = owned.repository;
    const model = repository.createJson(
      'ai_models',
      {
        providerId: randomUUID(),
        name: 'Unavailable fixture',
        model: 'fixture',
        capabilities: ['chat'],
      },
      'ai-model',
    );
    const revokeGrant = vi.fn(async () => undefined);
    const host = {
      readGrantedTextPrefix: vi.fn(async () => ({
        name: 'debug\nnotes.txt',
        size: 60 * 1024,
        content: 'failure details\npassword=supersecret\nnext check',
        includedBytes: AI_ATTACHMENT_FILE_BYTES,
        truncated: true,
      })),
      revokeGrant,
    };
    const service = owned.createService(host as never);
    const conversation = service.createConversation({
      name: 'Attachment test',
      modelId: model.id,
      useCase: 'diagnose',
    });
    const attachment = await service.prepareAttachment('grant-secret');
    expect(attachment).toMatchObject({
      name: 'debug notes.txt',
      size: 60 * 1024,
      includedBytes: AI_ATTACHMENT_FILE_BYTES,
      truncated: true,
      redacted: true,
    });
    expect(attachment.preview).not.toContain('supersecret');
    expect(revokeGrant).toHaveBeenCalledWith('grant-secret');
    const run = await service.start(
      {
        modelId: model.id,
        conversationId: conversation.id,
        useCase: 'diagnose',
        prompt: '',
        context: '',
        attachmentIds: [attachment.id],
      },
      randomUUID(),
    );
    await vi.waitFor(() => expect(service.get(run.id).state).toBe('failed'));
    const message = service.conversation(conversation.id).messages[0]!;
    expect(message).toMatchObject({
      role: 'user',
      content: '',
      attachments: [
        {
          name: 'debug notes.txt',
          size: 60 * 1024,
          includedBytes: AI_ATTACHMENT_FILE_BYTES,
          truncated: true,
        },
      ],
    });
    const stored = database.get<{ request: string }>(
      'SELECT request FROM ai_runs WHERE id=?',
      run.id,
    )!;
    expect(stored.request).not.toMatch(/failure details|supersecret|grant-secret|debug\\nnotes/);
    expect(stored.request).toContain('debug notes.txt');
    await expect(
      service.start(
        {
          modelId: model.id,
          conversationId: conversation.id,
          useCase: 'diagnose',
          prompt: 'reuse',
          context: '',
          attachmentIds: [attachment.id],
        },
        randomUUID(),
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'ATTACHMENT_EXPIRED' }));
    expect(AI_ATTACHMENT_TOTAL_BYTES).toBe(100 * 1024);
    await service.close();
    await owned.close();
  });

  it('rejects canceled, expired and over-total attachment drafts without starting a run', async () => {
    const owned = await ownedAiPolicy();

    const revokeGrant = vi.fn(async () => undefined);
    const host = {
      readGrantedTextPrefix: vi.fn(async () => ({
        name: 'bounded.txt',
        size: 60 * 1024,
        content: 'bounded text',
        includedBytes: 12,
        truncated: true,
      })),
      revokeGrant,
    };
    const service = owned.createService(host as never);
    const canceled = new AbortController();
    canceled.abort();
    await expect(
      service.prepareAttachment('canceled-grant', canceled.signal),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELED' });
    expect(revokeGrant).toHaveBeenCalledWith('canceled-grant');

    const first = await service.prepareAttachment('first-grant');
    const second = await service.prepareAttachment('second-grant');
    await expect(
      service.start(
        {
          modelId: randomUUID(),
          useCase: 'diagnose',
          prompt: 'too much source material',
          context: '',
          attachmentIds: [first.id, second.id],
        },
        randomUUID(),
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }));
    expect(service.list()).toHaveLength(0);

    const now = Date.now();
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
    const expiring = await service.prepareAttachment('expiring-grant');
    dateNow.mockReturnValue(now + 16 * 60_000);
    await expect(
      service.start(
        {
          modelId: randomUUID(),
          useCase: 'diagnose',
          prompt: 'expired source material',
          context: '',
          attachmentIds: [expiring.id],
        },
        randomUUID(),
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'ATTACHMENT_EXPIRED' }));
    dateNow.mockRestore();
    await service.close();
    await owned.close();
  });
});
