import type { ElectronApplication } from '@playwright/test';
/** Native custom-protocol forwarding executes fetch in Main, outside Playwright's page route.
 * Inject a response only at that transport boundary. Neither credentials nor domain models are read.
 */
export async function setDesktopRemoteFault(
  app: ElectronApplication,
  path: string,
  enabled: boolean,
  body: string,
  failure?: { code: string; reason: string },
): Promise<void> {
  if (!/^\/api\/[A-Za-z][A-Za-z0-9]*\/[A-Za-z][A-Za-z0-9]*$/u.test(path))
    throw Error('A generated Remote endpoint is required');
  await app.evaluate(
    (_, input) => {
      type Rule = {
        enabled: boolean;
        body: string;
        attempts: number;
        failure?: { code: string; reason: string };
      };
      const root = globalThis as typeof globalThis & {
        __axtermTestRemoteFault?: { fetch: typeof fetch; rules: Map<string, Rule> };
      };
      if (!root.__axtermTestRemoteFault) {
        const original = globalThis.fetch.bind(globalThis),
          rules = new Map<string, Rule>();
        root.__axtermTestRemoteFault = { fetch: original, rules };
        globalThis.fetch = async (request, init) => {
          const url = new URL(request instanceof Request ? request.url : String(request));
          const rule =
            url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
              ? rules.get(url.pathname)
              : undefined;
          if (rule) {
            rule.attempts++;
            if (rule.enabled && rule.failure) {
              const incoming = new Request(request, init);
              const { rpcId } = (await incoming.json()) as { rpcId: string };
              return Response.json({
                type: 'server-response',
                rpcId,
                result: {
                  ok: false,
                  error: {
                    code: rule.failure.code,
                    message: rule.body,
                    details: { reason: rule.failure.reason },
                  },
                },
              });
            }
            if (rule.enabled)
              return new Response(rule.body, {
                status: 500,
                headers: { 'content-type': 'application/json' },
              });
          }
          return original(request, init);
        };
      }
      if (
        root.__axtermTestRemoteFault.rules.size >= 32 &&
        !root.__axtermTestRemoteFault.rules.has(input.path)
      )
        throw Error('Test Remote fault capacity');
      const previous = root.__axtermTestRemoteFault.rules.get(input.path);
      root.__axtermTestRemoteFault.rules.set(input.path, {
        enabled: input.enabled,
        body: input.body,
        attempts: previous?.attempts ?? 0,
        ...(input.failure ? { failure: input.failure } : {}),
      });
    },
    { path, enabled, body, failure },
  );
}
export async function desktopRemoteFaultAttempts(
  app: ElectronApplication,
  path: string,
): Promise<number> {
  return app.evaluate(
    (_, path) =>
      (
        globalThis as typeof globalThis & {
          __axtermTestRemoteFault?: { rules: Map<string, { attempts: number }> };
        }
      ).__axtermTestRemoteFault?.rules.get(path)?.attempts ?? 0,
    path,
  );
}
