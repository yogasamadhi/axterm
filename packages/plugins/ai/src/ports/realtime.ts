/** Ephemeral observations; durable application facts/log/outbox commit separately. */
export interface AiRealtimePort {
  publish(type: string, payload: unknown): void;
}
