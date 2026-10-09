const MAX_DIRECTORIES = 32;
const MAX_PATH_LENGTH = 4_096;

/** Local OS drag metadata only; never a filesystem or business RPC interface. */
export class DroppedDirectories {
  private paths: string[] = [];
  private expiresAt = 0;

  constructor(private readonly pathForFile: (file: File) => string) {}

  capture(event: DragEvent): void {
    this.clear();
    const transfer = event.dataTransfer;
    if (!event.isTrusted || !transfer) return;
    const items = Array.from(transfer.items).filter((item) => item.kind === 'file');
    if (!items.length || items.length > MAX_DIRECTORIES) return;
    const paths: string[] = [];
    try {
      for (const item of items) {
        if (!item.webkitGetAsEntry()?.isDirectory) return;
        const file = item.getAsFile();
        if (!file) return;
        const path = this.pathForFile(file);
        if (
          !path ||
          path.length > MAX_PATH_LENGTH ||
          Array.from(path).some((character) => {
            const code = character.codePointAt(0)!;
            return code < 32 || code === 127;
          })
        )
          return;
        paths.push(path);
      }
    } catch {
      return;
    }
    this.paths = paths;
    this.expiresAt = Date.now() + 1_000;
  }

  takePaths(): string[] {
    const paths = Date.now() <= this.expiresAt ? this.paths : [];
    this.clear();
    return paths;
  }

  clear(): void {
    this.paths = [];
    this.expiresAt = 0;
  }
}
