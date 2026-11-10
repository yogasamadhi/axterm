// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/subprocess/win32-process/src/koffi.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/** Process-realm lazy access to Koffi's CommonJS entry. */

import type koffi from 'koffi';
import { createLazyRequire } from '@axterm/infra-lazy-require';

/** Koffi runtime export type. */
export type Koffi = typeof koffi;

/** Load Koffi on the first Win32 native operation. */
export const requireKoffi = createLazyRequire<Koffi>('koffi', import.meta.url);
