export interface RealtimeEvent {
  type: string;
  data: unknown;
  at: string;
}

export class RealtimeHub {
  private readonly listeners = new Set<(event: RealtimeEvent) => void>();

  publish(type: string, data: unknown): void {
    const event = { type, data, at: new Date().toISOString() };
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: (event: RealtimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  count(): number {
    return this.listeners.size;
  }

  close(): void {
    this.listeners.clear();
  }
}
