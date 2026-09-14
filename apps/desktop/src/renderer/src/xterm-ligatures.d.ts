declare module '@xterm/addon-ligatures/lib/addon-ligatures.mjs' {
  import type { ITerminalAddon, Terminal } from '@xterm/xterm';

  export class LigaturesAddon implements ITerminalAddon {
    constructor(options?: { fallbackLigatures?: string[]; fontFeatureSettings?: string });
    activate(terminal: Terminal): void;
    dispose(): void;
  }
}
