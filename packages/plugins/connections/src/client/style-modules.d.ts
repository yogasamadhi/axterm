declare module '*.css' {
  const classes: Readonly<Record<string, string>>;
  export const cssText: string;
  export default classes;
}
