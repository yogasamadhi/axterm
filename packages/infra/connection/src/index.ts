// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/client/connection/src/index.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/** Host HTTP bridge for browser-client RPC. */
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import z from '@deepseek-ai/schemastery';
// Activates the webServer Context merge used below.
import type { WebRoute } from '@axterm/infra-web-server';
import { API_PATH } from './api-path.ts';
import { CONNECT_PATH } from './connect-protocol.ts';
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from './http-bridge.ts';
import { assertTrustedAuthority } from './api-request-trust.ts';
import { BrowserAuth } from './browser-auth.ts';
import type {} from '@axterm/plugin-api/host';
import { DesktopAuthentication } from './desktop-auth.ts';
export {
  DesktopAuthentication,
  createDesktopAuthentication,
  DESKTOP_AUTH_HEADER,
} from './desktop-auth.ts';
export type { DesktopAuthenticationVerifier } from './desktop-auth.ts';
import { HostConnectionService } from './rpc-host.ts';
import {
  ConnectionRecoveryConfigSchema,
  resolveConnectionConfig,
  type ConnectionRecoveryConfig,
} from './recovery-config.ts';

export type {
  PeerAdmission,
  ConnectionAdmission,
  ConnectionFetchMethod,
  ConnectionFetchHandler,
  ConnectionFetchRoute,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcAttachment,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRpcHandlerResult,
  ConnectionRequestRejection,
  ConnectionRpcResult,
  ConnectionRequestBodyMode,
  ConnectionTrustRequest,
  ClientRequest,
  HostConnectionHandle,
  HostConnectionFetch,
  HostConnectionRpc,
  RpcMessage,
  ServerResponse,
} from './rpc.ts';
export type { PeerId, PeerScope, Principal, RemoteInvocation } from '@axterm/plugin-api';
export { RpcId, transportError } from './rpc.ts';
export { Peer } from './peer.ts';
export type { PeerOptions } from './peer.ts';
export { CONNECT_PATH, type ConnectionInteractions } from './connect-protocol.ts';
export {
  clientRequestSchema,
  rpcErrorSchema,
  rpcIdSchema,
  rpcMessageSchema,
  rpcResultSchema,
  serverResponseSchema,
} from './rpc-schema.ts';
export { HostConnectionService } from './rpc-host.ts';

export { API_PATH } from './api-path.ts';

/** Stable Cordis plugin name. */
export const name = 'client-connection';

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Admit or wrap an authenticated shared API request, including body transfer.
     * Existing requests continue when a listener refuses subsequent requests.
     * @param request - Authenticated incoming HTTP request.
     * @param response - Response owned until the delegated bridge settles.
     * @param next - Delegate to the next listener or the shared API bridge.
     * @mode waterfall
     */
    'connection/request'(
      request: IncomingMessage,
      response: ServerResponse,
      next: () => Promise<void>,
    ): Promise<void>;
  }
}

/** Services required before providing Connection. */
export const inject = ['credentials'];

/** Browser authentication, request limits, and connection recovery configuration. */
export interface ConnectionConfig {
  /** Browser recovery timing, injected into each served page. */
  recovery?: ConnectionRecoveryConfig;
  maxApiPeers?: number;
  maxPendingConnects?: number;
  connectBodyTimeoutMs?: number;
  apiPeerIdleMs?: number;
  /**
   * Authorities this deployment serves beyond loopback: exact `host:port`, or
   * port-less `host` matching any port. The fence accepts loopback and the
   * listener's own bind IP independently; other remote authorities require
   * an entry here. A non-canonical or non-bare authority fails plugin load.
   */
  trustedHosts?: string[];
  /** Absolute browser and API session validity in days (cookies are session-only). Default: 30. */
  cookieMaxAgeDays?: number;
  /** Maximum buffered JSON body for every `/api` request. Default: 32 MiB. */
  maxRequestBodyBytes?: number;
}

export const Config: z<ConnectionConfig> = z.object({
  recovery: ConnectionRecoveryConfigSchema.default({}),
  maxPendingConnects: z.natural().min(1).max(4096).default(32),
  connectBodyTimeoutMs: z.natural().min(1).max(2147483647).default(10000),
  maxApiPeers: z.natural().min(1).max(4096).default(128),
  apiPeerIdleMs: z.natural().min(1).max(2147483647).default(60000),
  trustedHosts: z.array(String).default([]),
  cookieMaxAgeDays: z.natural().min(1).default(30),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
});

/** Resolve admission bounds before creating any peer resources. */
export function resolvePeerLimits(config?: ConnectionConfig): {
  maxApiPeers: number;
  apiPeerIdleMs: number;
  maxPendingConnects: number;
  connectBodyTimeoutMs: number;
} {
  const validated = Config(config ?? {});
  return {
    maxApiPeers: validated.maxApiPeers!,
    apiPeerIdleMs: validated.apiPeerIdleMs!,
    maxPendingConnects: validated.maxPendingConnects!,
    connectBodyTimeoutMs: validated.connectBodyTimeoutMs!,
  };
}

/**
 * Provides carrier-neutral RPC and Fetch registries. When `webServer` is
 * present, the plugin also mounts the `/api` browser transport with Host/Origin
 * checks and persistent browser authentication.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export async function apply(ctx: Context, config?: ConnectionConfig): Promise<void> {
  const recovery = resolveConnectionConfig(config?.recovery);
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const trustedHosts = config?.trustedHosts ?? [];
  const cookieMaxAgeDays = config?.cookieMaxAgeDays ?? 30;
  const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  // Config boundary: a malformed entry fails the load loudly here rather than
  // silently authorizing its hostname prefix at request time.
  for (const entry of trustedHosts) assertTrustedAuthority(entry);
  const identity = ctx.get('runtimeIdentity');
  const desktopVerifier = ctx.get('desktopAuthenticationVerifier');
  if (identity?.mode !== 'desktop' && desktopVerifier !== undefined)
    throw new Error('DESKTOP_AUTH_WRONG_PROFILE');
  if (identity?.mode === 'desktop' && desktopVerifier === undefined)
    throw new Error('DESKTOP_AUTH_VERIFIER_REQUIRED');
  const authentication =
    identity?.mode === 'desktop'
      ? new DesktopAuthentication(desktopVerifier!, identity.generation)
      : await BrowserAuth.create(ctx.root, ctx.credentials, cookieMaxAgeDays);
  const connection = new HostConnectionService(
    ctx,
    trustedHosts,
    authentication,
    resolvePeerLimits(config),
  );
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__AXTERM_CONNECTION_RECOVERY__', value: recovery });
    });
    const fetchHandler = connection.createSharedFetchHandler(API_PATH);
    const route: WebRoute = {
      kind: 'prefix',
      path: API_PATH,
      handler: async (req, res) => {
        const admission = connection.admit(req);
        if ('rejection' in admission) {
          res.writeHead(admission.rejection, { connection: 'close', 'cache-control': 'no-store' });
          res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden');
          return;
        }
        await webCtx.waterfall('connection/request', req, res, () =>
          bridge(req, res, fetchHandler, admission.peer, maxRequestBodyBytes),
        );
      },
    };
    webCtx.effect(() => webCtx.webServer.register(route), 'client-connection: /api route');
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: CONNECT_PATH,
          handler: (req, res) => connection.authorizeConnect(req, res),
        }),
      'client-connection: /connect route',
    );
  });
}
