import type { ShellIntegrationKind } from '../ports/terminal-channel';

export const SHELL_INTEGRATION_MARKER = '\u001b]633;A';
export const SHELL_INTEGRATION_INJECTION_MAX_BYTES = 16 * 1024;

export function detectShellIntegrationKind(
  executable: string | undefined,
  platform: NodeJS.Platform = process.platform,
): ShellIntegrationKind {
  if (platform === 'win32' || !executable) return 'unsupported';
  const normalized = executable.trim().toLowerCase().split(/[/\\]/u).at(-1) ?? '';
  if (normalized === 'bash') return 'bash';
  if (normalized === 'zsh') return 'zsh';
  if (normalized === 'fish') return 'fish';
  return 'unsupported';
}

/**
 * Builds an in-memory shell hook. Nothing is written to the user's shell rc
 * files. The leading space follows the pinned Electerm behavior and avoids
 * adding the bootstrap itself to shells configured with ignore-space history.
 */
export function createShellIntegrationCommand(kind: ShellIntegrationKind): string | undefined {
  const inline =
    kind === 'bash'
      ? bashIntegration()
      : kind === 'zsh'
        ? zshIntegration()
        : kind === 'fish'
          ? fishIntegration()
          : undefined;
  if (!inline) return undefined;
  const command =
    kind === 'fish' ? ` ${inline}\r` : ` eval '${inline.replace(/'/g, "'\\''")}' 2>/dev/null\r`;
  if (Buffer.byteLength(command, 'utf8') > SHELL_INTEGRATION_INJECTION_MAX_BYTES)
    throw new Error('Shell integration command exceeded its fixed bound');
  return command;
}

function bashIntegration(): string {
  return [
    'if [[ $- == *i* ]] && [[ -z "${AXTERM_SHELL_INTEGRATION:-}" ]]',
    'then export AXTERM_SHELL_INTEGRATION=1',
    '__ax_esc() { local v="$1"; v="${v//\\\\/\\\\\\\\}"; v="${v//;/\\\\x3b}"; printf \'%s\' "$v"; }',
    '__ax_pre() { local row c; [[ "${__ax_in:-0}" == "0" ]] || return; __ax_in=1; row="$(HISTTIMEFORMAT= builtin history 1)"; [[ "$row" != "${__ax_lastrow:-}" ]] || { __ax_in=0; return; }; __ax_lastrow="$row"; if [[ "$row" =~ ^[[:space:]]*[0-9]+[[:space:]][[:space:]](.*)$ ]]; then c="${BASH_REMATCH[1]}"; printf \'\\e]633;E;%s\\a\\e]633;C\\a\' "$(__ax_esc "$c")"; else __ax_in=0; fi; }',
    '__ax_cmd() { local c="$?"; [[ "${__ax_in:-0}" == "1" ]] && { printf \'\\e]633;D;%s\\a\' "$c"; __ax_in=0; }; printf \'\\e]633;P;Cwd=%s\\a\\e]633;A\\a\' "$(__ax_esc "$PWD")"; return "$c"; }',
    '__ax_lastrow="$(HISTTIMEFORMAT= builtin history 1)"',
    "trap '__ax_pre' DEBUG",
    'PROMPT_COMMAND="__ax_cmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"',
    'fi',
  ].join('; ');
}

function zshIntegration(): string {
  return [
    'if [[ -o interactive ]] && [[ -z "${AXTERM_SHELL_INTEGRATION:-}" ]]',
    'then export AXTERM_SHELL_INTEGRATION=1',
    '__ax_esc() { local v="$1"; v="${v//\\\\/\\\\\\\\}"; v="${v//;/\\\\x3b}"; builtin printf \'%s\' "$v"; }',
    '__ax_preexec() { __ax_cmdline="$1"; builtin printf \'\\e]633;E;%s\\a\\e]633;C\\a\' "$(__ax_esc "$1")"; }',
    '__ax_precmd() { local c="$?"; [[ -n "$__ax_cmdline" ]] && builtin printf \'\\e]633;D;%s\\a\' "$c"; __ax_cmdline=""; builtin printf \'\\e]633;P;Cwd=%s\\a\\e]633;A\\a\' "$(__ax_esc "$PWD")"; }',
    'precmd_functions+=(__ax_precmd)',
    'preexec_functions+=(__ax_preexec)',
    'fi',
  ].join('; ');
}

function fishIntegration(): string {
  return [
    'if status is-interactive; and not set -q AXTERM_SHELL_INTEGRATION',
    'set -g AXTERM_SHELL_INTEGRATION 1',
    "function __ax_esc; echo $argv | string replace -a '\\\\' '\\\\\\\\' | string replace -a ';' '\\\\x3b'; end",
    'function __ax_prompt --on-event fish_prompt; printf \'\\e]633;A\\a\\e]633;P;Cwd=%s\\a\' (__ax_esc "$PWD"); end',
    'function __ax_preexec --on-event fish_preexec; printf \'\\e]633;E;%s\\a\\e]633;C\\a\' (__ax_esc "$argv"); end',
    "function __ax_postexec --on-event fish_postexec; printf '\\e]633;D;%s\\a' $status; end",
    'end',
  ].join('; ');
}
