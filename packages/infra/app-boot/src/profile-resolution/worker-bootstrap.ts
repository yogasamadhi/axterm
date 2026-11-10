// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/boot/app-boot/src/profile-resolution/worker-bootstrap.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/** Install the inherited runtime resolution in one application-owned Worker. */

import { getEnvironmentData } from 'node:worker_threads';
import { installRuntimeInterception } from './resolver.ts';
import type { RuntimeResolution } from '../profile.ts';

const registration = getEnvironmentData('@axterm/infra-app-boot/profile-resolution') as
  | {
      resolution: RuntimeResolution;
    }
  | undefined;
if (registration !== undefined) installRuntimeInterception(registration.resolution);
