import { expect, it } from 'vitest';
import { aiFailureMessage } from '../src/client/ui/failure-message.ts';
import { dictionaries } from '../src/client/ui/locales.ts';
it('renders selected Engine failures in all four locales without exposing arbitrary causes', () => {
  for (const dictionary of Object.values(dictionaries)) {
    const t = (key: keyof typeof dictionaries.en) => dictionary[key];
    expect(aiFailureMessage('AI_ENGINE_DRAIN_FAILED', t)).toBe(dictionary['ai.engineDrainFailed']);
    expect(aiFailureMessage({ code: 'ai/failure', details: { reason: 'unsupported' } }, t)).toBe(
      dictionary['ai.engineUnsupported'],
    );
    expect(aiFailureMessage({ code: 'PRIVATE_CAUSE', message: 'PRIVATE_CANARY' }, t)).toBe(
      dictionary['common.operationFailed'],
    );
    expect(aiFailureMessage(new Error('PRIVATE_CANARY'), t)).toBe(
      dictionary['common.operationFailed'],
    );
  }
});
