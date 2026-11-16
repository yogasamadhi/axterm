import type { WorkspaceUi } from '@axterm/ui/workspace';

/** Transient UI identity only. Terminal paths and execution authority remain with the Host. */
export class AiTerminalSelection {
  private readonly listeners = new Set<() => void>();
  private lastTerminal: string | undefined;
  private selected: string | undefined;
  private snapshot: { choice: string; terminalId: string | undefined } = {
    choice: '',
    terminalId: undefined,
  };
  private readonly off: () => void;
  constructor(private readonly workspace: Pick<WorkspaceUi, 'getSnapshot' | 'subscribe'>) {
    this.off = workspace.subscribe(this.refresh);
    this.refresh();
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  select = (id: string) => {
    if (
      id &&
      !this.workspace.getSnapshot().tabs.some((tab) => tab.kind === 'terminal' && tab.id === id)
    )
      return;
    this.selected = id || undefined;
    this.refresh();
  };
  refresh = () => {
    const layout = this.workspace.getSnapshot();
    const terminals = layout.tabs.filter((tab) => tab.kind === 'terminal');
    const active = terminals.find((tab) => tab.id === layout.activeTabId);
    if (active) this.lastTerminal = active.id;
    if (!terminals.some((tab) => tab.id === this.lastTerminal)) this.lastTerminal = undefined;
    if (this.selected && !terminals.some((tab) => tab.id === this.selected))
      this.selected = undefined;
    const terminalId = this.selected ?? this.lastTerminal;
    const choice = this.selected ?? '';
    if (choice === this.snapshot.choice && terminalId === this.snapshot.terminalId) return;
    this.snapshot = { choice, terminalId };
    for (const listener of this.listeners) listener();
  };
  dispose() {
    this.off();
    this.listeners.clear();
  }
}
