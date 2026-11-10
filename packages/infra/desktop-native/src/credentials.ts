import type { Context } from '@deepseek-ai/cordis';
import type { NativeClient } from './bridge.ts';
import { DesktopVaultCredentials } from './vault.ts';
declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopNative: NativeClient;
  }
}
/** Selects the shell-owned Vault through the same credentials service contract. */
export default class DesktopCredentials extends DesktopVaultCredentials {
  static readonly inject = ['desktopNative'];
  constructor(ctx: Context) {
    super(ctx, ctx.desktopNative);
  }
}
