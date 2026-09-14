import { describe, expect, it } from 'vitest';
import { ApplicationError, isApplicationError } from './errors';

describe('isApplicationError', () => {
  it('retains typed failures created by another bundled module instance', () => {
    const foreign = Object.assign(new Error('Granted SSH config cannot be read'), {
      code: 'INVALID_STATE',
      status: 409,
    });
    expect(isApplicationError(foreign)).toBe(true);
    expect(isApplicationError(new ApplicationError('NOT_FOUND', 'Missing', 404))).toBe(true);
  });

  it('does not trust arbitrary system or vendor errors', () => {
    expect(isApplicationError(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBe(false);
    expect(
      isApplicationError(
        Object.assign(new Error('bad status'), { code: 'INVALID_STATE', status: 500 }),
      ),
    ).toBe(false);
    expect(
      isApplicationError({ code: 'INVALID_STATE', status: 409, message: 'plain object' }),
    ).toBe(false);
  });
});
