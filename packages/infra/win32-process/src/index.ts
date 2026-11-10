// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/subprocess/win32-process/src/index.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/** Shared low-level Win32 process, stdio, and Job Object primitives. */

export { ERROR_INSUFFICIENT_BUFFER } from './abi.ts';
export * from './errors.ts';
export {
  allocPtrSlot,
  allocUint32,
  decodePtr,
  decodeUint32,
  extendWin32ProcessBindings,
  isNullPtr,
  loadWin32ProcessBindings,
  throwLastError,
  throwWin32,
} from './ffi.ts';
export type { CurrentTokenProcessBindings, NativePtr, Win32ProcessBindings } from './ffi.ts';
export {
  closeHandleChecked,
  drainPipe,
  isJobEmpty,
  pollProcessExit,
  probeCurrentTokenJobSupport,
  spawnInheritedJobProcess,
  spawnCurrentTokenJobProcess,
  spawnPipedProcess,
  terminateJob,
  waitForProcessExit,
} from './process.ts';
export type {
  CurrentTokenStdioFileDescriptors,
  CurrentTokenProcessSpawnOptions,
  SpawnedJobProcess,
  SpawnedPipedProcess,
} from './process.ts';
