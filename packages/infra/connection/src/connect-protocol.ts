// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/client/connection/src/connect-protocol.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/** API connection inputs shared by the Host and its clients. */

/** Whether a Peer participates in forwarded human interactions. */
export type ConnectionInteractions = 'answer' | 'none';

/** POST launch-token exchange and authenticated DELETE Web logout route. */
export const CONNECT_PATH = '/connect';
