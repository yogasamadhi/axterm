import { access, readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererSource = resolve('apps/desktop/src/renderer/src');
const styles = resolve('apps/desktop/src/renderer/src/styles');
const shellControls = resolve('apps/desktop/src/renderer/src/app/shell-controls.tsx');
const connectionProfileStyles = resolve(
  'apps/desktop/src/renderer/src/app/connection-profiles/connection-profiles.css',
);
const hostBookmarkStyles = resolve(
  'apps/desktop/src/renderer/src/app/bookmarks/ssh-bookmark-form.css',
);
const panels = resolve('apps/desktop/src/renderer/src/app/panels.tsx');
const globalStyles = resolve('apps/desktop/src/renderer/src/styles/globals.css');
const appIcon = resolve('apps/desktop/build/icon.svg');
const currentFiles = ['axterm.tokens.css', 'axterm-shell.css'];
const retiredFiles = ['legacy-prototype-parity.tokens.css', 'legacy-prototype-shell.css'];

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(?:css|tsx?)$/u.test(entry.name) ? [path] : [];
    }),
  );
  return files.flat().sort();
}

function rgbHueSaturationLightness(red: number, green: number, blue: number) {
  const channels = [red, green, blue].map((channel) => channel / 255);
  const maximum = Math.max(...channels);
  const minimum = Math.min(...channels);
  const delta = maximum - minimum;
  const lightness = (maximum + minimum) / 2;
  let hue = 0;
  if (delta > 0) {
    if (maximum === channels[0]) hue = 60 * (((channels[1]! - channels[2]!) / delta) % 6);
    else if (maximum === channels[1]) hue = 60 * ((channels[2]! - channels[0]!) / delta + 2);
    else hue = 60 * ((channels[0]! - channels[1]!) / delta + 4);
    if (hue < 0) hue += 360;
  }
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  return { hue, lightness, saturation };
}

function expandedHex(value: string) {
  const opaque =
    value.length === 3
      ? [...value].map((character) => character.repeat(2)).join('')
      : value.slice(0, 6);
  return [0, 2, 4].map((index) => Number.parseInt(opaque.slice(index, index + 2), 16));
}

function lineNumberAt(source: string, offset: number) {
  return source.slice(0, offset).split('\n').length;
}

function saturatedBlueLiteral({
  hue,
  lightness,
  saturation,
}: ReturnType<typeof rgbHueSaturationLightness>) {
  return hue >= 185 && hue <= 250 && saturation >= 0.45 && lightness >= 0.1 && lightness <= 0.82;
}

function blueProductColorFindings(path: string, source: string) {
  const findings: string[] = [];
  const record = (offset: number, token: string) => {
    findings.push(`${relative(rendererSource, path)}:${lineNumberAt(source, offset)} ${token}`);
  };

  for (const match of source.matchAll(/#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})(?![\da-f])/giu)) {
    const channels = expandedHex(match[1]!);
    if (saturatedBlueLiteral(rgbHueSaturationLightness(channels[0]!, channels[1]!, channels[2]!))) {
      record(match.index, match[0]);
    }
  }
  for (const match of source.matchAll(
    /rgba?\(\s*(\d{1,3})(?:\s+|,\s*)(\d{1,3})(?:\s+|,\s*)(\d{1,3})/giu,
  )) {
    const channels = match.slice(1, 4).map(Number);
    if (
      channels.every((channel) => channel >= 0 && channel <= 255) &&
      saturatedBlueLiteral(rgbHueSaturationLightness(channels[0]!, channels[1]!, channels[2]!))
    ) {
      record(match.index, match[0]);
    }
  }
  for (const match of source.matchAll(
    /hsla?\(\s*(-?\d+(?:\.\d+)?)(?:deg)?(?:\s+|,\s*)(\d+(?:\.\d+)?)%(?:\s+|,\s*)(\d+(?:\.\d+)?)%/giu,
  )) {
    const hue = ((Number(match[1]) % 360) + 360) % 360;
    const saturation = Number(match[2]) / 100;
    const lightness = Number(match[3]) / 100;
    if (saturatedBlueLiteral({ hue, saturation, lightness })) record(match.index, match[0]);
  }
  for (const match of source.matchAll(
    /\b(?:bg|text|border|ring|outline|decoration|from|via|to)-(?:blue|sky|cyan|indigo)(?:-\d{2,3})?\b/giu,
  )) {
    record(match.index, match[0]);
  }
  return findings;
}

describe('Axterm product-shell style provenance', () => {
  it('uses only Axterm-named shell entry points without historical-reference copy', async () => {
    for (const file of currentFiles) {
      const source = await readFile(resolve(styles, file), 'utf8');
      expect(source).not.toMatch(/\b(?:legacy-prototype|parity|upstream)\b/iu);
    }
    await Promise.all(
      retiredFiles.map((file) => expect(access(resolve(styles, file))).rejects.toThrow()),
    );
  });

  it('uses the mint product accent and excludes the retired blue product marks', async () => {
    const shell = await readFile(resolve(styles, 'axterm-shell.css'), 'utf8');
    const controls = await readFile(shellControls, 'utf8');
    const connectionProfiles = await readFile(connectionProfileStyles, 'utf8');
    const hostBookmarks = await readFile(hostBookmarkStyles, 'utf8');
    const panelSource = await readFile(panels, 'utf8');
    const globals = await readFile(globalStyles, 'utf8');
    const icon = await readFile(appIcon, 'utf8');

    expect(shell).toContain('--shell-accent: var(--shell-primary);');
    expect(shell).toMatch(
      /\.tab-number\s*\{[\s\S]*background:\s*var\(--shell-primary\);[\s\S]*color:\s*var\(--shell-primary-contrast\);/u,
    );
    expect(shell).toMatch(
      /\.settings-category-sidebar > button:hover,\s*\.settings-category-sidebar > button\.active\s*\{[\s\S]*background:\s*var\(--shell-primary\);[\s\S]*color:\s*var\(--shell-primary-contrast\);/u,
    );
    expect(shell).toMatch(
      /\.session-recovery-banner\.runtime-restarted\s*\{[\s\S]*border-color:\s*var\(--shell-primary\);[\s\S]*background:\s*color-mix\(in srgb, var\(--shell-primary\) 14%, var\(--shell-canvas\)\);/u,
    );
    expect(shell).not.toMatch(/(?:empty-pane-(?:brand|shape)|#0088cc|#0099cc|#0099d4|#079ed5)/iu);
    expect(shell).toMatch(
      /\.empty-pane-glyph\s*\{[\s\S]*border:[^;]*var\(--shell-primary\)[\s\S]*color:\s*var\(--shell-primary\);/u,
    );
    expect(shell).toMatch(
      /\.empty-pane-actions \.empty-pane-new-terminal\s*\{[\s\S]*background:\s*var\(--shell-primary\);[\s\S]*color:\s*var\(--shell-primary-contrast\);/u,
    );
    expect(shell).not.toMatch(/\.empty-pane-sort\b/u);
    expect(shell).not.toMatch(/#36566b|#182832/iu);
    expect(controls).not.toMatch(/empty-pane-(?:brand|shape)/iu);
    expect(controls).toMatch(/className="empty-pane-glyph"[\s\S]*<Terminal/u);
    expect(controls).not.toMatch(/className="empty-pane-sort"/u);
    expect(connectionProfiles).toMatch(
      /\.connection-profile-basics input:focus\s*\{[\s\S]*border-color:\s*var\(--shell-primary\);[\s\S]*box-shadow:\s*0 0 0 2px color-mix\(in srgb, var\(--shell-primary\) 24%, transparent\);/u,
    );
    expect(connectionProfiles).not.toMatch(/#266aa2|#122a39/iu);
    expect(hostBookmarks).not.toMatch(
      /host-bookmark-shell-(?:tabs|sidebar|toolbar|search|tree)|host-bookmark-protocol-heading|host-field-run-script/iu,
    );
    expect(hostBookmarks).toMatch(
      /\.modal\.host-bookmark-modal\s*\{[\s\S]*width:\s*min\(920px,[\s\S]*border-radius:\s*12px;[\s\S]*background:\s*var\(--panel\);/u,
    );
    expect(hostBookmarks).toMatch(
      /\.modal\.protocol-bookmark-modal\s*\{[\s\S]*width:\s*min\(820px,[\s\S]*border-color:\s*color-mix\(in srgb, var\(--shell-primary\)/u,
    );
    expect(hostBookmarks).toMatch(
      /\.protocol-bookmark-form > \.modal-actions\s*\{[\s\S]*position:\s*sticky;[\s\S]*border-top:\s*1px solid var\(--border\);/u,
    );
    expect(hostBookmarks).not.toMatch(
      /\.modal-backdrop:has\(\.protocol-bookmark-modal\)\s*\{[^}]*background:\s*transparent;/u,
    );
    expect([
      ...panelSource.matchAll(/data-protocol="(?:ftp|telnet|serial|rdp|vnc|spice|web)"/gu),
    ]).toHaveLength(7);
    expect([
      ...panelSource.matchAll(/className="form-grid protocol-bookmark-form"/gu),
    ]).toHaveLength(7);
    expect([...panelSource.matchAll(/<input\s+data-autofocus/gu)]).toHaveLength(7);
    expect(globals).toMatch(
      /input\[type='checkbox'\],\s*input\[type='radio'\]\s*\{\s*accent-color:\s*var\(--shell-primary\);\s*\}/u,
    );
    expect(icon).toContain('stop-color="#56d8aa"');
    expect(icon).not.toContain('#55cfe0');
  });

  it('keeps saturated blue out of product CSS and renderer utility classes', async () => {
    const findings = (
      await Promise.all(
        (await sourceFiles(rendererSource)).map(async (path) => {
          const source = await readFile(path, 'utf8');
          return path.endsWith('.css')
            ? blueProductColorFindings(path, source)
            : [
                ...source.matchAll(
                  /\b(?:bg|text|border|ring|outline|decoration|from|via|to)-(?:blue|sky|cyan|indigo)(?:-\d{2,3})?\b/giu,
                ),
              ].map(
                (match) =>
                  `${relative(rendererSource, path)}:${lineNumberAt(source, match.index)} ${match[0]}`,
              );
        }),
      )
    ).flat();

    expect(findings, 'Use the Axterm mint semantic tokens for product chrome').toEqual([]);
  });
});
