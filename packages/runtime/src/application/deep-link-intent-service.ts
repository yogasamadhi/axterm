import { randomUUID } from 'node:crypto';
import type { DeepLinkIntent, DeepLinkReceipt } from '@workspace/contracts';
import { parseQuickConnect } from '@workspace/shared';
import type { RealtimeHub } from './realtime-hub';
import { ApplicationError } from './errors';

const INTENT_TTL_MS = 2 * 60_000;
const MAX_PENDING_INTENTS = 32;

export class DeepLinkIntentService {
  private readonly pending: DeepLinkIntent[] = [];

  constructor(
    private readonly realtime: RealtimeHub,
    private readonly now = Date.now,
  ) {}

  enqueue(source: string): DeepLinkReceipt {
    this.purgeExpired();
    if (this.pending.length >= MAX_PENDING_INTENTS)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'The pending deep-link limit has been reached',
        503,
      );
    const receivedAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + INTENT_TTL_MS).toISOString();
    const parsed = parseQuickConnect(source);
    const intent: DeepLinkIntent = parsed
      ? {
          id: randomUUID(),
          status: 'ready',
          protocol: parsed.protocol,
          source,
          receivedAt,
          expiresAt,
        }
      : {
          id: randomUUID(),
          status: 'rejected',
          errorCode: 'INVALID_DEEP_LINK',
          receivedAt,
          expiresAt,
        };
    this.pending.push(intent);
    this.realtime.publish('deep-link.available', {
      id: intent.id,
      status: intent.status,
      ...(intent.protocol ? { protocol: intent.protocol } : {}),
    });
    return receipt(intent);
  }

  next(): DeepLinkIntent | null {
    this.purgeExpired();
    return this.pending.shift() ?? null;
  }

  count(): number {
    this.purgeExpired();
    return this.pending.length;
  }

  clear(): void {
    this.pending.length = 0;
  }

  private purgeExpired(): void {
    const now = this.now();
    while (this.pending[0] && Date.parse(this.pending[0].expiresAt) <= now) this.pending.shift();
  }
}

function receipt(intent: DeepLinkIntent): DeepLinkReceipt {
  return {
    id: intent.id,
    status: intent.status,
    ...(intent.protocol ? { protocol: intent.protocol } : {}),
    ...(intent.errorCode ? { errorCode: intent.errorCode } : {}),
    receivedAt: intent.receivedAt,
    expiresAt: intent.expiresAt,
  };
}
