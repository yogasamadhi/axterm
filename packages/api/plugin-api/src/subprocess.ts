// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Selected from the fixed subprocess contract; application identities and diagnostics are adapted.
/** Namespace reserved for application-managed execution facts; ambient values never forward implicitly. */
export const AXTERM_ENV_PREFIX = 'AXTERM_' as const;
/** Lookup found no executable. The Host boundary owns presentation and diagnostic redaction. */
export class SubprocessExecutableNotFoundError extends Error {
  override readonly name = 'SubprocessExecutableNotFoundError';
  constructor(message = 'Executable is unavailable', options?: ErrorOptions) {
    super(message, options);
  }
}
