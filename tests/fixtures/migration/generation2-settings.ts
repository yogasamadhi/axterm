import frozen from './generation2-settings.json';
/** Recorded outputs from the pinned generation 2 implementation, not a second settings service. */
export class Generation2SettingsWitness {
  private value = structuredClone(frozen.initial);
  private next = 0;
  getSettings(): typeof frozen.initial {
    return structuredClone(this.value);
  }
  updateSettings(patch: unknown, ifMatch: string): typeof frozen.initial {
    const step = frozen.steps[this.next];
    if (
      !step ||
      JSON.stringify(patch) !== JSON.stringify(step.patch) ||
      ifMatch !== `"v${this.value.version}"`
    )
      throw Error('Unrecorded historical settings comparison');
    this.value = structuredClone(step.expected);
    this.next++;
    return this.getSettings();
  }
}
