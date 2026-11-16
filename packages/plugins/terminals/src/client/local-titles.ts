/** Presentation numbering is stable for each local session; closing a tab never renumbers its peers. */
export class LocalTerminalTitles {
  private readonly numbers = new Map<string, number>();
  private next = 0;
  constructor(
    private readonly format: (number: number) => string,
    private readonly defaults: readonly string[],
    private readonly templates: readonly string[],
  ) {}
  title(id: string, proposed: string): string {
    const suffix = /([1-9]\d*)$/u.exec(proposed);
    const restored = suffix ? Number(suffix[1]) : undefined;
    if (
      restored !== undefined &&
      Number.isSafeInteger(restored) &&
      restored <= 9999 &&
      this.templates.some(
        (template) =>
          template.replace('{number}', String(restored)).replace(/\s/gu, '') ===
          proposed.replace(/\s/gu, ''),
      )
    ) {
      this.numbers.set(id, restored);
      this.next = Math.max(this.next, restored);
      return this.format(restored);
    }
    if (!this.defaults.includes(proposed)) return proposed;
    let number = this.numbers.get(id);
    if (number === undefined) {
      number = ++this.next;
      this.numbers.set(id, number);
    }
    return this.format(number);
  }
  remove(id: string) {
    this.numbers.delete(id);
  }
  reset() {
    this.numbers.clear();
    this.next = 0;
  }
}
