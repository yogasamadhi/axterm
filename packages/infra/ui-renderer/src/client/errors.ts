// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/client/ui-renderer/src/client/errors.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/** Shared renderer failure categories. @module */

/** Renderer assembly failures that must escape component error boundaries. */
export class SlotAssemblyError extends Error {}
