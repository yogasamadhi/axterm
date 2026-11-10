// @vitest-environment jsdom
// Exercise the actual built Client artifacts, including their explicitly bundled CSS.
import { Context } from '@deepseek-ai/cordis';
import { expect, it } from 'vitest';
import * as Renderer from '../../packages/infra/ui-renderer/lib/client.js';
import * as Locale from '../../packages/infra/locale/lib/client.js';
import * as Theme from '../../packages/infra/ui-theme/lib/client.js';
import type { PresentationPreferencePort } from '@axterm/ui/presentation';
function accepted(value: string): PresentationPreferencePort<string> {
  return {
    getSnapshot: () => ({ available: true, value }),
    subscribe: () => () => {},
    write: async () => {},
  };
}
it('restores owned document metadata, inline tokens and styles after presentation Client unload and reload', async () => {
  const html = document.documentElement;
  const original = {
    lang: html.getAttribute('lang'),
    dir: html.getAttribute('dir'),
    language: html.getAttribute('data-language'),
    theme: html.getAttribute('data-ax-theme'),
    style: html.getAttribute('style'),
  };
  html.lang = 'en';
  html.dir = 'ltr';
  html.dataset.language = 'original';
  html.dataset.axTheme = 'before';
  html.style.colorScheme = 'normal';
  html.style.setProperty('--ax-color-primary', 'pink');
  const ctx = new Context();
  try {
    await ctx.plugin(Renderer);
    const localeOwner = ctx.plugin(Locale);
    const themeOwner = ctx.plugin(Theme);
    await localeOwner;
    await themeOwner;
    const localeStop = ctx.locale.attachPreference(accepted('ja'));
    const themeStop = ctx.theme.attachPreference(accepted('light'));
    const remove = ctx.theme.overrideTokens('fixture', {
      '--ax-color-primary': { light: '#123456', dark: '#654321' },
    });
    expect(html.lang).toBe('ja');
    expect(html.dataset.language).toBe('ja');
    expect(html.dataset.axTheme).toBe('light');
    expect(html.style.getPropertyValue('--ax-color-primary')).toBe('#123456');
    const selector = 'style[data-plugin="@axterm/infra-ui-theme"]';
    expect(document.head.querySelectorAll(selector)).toHaveLength(1);
    expect(document.head.querySelector(selector)?.textContent).toContain(
      '--ax-size-tab-height: 38px',
    );
    await localeStop();
    await themeStop();
    await localeOwner.dispose();
    await themeOwner.dispose();
    remove();
    expect(document.head.querySelectorAll(selector)).toHaveLength(0);
    expect(html.lang).toBe('en');
    expect(html.dataset.language).toBe('original');
    expect(html.dataset.axTheme).toBe('before');
    expect(html.style.colorScheme).toBe('normal');
    expect(html.style.getPropertyValue('--ax-color-primary')).toBe('pink');
    const again = ctx.plugin(Theme);
    await again;
    expect(document.head.querySelectorAll(selector)).toHaveLength(1);
    await again.dispose();
    expect(document.head.querySelectorAll(selector)).toHaveLength(0);
  } finally {
    await ctx.fiber.dispose();
    for (const [name, value] of Object.entries({
      lang: original.lang,
      dir: original.dir,
      'data-language': original.language,
      'data-ax-theme': original.theme,
      style: original.style,
    })) {
      if (value === null) html.removeAttribute(name);
      else html.setAttribute(name, value);
    }
  }
});
