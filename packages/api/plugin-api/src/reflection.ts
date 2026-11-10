// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/typert/registry/src/types.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/**
 * Pure generated-artifact and runtime-registry types. The registry stores Zod
 * schemas separately from generated package reflection metadata.
 * @module @axterm/plugin-api/reflection
 */

// Canonical definitions share one module with InvocationDescriptor to avoid a type-only cycle.
export type {
  TypertFace,
  TypertDocTag,
  TypertDocumentation,
  TypertMemberModel,
  TypertTypeModel,
  TypertServiceModel,
  TypertEventModel,
  TypertObjectModel,
  TypertPackageModel,
  TypertSchemaFactory,
  TypertContribution,
  TypertSchemaRecord,
  TypertPackageRecord,
  TypertSchemaFilter,
  TypertPackageFilter,
} from './types.ts';
