import { StringDecoder } from 'node:string_decoder';
import { deserializeOsc633Value } from '@workspace/shared';

/** Retain only one bounded OSC marker, never terminal output or history. */
export class TerminalDirectoryTracker {
  private readonly decoder = new StringDecoder('utf8');
  private marker = '';
  private state: 'text' | 'escape' | 'osc' | 'osc-escape' = 'text';
  private overflow = false;
  constructor(public directory: string | null) {}

  receive(bytes: Uint8Array) {
    for (const character of this.decoder.write(Buffer.from(bytes))) {
      if (this.state === 'text') {
        if (character === '\x1b') this.state = 'escape';
      } else if (this.state === 'escape') {
        this.state = character === ']' ? 'osc' : 'text';
        this.marker = '';
        this.overflow = false;
      } else if (character === '\x07' || (this.state === 'osc-escape' && character === '\\')) {
        if (!this.overflow) this.accept(this.marker);
        this.marker = '';
        this.state = 'text';
      } else if (character === '\x1b') this.state = 'osc-escape';
      else {
        if (this.state === 'osc-escape') this.overflow = true;
        this.state = 'osc';
        if (this.marker.length < 8192) this.marker += character;
        else this.overflow = true;
      }
    }
  }

  private accept(marker: string) {
    let directory: string | undefined;
    if (marker.startsWith('633;P;Cwd=')) directory = deserializeOsc633Value(marker.slice(10));
    else if (marker.startsWith('7;')) {
      try {
        const url = new URL(marker.slice(2));
        if (url.protocol === 'file:') {
          directory = decodeURIComponent(url.pathname);
          if (/^\/[A-Za-z]:[\\/]/u.test(directory)) directory = directory.slice(1);
        }
      } catch {
        /* Ignore malformed terminal metadata. */
      }
    }
    if (
      directory &&
      directory.length <= 4096 &&
      (directory.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(directory)) &&
      !Array.from(directory).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      this.directory = directory;
  }
}
