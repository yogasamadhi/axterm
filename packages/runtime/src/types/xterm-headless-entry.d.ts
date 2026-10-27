declare module '@xterm/headless/lib-headless/xterm-headless.mjs' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- ambient bridge for the published ESM entry.
  export const Terminal: typeof import('@xterm/headless').Terminal;
}
