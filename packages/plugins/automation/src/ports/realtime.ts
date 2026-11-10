export interface AutomationRealtime {
  publish(
    type: 'trigger.fired',
    payload: { terminalId: string; triggerId: string; name: string; actionType: 'send' | 'notify' },
  ): void;
  publish(
    type: 'trigger.session-disabled',
    payload: { terminalId: string; errorCode: string },
  ): void;
}
