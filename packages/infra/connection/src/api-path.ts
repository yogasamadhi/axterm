// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/client/connection/src/api-path.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/**
 * The /api URL prefix — single source for both halves of the web transport.
 * The node half registers this prefix on the web server.
 */

/** Route prefix owning every api request (`/api` and `/api/<anything>`). */
export const API_PATH = '/api';
