import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const styles = resolve('apps/desktop/src/renderer/src/styles');

function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const channels = color
      .slice(1)
      .match(/../gu)
      ?.map((part) => Number.parseInt(part, 16) / 255);
    if (!channels || channels.length !== 3)
      throw new Error(`Expected a #rrggbb color, got ${color}`);
    const linear = channels.map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  };
  const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

function token(source: string, name: string): string {
  const match = source.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'iu'));
  if (!match?.[1]) throw new Error(`Missing ${name} token`);
  return match[1];
}

describe('Axterm shell semantic contrast', () => {
  it('keeps normal semantic text and on-color text above WCAG AA contrast', async () => {
    const source = await readFile(resolve(styles, 'axterm.tokens.css'), 'utf8');
    const colors = {
      canvas: token(source, '--ax-color-canvas'),
      raised: token(source, '--ax-color-surface-raised'),
      text: token(source, '--ax-color-text'),
      mutedText: token(source, '--ax-color-text-muted'),
      primary: token(source, '--ax-color-primary'),
      danger: token(source, '--ax-color-danger'),
      onPrimary: token(source, '--ax-color-on-primary'),
      onDanger: token(source, '--ax-color-on-danger'),
    };

    for (const [name, foreground, background] of [
      ['text on canvas', colors.text, colors.canvas],
      ['muted text on canvas', colors.mutedText, colors.canvas],
      ['muted text on raised surface', colors.mutedText, colors.raised],
      ['on-primary text', colors.onPrimary, colors.primary],
      ['on-danger text', colors.onDanger, colors.danger],
    ] as const) {
      expect(contrastRatio(foreground, background), name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('uses semantic on-color roles instead of low-contrast white shell text', async () => {
    const source = await readFile(resolve(styles, 'axterm-shell.css'), 'utf8');
    expect(source).toContain('--shell-primary-contrast: var(--ax-color-on-primary, #06201b);');
    expect(source).toContain('--shell-danger-contrast: var(--ax-color-on-danger, #101617);');
    expect(source).not.toMatch(
      /background:\s*var\(--shell-(?:primary|danger|warning)\);\s*color:\s*#(?:fff|ffffff);/iu,
    );
  });

  it('keeps disabled buttons readable without fading their text below contrast', async () => {
    const source = await readFile(resolve(styles, 'globals.css'), 'utf8');
    const disabledStyles = source.match(
      /button:disabled,\s*button\.primary:disabled\s*\{([^}]*)\}/u,
    )?.[1];

    expect(source).toMatch(/button:disabled\s*\{\s*opacity:\s*1;/u);
    expect(disabledStyles).toContain('background: var(--panel-raised)');
    expect(disabledStyles).toContain('color: var(--text-muted)');
  });

  it('does not animate primary text and background through low-contrast intermediate colors', async () => {
    const source = await readFile(resolve(styles, 'globals.css'), 'utf8');
    const primaryRules = Array.from(source.matchAll(/button\.primary\s*\{([^}]*)\}/gu));
    const primaryStyles = primaryRules.at(-1)?.[1];
    const transition = primaryStyles?.match(/transition:\s*([^;]+);/u)?.[1];

    expect(transition).toBe('border-color 120ms ease');
  });
});
