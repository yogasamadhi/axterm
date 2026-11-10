import type { Connection, Interaction } from '@axterm/plugin-api/connections';
export interface ConnectionEvents {
  publish(type: 'connection.status', payload: Connection): void;
  publish(
    type: 'connection.history-failed',
    payload: { connectionId: string; errorCode: string },
  ): void;
  publish(type: 'interaction.required', payload: Interaction): void;
  publish(type: 'interaction.expired', payload: { id: string }): void;
  publish(type: 'interaction.resolved', payload: { id: string; accepted: boolean }): void;
}
