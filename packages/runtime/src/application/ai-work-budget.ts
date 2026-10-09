import { ApplicationError } from './errors';

/** One owned deadline, paused only while waiting for a human. */
export class AiWorkBudget {
  private remaining = 30 * 60_000;
  private resumedAt = performance.now();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private paused = false;
  steps = 0;
  constructor(private readonly controller: AbortController) {
    this.arm();
  }
  private arm() {
    this.resumedAt = performance.now();
    this.timer = setTimeout(
      () =>
        this.controller.abort(
          new ApplicationError('AI_RUNTIME_LIMIT', 'Work execution time limit reached', 409),
        ),
      this.remaining,
    );
    this.timer.unref();
  }
  pause() {
    if (this.paused) return;
    this.remaining -= performance.now() - this.resumedAt;
    clearTimeout(this.timer);
    this.paused = true;
  }
  resume() {
    if (this.paused) {
      this.paused = false;
      this.arm();
    }
  }
  next() {
    this.controller.signal.throwIfAborted();
    if (++this.steps > 50)
      throw new ApplicationError('AI_STEP_LIMIT', 'Work command limit reached', 409);
    return this.steps;
  }
  close() {
    clearTimeout(this.timer);
  }
}
