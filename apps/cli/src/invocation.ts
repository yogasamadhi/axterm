export type Invocation =
  | { readonly kind: 'help' }
  | { readonly kind: 'plugin'; readonly args: readonly string[] }
  | {
      readonly kind: 'profile';
      readonly profile: string;
      readonly patchFiles: readonly string[];
      readonly args: readonly string[];
      readonly dump: boolean;
    };

/** Parse only launcher flags; the selected application owns all other arguments. */
export function parseInvocation(input: readonly string[]): Invocation {
  if (input.length === 0 || input[0] === '--help') return { kind: 'help' };
  if (input[0] === 'plugin') return { kind: 'plugin', args: input.slice(1) };
  const delimiter = input.indexOf('--');
  const outer = delimiter < 0 ? input : input.slice(0, delimiter);
  const tail = delimiter < 0 ? [] : input.slice(delimiter + 1);
  const flags = outer.flatMap((arg, index) => (arg === '--profile' ? [index] : []));
  if (flags.length > 1) throw new Error('--profile must appear once');
  const profileIndex = flags[0];
  const profile = profileIndex === undefined ? outer[0] : outer[profileIndex + 1];
  if (!profile || !/^[a-z][a-z0-9-]*$/.test(profile))
    throw new Error('A named Profile is required; use --profile <name>');
  const args: string[] = [];
  const patchFiles: string[] = [];
  let dump = false;
  for (let index = profileIndex === undefined ? 1 : 0; index < outer.length; index += 1) {
    const arg = outer[index]!;
    if (arg === '--profile') {
      index += 1;
      continue;
    }
    if (arg === '--patch') {
      const path = outer[++index];
      if (!path || path.startsWith('-')) throw new Error('--patch requires a file');
      patchFiles.push(path);
    } else if (arg === '--dump-config') dump = true;
    else args.push(arg);
  }
  return { kind: 'profile', profile, patchFiles, dump, args: [...args, ...tail] };
}
