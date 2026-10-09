import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiWorkBudget } from './ai-work-budget';

afterEach(() => vi.useRealTimers());
describe('work task budgets', () => {
  it('rejects attempt 51 without executing it', () => {
    const budget = new AiWorkBudget(new AbortController());
    try {
      for (let step = 1; step <= 50; step++) expect(budget.next()).toBe(step);
      expect(() => budget.next()).toThrow('Work command limit reached');
    } finally {
      budget.close();
    }
  });
  it('excludes human wait and owns exactly one deadline', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const controller = new AbortController();
    const budget = new AiWorkBudget(controller);
    vi.advanceTimersByTime(20 * 60_000);
    budget.pause();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60 * 60_000);
    expect(controller.signal.aborted).toBe(false);
    budget.resume();
    vi.advanceTimersByTime(10 * 60_000);
    expect(controller.signal.reason).toMatchObject({ code: 'AI_RUNTIME_LIMIT' });
    budget.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
