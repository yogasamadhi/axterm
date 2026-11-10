// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Original types now live in the public contract; retain this compatibility facade.
// Canonical credential contracts are public; infrastructure owns no duplicate brands/events.
export type {
  ApiKeyRecord,
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRef,
  GrantRecord,
} from '@axterm/plugin-api/credentials';
