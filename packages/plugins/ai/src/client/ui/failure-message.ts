import type { AiTranslator, AxtermMessageKey } from './i18n.tsx';
const messages: Readonly<Record<string, AxtermMessageKey>> = {
  AI_ENGINE_MISSING: 'ai.engineMissing',
  AI_ENGINE_UNSUPPORTED: 'ai.engineUnsupported',
  AI_ENGINE_UNAVAILABLE: 'ai.engineUnavailable',
  AI_ENGINE_CAPACITY: 'ai.engineCapacity',
  AI_ENGINE_CANCELLED: 'ai.engineCancelled',
  AI_ENGINE_INVALID: 'ai.engineInvalid',
  AI_ENGINE_DRAIN_FAILED: 'ai.engineDrainFailed',
  AI_ENGINE_OUTPUT_FAILED: 'ai.engineOutputFailed',
};
/** Only application-owned codes and selected Remote reasons may become UI text. */
export function aiFailureMessage(cause: unknown, x: AiTranslator): string {
  if (typeof cause === 'string') return x(messages[cause] ?? 'common.operationFailed');
  if (cause && typeof cause === 'object' && 'code' in cause) {
    if (cause.code === 'ai/failure' && 'details' in cause) {
      const details = cause.details;
      if (
        details &&
        typeof details === 'object' &&
        'reason' in details &&
        details.reason === 'unsupported'
      )
        return x('ai.engineUnsupported');
    }
    if (typeof cause.code === 'string' && messages[cause.code]) return x(messages[cause.code]!);
  }
  return x('common.operationFailed');
}
