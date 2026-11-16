import { entryYamlErrorPosition } from '@deepseek-ai/cordis-plugin-include';

/** Parser exceptions can retain entire input buffers. Export only safe source locations. */
export function configurationParseFailure(message: string, error: unknown): Error {
  let location = '';
  const position = entryYamlErrorPosition(error);
  if (position !== undefined) {
    const { line, column } = position;
    if (Number.isSafeInteger(line) && line > 0 && Number.isSafeInteger(column) && column > 0)
      location = ` at line ${line}, column ${column}`;
  }
  const failure = new Error(`${message}${location}`);
  failure.name = 'ConfigurationParseError';
  return failure;
}
