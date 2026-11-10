import { YAMLException } from 'js-yaml';

/** Parser exceptions can retain entire input buffers. Export only safe source locations. */
export function configurationParseFailure(message: string, error: unknown): Error {
  let location = '';
  if (error instanceof YAMLException && error.mark) {
    const { line, column } = error.mark;
    if (Number.isSafeInteger(line) && line >= 0 && Number.isSafeInteger(column) && column >= 0)
      location = ` at line ${line + 1}, column ${column + 1}`;
  }
  const failure = new Error(`${message}${location}`);
  failure.name = 'ConfigurationParseError';
  return failure;
}
