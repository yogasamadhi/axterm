// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/typert/generator/src/index.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/**
 * Public API of the Typert analyzer, compiler-independent model, and
 * model-driven artifact emitters. Build wiring lives in the `./tsdown`
 * subpath.
 * @module @axterm/remote-generator
 */

export { WorkspaceAnalyzer, WorkspaceCaches, TypertAnalysisError } from './analyzer.ts';
export type {
  AnalysisMode,
  DiscoveredTypertPackage,
  WorkspaceAnalyzerOptions,
} from './analyzer.ts';
export { FaceModelEmitter, TypertEmitError } from './emitter.ts';
export type { ModelEmitResult } from './emitter.ts';
export { TypeGraphRenderer, TypeGraphRenderError } from './renderer.ts';
export { findWorkspaceRoot, WorkspaceTypertGenerator } from './workspace.ts';
export type { WorkspaceEmitResult, WorkspaceTypertGeneratorOptions } from './workspace.ts';
export { writePackageArtifacts, writeWorkspaceArtifacts } from './artifact-files.ts';
export type * from './model.ts';
