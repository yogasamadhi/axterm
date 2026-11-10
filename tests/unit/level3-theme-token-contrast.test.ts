import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { expect, it } from 'vitest';
function palette(mode: 'dark' | 'light') {
  const css = postcss.parse(
    readFileSync('packages/infra/ui-theme/src/client/tokens.module.css', 'utf8'),
  );
  const values = new Map<string, string>();
  css.walkRules((rule) => {
    if (rule.selector === ':global(:root)')
      rule.walkDecls((decl) => {
        values.set(decl.prop, decl.value);
      });
  });
  if (mode === 'light')
    css.walkRules((rule) => {
      if (rule.selector.includes("data-ax-theme='light'"))
        rule.walkDecls((decl) => {
          values.set(decl.prop, decl.value);
        });
    });
  return values;
}
function luminance(color: string) {
  const short = color.slice(1);
  const hex = short.length === 3 ? [...short].map((part) => part + part).join('') : short;
  if (!/^[0-9a-f]{6}$/iu.test(hex)) throw Error('Expected an opaque built-in palette color');
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
it.each(['dark', 'light'] as const)(
  'keeps shared %s text and action pairs readable for ordinary-size controls',
  (mode) => {
    const values = palette(mode);
    for (const [foreground, background] of [
      ['text', 'canvas'],
      ['text-muted', 'canvas'],
      ['text', 'surface-raised'],
      ['on-primary', 'primary'],
      ['on-danger', 'danger'],
      ['success', 'canvas'],
      ['warning', 'canvas'],
      ['info', 'canvas'],
    ]) {
      const a = luminance(values.get('--ax-color-' + foreground)!),
        b = luminance(values.get('--ax-color-' + background)!);
      expect(
        (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        `${mode} ${foreground}/${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  },
);
