// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/util/http-proxy/src/index.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/**
 * Outbound HTTP proxy support for the application.
 *
 * Node's built-in `fetch` ignores `HTTP_PROXY` and friends, so every harness request would connect
 * directly no matter what the user exported. The launcher resolves one policy from the launch
 * environment and installs it as undici's global dispatcher, which is what `fetch` resolves — so
 * LLM adapters, web search, MCP over HTTP, and telemetry are covered without touching their code.
 *
 * This is a library, not a plugin: transport policy has one answer per process, so there is nothing
 * for a composition to mount, swap, or scope.
 *
 * Five functions, one per way a caller needs the policy — install it, build a dispatcher with its
 * own transport choices, ask how to send one request, build a child's environment, and strip the
 * ambient one for a replay.
 * @module @axterm/infra-http-proxy
 */

export {
  clearedProxyEnv,
  createRouteDispatcher,
  installProxyFromEnvironment,
  proxyEnvironmentForChild,
  proxyRouteFor,
  type DispatcherOptions,
  type ProxyRoute,
} from './install.ts';
