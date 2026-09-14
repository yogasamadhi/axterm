declare module '@xterm/headless/lib-headless/xterm-headless.js' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- ambient bridge for the published CommonJS entry.
  export const Terminal: typeof import('@xterm/headless').Terminal;
}
