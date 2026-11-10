// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/client/web/src/css-modules.d.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}

declare module '*.css';
