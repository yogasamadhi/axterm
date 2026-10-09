export class LocalShellError extends Error {}

export function shellErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof LocalShellError ? cause.message : fallback;
}
