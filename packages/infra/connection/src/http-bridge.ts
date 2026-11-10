// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/client/connection/src/http-bridge.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/**
 * node:http ↔ WHATWG fetch bridge for the /api transport (host side of the
 * web carrier; the fetch-shaped handler itself is transport-agnostic).
 */

import { writeFetchResponse } from '@axterm/infra-web-server';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PeerScope } from '@axterm/plugin-api';
import { Readable } from 'node:stream';
import type { ConnectionFetchHandler } from './rpc.ts';

/** Bounded JSON configuration/RPC carrier; bulk files have owner-registered streaming routes. */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Bridge one node:http request to the fetch-shaped handler (client close
 * aborts; response writes respect backpressure and stop on disconnect).
 * @param req - incoming node:http request.
 * @param res - node:http response the bridge writes and owns to completion.
 * @param apiHandler - fetch-shaped API carrier the request is dispatched to.
 * @param peer - Peer the carrier admitted the request as.
 * @param maxRequestBodyBytes - maximum bytes buffered for a buffered route.
 */
export async function bridge(
  req: IncomingMessage,
  res: ServerResponse,
  apiHandler: ConnectionFetchHandler,
  peer: PeerScope,
  maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<void> {
  const abort = new AbortController();
  let deferredRequestCleanup: (() => Promise<void>) | undefined;
  // Client-disconnect detection MUST hang off the response, not the request:
  // since Node 16, IncomingMessage 'close' fires as soon as the request body is
  // fully consumed (immediately for a bodyless GET), which would abort a
  // streaming response right after open. ServerResponse 'close' fires on connection teardown;
  // writableEnded distinguishes a normal end() from the client going away.
  const onClose = () => {
    if (!res.writableEnded) abort.abort();
  };
  const onPeerAbort = () => {
    abort.abort();
    if (!req.complete) req.destroy();
    res.destroy();
  };
  res.on('close', onClose);
  peer.signal.addEventListener('abort', onPeerAbort, { once: true });
  if (peer.signal.aborted) onPeerAbort();
  try {
    /* v8 ignore next 2 -- node:http always sets url/method on server requests. */
    const url = new URL(req.url ?? '/', 'http://axterm.internal');
    const method = req.method ?? 'GET';
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(([, value]) => typeof value === 'string') as [
        string,
        string,
      ][],
    );
    const bodyMode = apiHandler.requestBodyMode({ method, url });
    let request: Request;
    if (bodyMode === 'buffered') {
      const declaredLength = req.headers['content-length'];
      if (declaredLength !== undefined && Number(declaredLength) > maxRequestBodyBytes) {
        res.writeHead(413, { connection: 'close' });
        res.end();
        req.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      for await (const chunk of req) {
        const buffer = chunk as Buffer;
        received += buffer.byteLength;
        if (received > maxRequestBodyBytes) {
          res.writeHead(413, { connection: 'close' });
          res.end();
          req.destroy();
          return;
        }
        chunks.push(buffer);
      }
      request = new Request(url, {
        method,
        headers,
        ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
        signal: abort.signal,
      });
    } else {
      request = new Request(url, {
        method,
        headers,
        body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
        signal: abort.signal,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
    }
    const response = await apiHandler.fetch(request, peer);
    // A feature can answer from a durable receipt without reading the new body.
    // Discard a bounded amount before closing: an immediate socket destroy loses
    // that response to EPIPE for clients still sending a large retry.
    if (bodyMode === 'streaming' && !req.readableEnded && request.body && !request.body.locked) {
      const reader = request.body.getReader();
      let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
      let received = 0;
      let stop!: () => void;
      const stopped = new Promise<undefined>((resolve) => {
        stop = () => resolve(undefined);
      });
      const timer = setTimeout(stop, 1000);
      abort.signal.addEventListener('abort', stop, { once: true });
      try {
        while (received <= maxRequestBodyBytes && !abort.signal.aborted) {
          pending = reader.read();
          const next = await Promise.race([pending, stopped]);
          if (!next || next.done) break;
          received += next.value.byteLength;
        }
      } catch {
        /* An aborted incoming body still has an owned response to finish. */
      } finally {
        clearTimeout(timer);
        abort.signal.removeEventListener('abort', stop);
        if (!req.readableEnded) {
          // Cancellation destroys IncomingMessage, so defer it until the response
          // has actually flushed. Keep only one pending read while it is deferred.
          deferredRequestCleanup = async () => {
            const closed = req.closed
              ? Promise.resolve()
              : new Promise<void>((resolve) => req.once('close', resolve));
            req.destroy();
            await Promise.allSettled([reader.cancel(), pending, closed]);
            reader.releaseLock();
          };
        } else reader.releaseLock();
      }
    }
    const requestUnread = bodyMode === 'streaming' && !req.readableEnded;
    const outgoing = requestUnread
      ? new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers([...response.headers, ['connection', 'close']]),
        })
      : response;
    await writeFetchResponse(res, outgoing, method === 'HEAD', abort.signal);
    // An unread bulk body may still be arriving. Flush its early response before
    // closing the request socket, or large idempotent retries can lose their
    // receipt to EPIPE while the client is still uploading.
    await new Promise<void>((resolve) => {
      if (res.destroyed || res.writableFinished) {
        resolve();
        return;
      }
      const closed = () => {
        res.off('close', closed);
        resolve();
      };
      res.once('close', closed);
      res.end(() => {
        res.off('close', closed);
        resolve();
      });
    });
    if (requestUnread) req.destroy();
  } finally {
    await deferredRequestCleanup?.();
    res.off('close', onClose);
    peer.signal.removeEventListener('abort', onPeerAbort);
  }
}
