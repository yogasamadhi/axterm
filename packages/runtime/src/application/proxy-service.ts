import type { Duplex } from 'node:stream';
import {
  proxyTestRequestSchema,
  type GlobalProxyConfig,
  type Host,
  type HostProxyConfig,
  type ProxyEndpointConfig,
  type ProxyTestRequest,
  type ProxyTestResult,
} from '@workspace/contracts';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import type { ProductRepository } from '../adapters/sqlite/product-repository';
import type { ProxyConnector } from '../ports/proxy-connector';
import type { ProxyCommandRunner } from '../ports/proxy-command-runner';
import { ApplicationError } from './errors';

export class ProxyService {
  constructor(
    private readonly repository: ProductRepository,
    private readonly connector: ProxyConnector,
    private readonly hostCapabilities?: HostCapabilityClient,
    private readonly commandRunner?: ProxyCommandRunner,
  ) {}

  async connectForHost(
    host: Host,
    target: { host: string; port: number },
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Duplex | undefined> {
    return this.connectForRoute(host.proxy, host.username, target, timeoutMs, signal);
  }

  async connectForRoute(
    route: HostProxyConfig,
    username: string,
    target: { host: string; port: number },
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Duplex | undefined> {
    if (route.mode === 'command') {
      if (!this.commandRunner)
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'ProxyCommand is unavailable in this Runtime',
          503,
        );
      try {
        return await this.commandRunner.connect({
          command: route.command,
          target,
          username,
          timeoutMs,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        throw mapProxyError(error);
      }
    }
    const effective =
      route.mode === 'inherit' ? this.repository.getSettings().network.proxy : route;
    if (effective.mode === 'direct') return undefined;
    return this.connect(effective.endpoint, target, timeoutMs, signal);
  }

  async test(input: ProxyTestRequest, signal?: AbortSignal): Promise<ProxyTestResult> {
    const command = proxyTestRequestSchema.parse(input);
    let config: GlobalProxyConfig;
    let temporaryPassword: string | undefined;
    if (command.source.kind === 'global') config = this.repository.getSettings().network.proxy;
    else if (command.source.kind === 'host')
      config = this.effectiveForHost(this.repository.getHost(command.source.hostId));
    else {
      config = { mode: 'custom', endpoint: command.source.endpoint };
      temporaryPassword = command.source.temporaryPassword;
    }
    if (config.mode !== 'custom')
      throw new ApplicationError('PROXY_NOT_CONFIGURED', 'No proxy is configured', 409);

    const startedAt = performance.now();
    const socket = await this.connect(
      config.endpoint,
      command.target,
      command.timeoutMs,
      signal,
      temporaryPassword,
    );
    socket.destroy();
    const url = new URL(config.endpoint.url);
    const protocol = url.protocol.slice(0, -1) as ProxyTestResult['protocol'];
    const defaultPort = protocol === 'https' ? 443 : protocol === 'http' ? 8080 : 1080;
    return {
      reachable: true,
      protocol,
      proxyHost: url.hostname,
      proxyPort: url.port ? Number(url.port) : defaultPort,
      target: command.target,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  }

  private effectiveForHost(host: Host): GlobalProxyConfig {
    if (host.proxy.mode === 'command') return { mode: 'direct' };
    return host.proxy.mode === 'inherit' ? this.repository.getSettings().network.proxy : host.proxy;
  }

  private async connect(
    endpoint: ProxyEndpointConfig,
    target: { host: string; port: number },
    timeoutMs: number,
    signal?: AbortSignal,
    temporaryPassword?: string,
  ): Promise<Duplex> {
    try {
      const username = endpoint.username ?? undefined;
      const password =
        temporaryPassword ??
        (endpoint.credentialRef
          ? await this.requireHostCapabilities().resolveCredential(endpoint.credentialRef)
          : undefined);
      if (!!username !== !!password)
        throw new ApplicationError(
          'PROXY_AUTH_INVALID',
          'Proxy username and password must be supplied together',
          400,
        );
      return await this.connector.connect({
        proxy: {
          url: endpoint.url,
          ...(username && password ? { username, password } : {}),
        },
        target,
        timeoutMs,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw mapProxyError(error);
    }
  }

  private requireHostCapabilities(): HostCapabilityClient {
    if (!this.hostCapabilities)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'Saved proxy credentials are unavailable',
        503,
      );
    return this.hostCapabilities;
  }
}

const proxyErrorMessages = {
  PROXY_URL_INVALID: 'Proxy URL is invalid',
  PROXY_AUTH_INVALID: 'Proxy authentication configuration is invalid',
  PROXY_AUTH_REQUIRED: 'Proxy authentication was rejected',
  PROXY_CONNECT_REJECTED: 'Proxy could not reach the target',
  PROXY_PROTOCOL_ERROR: 'Proxy returned an invalid response',
  PROXY_RESPONSE_TOO_LARGE: 'Proxy returned an oversized response',
  PROXY_TIMEOUT: 'Proxy connection timed out',
  PROXY_ABORTED: 'Proxy connection was canceled',
  PROXY_CONNECT_FAILED: 'Proxy connection failed',
  PROXY_COMMAND_INVALID: 'ProxyCommand configuration is invalid',
  PROXY_COMMAND_START_FAILED: 'ProxyCommand could not be started',
  PROXY_COMMAND_FAILED: 'ProxyCommand process failed',
  PROXY_COMMAND_TIMEOUT: 'ProxyCommand start timed out',
  PROXY_COMMAND_ABORTED: 'ProxyCommand was canceled',
} as const;
type ProxyApplicationErrorCode = keyof typeof proxyErrorMessages;

function mapProxyError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  const candidate =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code in proxyErrorMessages
      ? error.code
      : undefined;
  const code: ProxyApplicationErrorCode =
    candidate && candidate in proxyErrorMessages
      ? (candidate as ProxyApplicationErrorCode)
      : 'PROXY_CONNECT_FAILED';
  const status =
    code === 'PROXY_URL_INVALID' ||
    code === 'PROXY_AUTH_INVALID' ||
    code === 'PROXY_COMMAND_INVALID'
      ? 400
      : code === 'PROXY_AUTH_REQUIRED'
        ? 409
        : 503;
  return new ApplicationError(code, proxyErrorMessages[code], status);
}
