import type { RuntimeBaseline } from '@axterm/plugin-api';
/** No OS history or execution intent is retained across a Host generation. */
export class DesktopResumePolicy {
  private generation: string | undefined;
  private revision: number | undefined;
  accept(baseline: RuntimeBaseline): boolean {
    const state = baseline.lifecycle;
    if (this.generation !== baseline.metadata.generation) {
      this.generation = baseline.metadata.generation;
      this.revision = state?.revision;
      return false;
    }
    if (!state) return false;
    const previous = this.revision;
    if (previous !== undefined && state.revision <= previous) return false;
    this.revision = state.revision;
    return previous !== undefined && state.lastEvent === 'resume';
  }
}
