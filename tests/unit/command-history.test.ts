import { describe, expect, it } from 'vitest';
import {
  assessShellCommandLine,
  deserializeOsc633Value,
  isSensitiveCommandLine,
} from '../../packages/shared/src/command-history';

describe('command history input policy', () => {
  it('decodes OSC 633 escapes in one bounded pass without changing literal escapes', () => {
    expect(deserializeOsc633Value('printf a\\x3bb')).toBe('printf a;b');
    expect(deserializeOsc633Value('printf \\\\x3b')).toBe('printf \\x3b');
    expect(deserializeOsc633Value('printf C:\\\\tmp\\\\file')).toBe('printf C:\\tmp\\file');
    expect(deserializeOsc633Value('echo 界')).toBe('echo 界');
    expect(deserializeOsc633Value('echo \\q')).toBeUndefined();
    expect(deserializeOsc633Value('echo \\x3')).toBeUndefined();
    expect(deserializeOsc633Value('x'.repeat(16_385))).toBeUndefined();
  });

  it.each([
    ['', 'empty'],
    [' echo private', 'whitespace'],
    ['echo trailing ', 'whitespace'],
    ['echo one\necho two', 'multiline'],
    ['echo\u0000hidden', 'control'],
    ['x'.repeat(4_097), 'tooLong'],
  ] as const)('rejects unsafe line shape %#', (command, reason) => {
    expect(assessShellCommandLine(command)).toEqual({ accepted: false, reason });
  });

  it('accepts an exact, printable single command line', () => {
    expect(assessShellCommandLine("printf 'one' && printf 'two'")).toEqual({
      accepted: true,
      command: "printf 'one' && printf 'two'",
    });
  });

  it.each([
    'FOO_SECRET=value',
    'export CI_JOB_TOKEN=value',
    'DB_PASSWORD = value',
    "SSH_PRIVATE_KEY='value'",
    'serviceApiKey: value',
    'curl -u user:pass https://example.test',
    'curl --user=user:pass https://example.test',
    'wget --password=value https://example.test',
    'docker login -psecret registry.test',
    'docker login --password secret registry.test',
    'aws configure set aws_secret_access_key value',
    'postgresql://user:pass@db.test/database',
    'redis://default:pass@cache.test/0',
    'curl -H "Authorization: Bearer value" https://example.test',
    'sshpass -p value ssh host.test',
    'mysql -u root -psecret database',
    'tool --access-key value',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
  ])('drops a credential-bearing command: %s', (command) => {
    expect(isSensitiveCommandLine(command)).toBe(true);
  });

  it.each([
    'git status',
    'echo PASSWORD',
    'docker login registry.test',
    'curl https://example.test',
    'aws configure list',
    'ssh-keygen -t ed25519',
    "printf 'one' && printf 'two'",
  ])('does not classify a normal command as a credential: %s', (command) => {
    expect(isSensitiveCommandLine(command)).toBe(false);
  });
});
