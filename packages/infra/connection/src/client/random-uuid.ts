// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/client/connection/src/client/random-uuid.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/** Browser-safe UUID generation for client-side wire correlation. */

/**
 * Generate an RFC 4122 version 4 UUID without requiring a secure context.
 * @returns a UUID backed by `crypto.getRandomValues()`, which browsers expose on insecure origins.
 */
export function randomUuid(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x40);
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
