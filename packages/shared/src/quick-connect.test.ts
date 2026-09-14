import { describe, expect, it, vi } from 'vitest';
import {
  getDefaultQuickConnectPort,
  getSupportedQuickConnectProtocols,
  parseQuickConnect,
  QUICK_CONNECT_INPUT_PROTOCOLS,
  QUICK_CONNECT_LIMITS,
  type QuickConnectTarget,
} from './quick-connect';

describe('parseQuickConnect', () => {
  const normalCases: ReadonlyArray<{
    name: string;
    input: string;
    expected: Partial<QuickConnectTarget>;
  }> = [
    {
      name: 'explicit SSH with defaults',
      input: 'ssh://operator@192.168.1.100',
      expected: {
        protocol: 'ssh',
        hostname: '192.168.1.100',
        port: 22,
        username: 'operator',
        enableSsh: true,
        enableSftp: true,
        useSshAgent: true,
        authType: 'password',
        term: 'xterm-256color',
        encode: 'utf-8',
        envLang: 'en_US.UTF-8',
      },
    },
    {
      name: 'SSH URL auth and custom port',
      input: 'ssh://operator:p%40ss%3Aword@example.test:2202/',
      expected: {
        protocol: 'ssh',
        hostname: 'example.test',
        port: 2202,
        username: 'operator',
        temporarySecret: 'p@ss:word',
      },
    },
    {
      name: 'SSH shortcut',
      input: 'operator@localhost:23344',
      expected: { protocol: 'ssh', hostname: 'localhost', port: 23344, username: 'operator' },
    },
    {
      name: 'bare SSH host shortcut',
      input: 'my-server',
      expected: { protocol: 'ssh', hostname: 'my-server', port: 22 },
    },
    {
      name: 'Telnet defaults',
      input: 'telnet://operator@192.168.1.1',
      expected: { protocol: 'telnet', hostname: '192.168.1.1', port: 23, username: 'operator' },
    },
    {
      name: 'VNC defaults',
      input: 'vnc://192.168.1.20',
      expected: {
        protocol: 'vnc',
        hostname: '192.168.1.20',
        port: 5900,
        viewOnly: false,
        clipViewport: false,
        scaleViewport: true,
        qualityLevel: 3,
        compressionLevel: 1,
        shared: true,
      },
    },
    {
      name: 'RDP auth',
      input: 'rdp://administrator@rdp.example.test',
      expected: {
        protocol: 'rdp',
        hostname: 'rdp.example.test',
        port: 3389,
        username: 'administrator',
      },
    },
    {
      name: 'Electerm-compatible SPICE password syntax',
      input: 'spice://viewer-secret:192.168.1.30:5901',
      expected: {
        protocol: 'spice',
        hostname: '192.168.1.30',
        port: 5901,
        temporarySecret: 'viewer-secret',
        viewOnly: false,
        scaleViewport: true,
      },
    },
    {
      name: 'Windows serial path',
      input: 'serial://COM1?baudRate=115200',
      expected: { protocol: 'serial', path: 'COM1', baudRate: 115200, dataBits: 8 },
    },
    {
      name: 'POSIX serial path',
      input: 'serial:///dev/ttyUSB0?baudRate=9600',
      expected: { protocol: 'serial', path: '/dev/ttyUSB0', baudRate: 9600, parity: 'none' },
    },
    {
      name: 'FTP auth',
      input: 'ftp://ftpuser:ftppass@ftp.example.test:2121',
      expected: {
        protocol: 'ftp',
        hostname: 'ftp.example.test',
        port: 2121,
        username: 'ftpuser',
        temporarySecret: 'ftppass',
        encode: 'utf-8',
        secure: false,
      },
    },
    {
      name: 'Web URL retains path, query and fragment',
      input: 'https://example.test/docs/start/?title=Guide&lang=zh#install',
      expected: {
        protocol: 'https',
        url: 'https://example.test/docs/start/?title=Guide&lang=zh#install',
        title: 'Guide',
      },
    },
    {
      name: 'Web auth is removed from URL and kept ephemeral',
      input: 'http://reader:s%40fe@example.test:8080/path',
      expected: {
        protocol: 'http',
        url: 'http://example.test:8080/path',
        username: 'reader',
        temporarySecret: 's@fe',
      },
    },
    {
      name: 'electerm wrapper defaults to SSH',
      input: 'electerm://operator@example.test',
      expected: { protocol: 'ssh', hostname: 'example.test', port: 22, username: 'operator' },
    },
    {
      name: 'electerm wrapper selects Telnet',
      input: 'electerm://admin@192.168.1.1?type=telnet',
      expected: { protocol: 'telnet', hostname: '192.168.1.1', port: 23, username: 'admin' },
    },
    {
      name: 'axterm wrapper selects RDP with transient credentials',
      input: 'axterm://DOMAIN%5Coperator:session-only@desktop.test?type=rdp&title=Desk',
      expected: {
        protocol: 'rdp',
        hostname: 'desktop.test',
        port: 3389,
        username: 'DOMAIN\\operator',
        temporarySecret: 'session-only',
        title: 'Desk',
      },
    },
    {
      name: 'electerm tp alias selects VNC',
      input: 'electerm://192.168.1.40?tp=vnc',
      expected: { protocol: 'vnc', hostname: '192.168.1.40', port: 5900 },
    },
    {
      name: 'electerm wrapper converts to Web and removes routing query',
      input: 'electerm://example.test:8443/docs?type=https&title=Console&lang=zh',
      expected: {
        protocol: 'https',
        url: 'https://example.test:8443/docs?title=Console&lang=zh',
        title: 'Console',
      },
    },
  ];

  it.each(normalCases)('$name', ({ input, expected }) => {
    expect(parseQuickConnect(input)).toMatchObject(expected);
  });

  it('accepts raw, quoted and percent-encoded opts while applying only typed fields', () => {
    const inputs = [
      'ssh://url-user@host.test?opts={"title":"My Server","username":"opts-user","password":"session-only"}',
      'ssh://url-user@host.test?opts=\'{"title":"My Server","username":"opts-user","password":"session-only"}\'',
      'ssh://url-user@host.test?opts=%7B%22title%22%3A%22My%20Server%22%2C%22username%22%3A%22opts-user%22%2C%22password%22%3A%22session-only%22%7D',
    ];
    for (const input of inputs) {
      expect(parseQuickConnect(input)).toMatchObject({
        protocol: 'ssh',
        hostname: 'host.test',
        title: 'My Server',
        username: 'opts-user',
        temporarySecret: 'session-only',
      });
    }
  });

  it('parses bounded SSH tunnels and hopping credentials without password-shaped output', () => {
    const opts = encodeURIComponent(
      JSON.stringify({
        sshTunnels: [
          {
            sshTunnel: 'forwardLocalToRemote',
            sshTunnelLocalPort: 8080,
            sshTunnelRemoteHost: 'localhost',
            sshTunnelRemotePort: 80,
          },
          { sshTunnel: 'dynamicForward', sshTunnelLocalPort: 1080 },
        ],
        connectionHoppings: [
          { host: 'jump.test', port: 2200, username: 'jumper', password: 'hop-only' },
        ],
      }),
    );
    const result = parseQuickConnect(`ssh://operator@target.test?opts=${opts}`);
    expect(result).toMatchObject({
      protocol: 'ssh',
      sshTunnels: [
        {
          sshTunnel: 'forwardLocalToRemote',
          sshTunnelLocalPort: 8080,
          sshTunnelRemoteHost: 'localhost',
          sshTunnelRemotePort: 80,
        },
        { sshTunnel: 'dynamicForward', sshTunnelLocalPort: 1080 },
      ],
      connectionHoppings: [
        {
          hostname: 'jump.test',
          port: 2200,
          username: 'jumper',
          temporarySecret: 'hop-only',
        },
      ],
    });
    const keys: string[] = [];
    JSON.stringify(result, (key, value: unknown) => {
      keys.push(key);
      return value;
    });
    expect(keys).not.toContain('password');
  });

  it('supports protocol-specific opts and keeps Electerm defaults for omitted values', () => {
    expect(
      parseQuickConnect(
        'vnc://host.test?opts={"viewOnly":true,"scaleViewport":false,"qualityLevel":8,"compressionLevel":4,"shared":false}',
      ),
    ).toMatchObject({
      protocol: 'vnc',
      viewOnly: true,
      scaleViewport: false,
      qualityLevel: 8,
      compressionLevel: 4,
      shared: false,
    });
    expect(
      parseQuickConnect(
        'serial://COM4?opts={"baudRate":57600,"dataBits":7,"stopBits":2,"parity":"even","rtscts":true}',
      ),
    ).toMatchObject({
      protocol: 'serial',
      path: 'COM4',
      baudRate: 57600,
      dataBits: 7,
      stopBits: 2,
      parity: 'even',
      rtscts: true,
    });
  });

  it('ignores the upstream host/type deny-list instead of allowing destination overrides', () => {
    expect(
      parseQuickConnect('ssh://real.test?opts={"host":"attacker.test","type":"ftp","port":2222}'),
    ).toMatchObject({ protocol: 'ssh', hostname: 'real.test', port: 2222 });
  });

  const invalidCases: ReadonlyArray<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['unsupported protocol', 'gopher://example.test'],
    ['malformed scheme', '://example.test'],
    ['missing host', 'ssh://'],
    ['network path', 'ssh://host.test/not-a-terminal-path'],
    ['out-of-range port', 'ssh://host.test:65536'],
    ['bad serial baud query', 'serial://COM1?baudRate=fast'],
    ['invalid electerm target type', 'electerm://host.test?type=invalid'],
    ['recursive electerm type', 'electerm://host.test?type=electerm'],
    ['malformed opts', 'ssh://host.test?opts={bad-json}'],
    ['array opts', 'ssh://host.test?opts=[]'],
    ['unknown opts key', 'ssh://host.test?opts={"privateKey":"secret material"}'],
    ['wrong opts value type', 'vnc://host.test?opts={"viewOnly":"yes"}'],
    ['prototype-shaped opts key', 'ssh://host.test?opts={"__proto__":{"polluted":true}}'],
    [
      'invalid tunnel port',
      'ssh://host.test?opts={"sshTunnels":[{"sshTunnel":"dynamicForward","sshTunnelLocalPort":0}]}',
    ],
    [
      'unsupported hopping key material',
      'ssh://host.test?opts={"connectionHoppings":[{"host":"jump.test","privateKey":"secret"}]}',
    ],
    ['control byte in URL password', 'ssh://user:line%0Abreak@host.test'],
  ];

  it.each(invalidCases)('rejects %s', (_name, input) => {
    expect(parseQuickConnect(input)).toBeNull();
  });

  it('enforces input, query, opts, string and nested-array limits', () => {
    expect(parseQuickConnect(`ssh://${'a'.repeat(QUICK_CONNECT_LIMITS.inputBytes)}`)).toBeNull();
    expect(
      parseQuickConnect(`ssh://host.test?title=${'x'.repeat(QUICK_CONNECT_LIMITS.queryBytes + 1)}`),
    ).toBeNull();
    expect(
      parseQuickConnect(
        `ssh://host.test?opts={"title":"${'x'.repeat(QUICK_CONNECT_LIMITS.optsBytes)}"}`,
      ),
    ).toBeNull();
    expect(
      parseQuickConnect(
        `ssh://host.test?opts=${encodeURIComponent(JSON.stringify({ sshTunnels: Array.from({ length: QUICK_CONNECT_LIMITS.maxTunnels + 1 }, () => ({ sshTunnel: 'dynamicForward', sshTunnelLocalPort: 1080 })) }))}`,
      ),
    ).toBeNull();
  });

  it('does not log the input or parse failures', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(parseQuickConnect('ssh://user:do-not-log@host.test?opts={bad}')).toBeNull();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe('Quick Connect protocol metadata', () => {
  it('returns Electerm-compatible default ports', () => {
    expect(getDefaultQuickConnectPort('ssh')).toBe(22);
    expect(getDefaultQuickConnectPort('telnet')).toBe(23);
    expect(getDefaultQuickConnectPort('vnc')).toBe(5900);
    expect(getDefaultQuickConnectPort('rdp')).toBe(3389);
    expect(getDefaultQuickConnectPort('spice')).toBe(5900);
    expect(getDefaultQuickConnectPort('ftp')).toBe(21);
    expect(getDefaultQuickConnectPort('http')).toBe(80);
    expect(getDefaultQuickConnectPort('https')).toBe(443);
    expect(getDefaultQuickConnectPort('serial')).toBeUndefined();
  });

  it('returns a defensive copy of every supported input protocol', () => {
    const protocols = getSupportedQuickConnectProtocols();
    expect(protocols).toEqual(QUICK_CONNECT_INPUT_PROTOCOLS);
    protocols.pop();
    expect(getSupportedQuickConnectProtocols()).toEqual(QUICK_CONNECT_INPUT_PROTOCOLS);
  });
});
