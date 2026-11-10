import type { Context } from '@deepseek-ai/cordis';
import type {} from '@axterm/infra-web-server';
import type {} from '@axterm/infra-connection';
import type {} from '@axterm/infra-app-boot';
import type {} from '@axterm/plugin-api/host';
export interface WebStartup {
  readonly url: string;
  readonly tokenFile?: string;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    webStartup: WebStartup;
  }
}
export const inject = ['webServer', 'connection', 'runtimeIdentity', 'profileContext'];
/** The Web launch credential is delivered only as an activation-owned protected file. */
export async function apply(ctx: Context): Promise<void> {
  const port = ctx.webServer.port;
  if (port === undefined) throw new Error('WEB_LISTENER_UNAVAILABLE');
  const host = ctx.webServer.host.includes(':') ? `[${ctx.webServer.host}]` : ctx.webServer.host;
  const url = `${ctx.webServer.protocol}//${host}:${port}/`;
  const tokenFile =
    ctx.runtimeIdentity.mode === 'web'
      ? await ctx.connection.createLaunchTokenFile(`${ctx.profileContext.dir}/launch`)
      : undefined;
  ctx.provide(
    'webStartup',
    Object.freeze({ url, ...(tokenFile === undefined ? {} : { tokenFile }) }),
  );
}
