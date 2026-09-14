import { z } from 'zod';
import { shortcutSettingsSchema } from './shortcuts';

export const idSchema = z.uuid();
export const timestampSchema = z.iso.datetime();
export const entityFields = {
  id: idSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  version: z.number().int().positive(),
};
export const etagSchema = z.string().regex(/^"v\d+"$/);

export const hostGroupSchema = z
  .object({ ...entityFields, name: z.string().trim().min(1).max(80), sortOrder: z.number().int() })
  .strict();
export const createHostGroupSchema = z
  .object({ name: z.string().trim().min(1).max(80), sortOrder: z.number().int().default(0) })
  .strict();
export const updateHostGroupSchema = createHostGroupSchema.partial().strict();

export const authTypeSchema = z.enum(['password', 'privateKey', 'keyboardInteractive', 'agent']);
export const DEFAULT_SSH_AGENT = { enabled: true, path: null } as const;
const sshAgentPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine((value) => !/[\0\r\n]/u.test(value), 'SSH Agent path cannot contain control lines')
  .nullable()
  .default(null);
export const sshAgentSchema = z
  .object({ enabled: z.boolean().default(true), path: sshAgentPathSchema })
  .strict()
  .default(DEFAULT_SSH_AGENT);
export const DEFAULT_HOST_PROXY = { mode: 'inherit' } as const;
export const DEFAULT_GLOBAL_PROXY = { mode: 'direct' } as const;

const proxyUrlSchema = z
  .url()
  .trim()
  .max(2_048)
  .refine((input) => {
    const value = new URL(input);
    return (
      ['http:', 'https:', 'socks5:', 'socks5h:'].includes(value.protocol) &&
      !!value.hostname &&
      !value.username &&
      !value.password &&
      (value.pathname === '' || value.pathname === '/') &&
      !value.search &&
      !value.hash
    );
  }, 'Proxy URL must be an http, https, socks5 or socks5h origin without credentials');
const proxyUsernameSchema = z.string().trim().min(1).max(255).nullable().default(null);
const proxyCredentialRefSchema = z.string().min(1).max(256).nullable().default(null);
const proxyEndpointShape = {
  url: proxyUrlSchema,
  username: proxyUsernameSchema,
  credentialRef: proxyCredentialRefSchema,
};
export const proxyEndpointSchema = z
  .object(proxyEndpointShape)
  .strict()
  .superRefine((value, context) => {
    if (!!value.username !== !!value.credentialRef)
      context.addIssue({
        code: 'custom',
        message: 'Proxy username and credentialRef must be supplied together',
        path: ['credentialRef'],
      });
  });
const proxyCommandValueSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !/[\0\r\n]/u.test(value), 'ProxyCommand values cannot contain control lines');
export const proxyCommandSchema = z
  .object({
    executable: proxyCommandValueSchema.trim(),
    arguments: z.array(proxyCommandValueSchema).min(1).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    let includesHost = false;
    let includesPort = false;
    for (const [index, argument] of value.arguments.entries()) {
      for (let offset = 0; offset < argument.length; offset += 1) {
        if (argument[offset] !== '%') continue;
        const placeholder = argument[offset + 1];
        if (placeholder === 'h') includesHost = true;
        else if (placeholder === 'p') includesPort = true;
        else if (placeholder !== 'r' && placeholder !== '%') {
          context.addIssue({
            code: 'custom',
            message: 'ProxyCommand supports only %h, %p, %r and %% placeholders',
            path: ['arguments', index],
          });
        }
        offset += 1;
      }
    }
    if (!includesHost)
      context.addIssue({
        code: 'custom',
        message: 'ProxyCommand arguments must include %h',
        path: ['arguments'],
      });
    if (!includesPort)
      context.addIssue({
        code: 'custom',
        message: 'ProxyCommand arguments must include %p',
        path: ['arguments'],
      });
  });
export const hostProxySchema = z
  .discriminatedUnion('mode', [
    z.object({ mode: z.literal('inherit') }).strict(),
    z.object({ mode: z.literal('direct') }).strict(),
    z.object({ mode: z.literal('custom'), endpoint: proxyEndpointSchema }).strict(),
    z.object({ mode: z.literal('command'), command: proxyCommandSchema }).strict(),
  ])
  .default(DEFAULT_HOST_PROXY);
export const globalProxySchema = z
  .discriminatedUnion('mode', [
    z.object({ mode: z.literal('direct') }).strict(),
    z.object({ mode: z.literal('custom'), endpoint: proxyEndpointSchema }).strict(),
  ])
  .default(DEFAULT_GLOBAL_PROXY);
export const DEFAULT_SSH_RECONNECT_POLICY = {
  mode: 'manual',
  delayMs: 3_000,
  maxAttempts: 10,
} as const;
export const DEFAULT_SSH_CONNECTION_OPTIONS = {
  connectionTimeoutMs: 50_000,
  keepaliveIntervalMs: 10_000,
  keepaliveCountMax: 10,
  compression: true,
  algorithms: {
    kex: [] as string[],
    cipher: [] as string[],
    serverHostKey: [] as string[],
    hmac: [] as string[],
  },
  reconnectPolicy: DEFAULT_SSH_RECONNECT_POLICY,
} as const;

const connectionTimeoutMsSchema = z.number().int().min(1_000).max(300_000);
const keepaliveIntervalMsSchema = z.number().int().min(0).max(300_000);
const keepaliveCountMaxSchema = z.number().int().min(1).max(100);
const reconnectDelayMsSchema = z.number().int().min(250).max(60_000);
const reconnectMaxAttemptsSchema = z.number().int().min(1).max(20);
const sshAlgorithmNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9@._+-]+$/u);
const sshAlgorithmListSchema = z.array(sshAlgorithmNameSchema).max(32).default([]);
export const sshAlgorithmsSchema = z
  .object({
    kex: sshAlgorithmListSchema,
    cipher: sshAlgorithmListSchema,
    serverHostKey: sshAlgorithmListSchema,
    hmac: sshAlgorithmListSchema,
  })
  .strict()
  .default(DEFAULT_SSH_CONNECTION_OPTIONS.algorithms);
export const DEFAULT_SSH_STARTUP = {
  directory: null,
  environment: {} as Record<string, string>,
  loginScripts: [] as Array<{
    command: string;
    delayMs: number;
    sendEnter: boolean;
    waitForOutput: boolean;
    settleIdleMs: number;
    settleTimeoutMs: number;
  }>,
  runScripts: [] as Array<{
    command: string;
    delayMs: number;
    sendEnter: boolean;
    waitForOutput: boolean;
    settleIdleMs: number;
    settleTimeoutMs: number;
  }>,
} as const;
export const DEFAULT_SSH_X11 = { enabled: false, display: null } as const;
const sshX11DisplaySchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine((value) => !/[\0\r\n]/u.test(value), 'X11 display must be single-line')
  .nullable();
export const sshX11Schema = z
  .object({
    enabled: z.boolean().default(false),
    display: sshX11DisplaySchema.default(null),
  })
  .strict()
  .default(DEFAULT_SSH_X11);
const sshStartupEnvironmentNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
  .refine(
    (name) => !/(?:PASSWORD|PASSWD|TOKEN|SECRET|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/iu.test(name),
    'Secret-like environment variables cannot be persisted in SSH startup settings',
  );
const sshStartupEnvironmentSchema = z
  .record(
    sshStartupEnvironmentNameSchema,
    z
      .string()
      .max(4_096)
      .refine((value) => !/[\0\r\n]/u.test(value), 'Environment values must be single-line'),
  )
  .refine((environment) => Object.keys(environment).length <= 64, {
    message: 'At most 64 SSH environment variables are allowed',
  });
const sshStartupScriptSchema = z
  .object({
    command: z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .refine((value) => !value.includes('\0'), 'SSH startup scripts cannot contain NUL'),
    delayMs: z.number().int().min(0).max(60_000).default(0),
    sendEnter: z.boolean().default(true),
    waitForOutput: z.boolean().default(true),
    settleIdleMs: z.number().int().min(50).max(2_000).default(400),
    settleTimeoutMs: z.number().int().min(250).max(10_000).default(3_000),
  })
  .strict();
const sshStartupDirectorySchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine((value) => !/[\0\r\n]/u.test(value), 'SSH startup directory must be single-line')
  .nullable();
const sshStartupScriptListSchema = z.array(sshStartupScriptSchema).max(16);
export const sshStartupSchema = z
  .object({
    directory: sshStartupDirectorySchema.default(null),
    environment: sshStartupEnvironmentSchema.default({}),
    loginScripts: sshStartupScriptListSchema.default([]),
    runScripts: sshStartupScriptListSchema.default([]),
  })
  .strict()
  .default(DEFAULT_SSH_STARTUP);
export const sshReconnectPolicySchema = z
  .object({
    mode: z.enum(['manual', 'automatic']).default(DEFAULT_SSH_RECONNECT_POLICY.mode),
    delayMs: reconnectDelayMsSchema.default(DEFAULT_SSH_RECONNECT_POLICY.delayMs),
    maxAttempts: reconnectMaxAttemptsSchema.default(DEFAULT_SSH_RECONNECT_POLICY.maxAttempts),
  })
  .strict()
  .default(DEFAULT_SSH_RECONNECT_POLICY);
export const sshConnectionOptionsSchema = z
  .object({
    connectionTimeoutMs: connectionTimeoutMsSchema.default(
      DEFAULT_SSH_CONNECTION_OPTIONS.connectionTimeoutMs,
    ),
    keepaliveIntervalMs: keepaliveIntervalMsSchema.default(
      DEFAULT_SSH_CONNECTION_OPTIONS.keepaliveIntervalMs,
    ),
    keepaliveCountMax: keepaliveCountMaxSchema.default(
      DEFAULT_SSH_CONNECTION_OPTIONS.keepaliveCountMax,
    ),
    compression: z.boolean().default(DEFAULT_SSH_CONNECTION_OPTIONS.compression),
    algorithms: sshAlgorithmsSchema,
    reconnectPolicy: sshReconnectPolicySchema,
  })
  .strict()
  .default(DEFAULT_SSH_CONNECTION_OPTIONS);
export const sshConnectionOptionsPatchSchema = z
  .object({
    connectionTimeoutMs: connectionTimeoutMsSchema.optional(),
    keepaliveIntervalMs: keepaliveIntervalMsSchema.optional(),
    keepaliveCountMax: keepaliveCountMaxSchema.optional(),
    compression: z.boolean().optional(),
    algorithms: z
      .object({
        kex: sshAlgorithmListSchema.removeDefault().optional(),
        cipher: sshAlgorithmListSchema.removeDefault().optional(),
        serverHostKey: sshAlgorithmListSchema.removeDefault().optional(),
        hmac: sshAlgorithmListSchema.removeDefault().optional(),
      })
      .strict()
      .optional(),
    reconnectPolicy: z
      .object({
        mode: z.enum(['manual', 'automatic']).optional(),
        delayMs: reconnectDelayMsSchema.optional(),
        maxAttempts: reconnectMaxAttemptsSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const hostSchema = z
  .object({
    ...entityFields,
    groupId: idSchema.nullable(),
    name: z.string(),
    hostname: z.string(),
    port: z.number().int().min(1).max(65_535),
    username: z.string(),
    authType: authTypeSchema,
    credentialRef: z.string().nullable(),
    passphraseCredentialRef: z.string().nullable(),
    certificateCredentialRef: z.string().nullable(),
    jumpHostId: idSchema.nullable(),
    jumpHostIds: z.array(idSchema).max(8),
    favorite: z.boolean(),
    proxy: hostProxySchema,
    connectionOptions: sshConnectionOptionsSchema,
    startup: sshStartupSchema,
    x11: sshX11Schema,
    sshAgent: sshAgentSchema,
  })
  .strict();
export const createHostSchema = z
  .object({
    groupId: idSchema.nullable().default(null),
    name: z.string().trim().min(1).max(100),
    hostname: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65_535).default(22),
    username: z.string().trim().min(1).max(128),
    authType: authTypeSchema.default('password'),
    credentialRef: z.string().min(1).max(256).nullable().default(null),
    passphraseCredentialRef: z.string().min(1).max(256).nullable().default(null),
    certificateCredentialRef: z.string().min(1).max(256).nullable().default(null),
    jumpHostId: idSchema.nullable().default(null),
    jumpHostIds: z.array(idSchema).max(8).default([]),
    favorite: z.boolean().default(false),
    proxy: hostProxySchema,
    connectionOptions: sshConnectionOptionsSchema,
    startup: sshStartupSchema,
    x11: sshX11Schema,
    sshAgent: sshAgentSchema,
  })
  .strict();
export const updateHostSchema = z
  .object({
    groupId: idSchema.nullable().optional(),
    name: z.string().trim().min(1).max(100).optional(),
    hostname: z.string().trim().min(1).max(253).optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    username: z.string().trim().min(1).max(128).optional(),
    authType: authTypeSchema.optional(),
    credentialRef: z.string().min(1).max(256).nullable().optional(),
    passphraseCredentialRef: z.string().min(1).max(256).nullable().optional(),
    certificateCredentialRef: z.string().min(1).max(256).nullable().optional(),
    jumpHostId: idSchema.nullable().optional(),
    jumpHostIds: z.array(idSchema).max(8).optional(),
    favorite: z.boolean().optional(),
    proxy: hostProxySchema.removeDefault().optional(),
    connectionOptions: sshConnectionOptionsPatchSchema.optional(),
    startup: z
      .object({
        directory: sshStartupDirectorySchema.optional(),
        environment: sshStartupEnvironmentSchema.optional(),
        loginScripts: sshStartupScriptListSchema.optional(),
        runScripts: sshStartupScriptListSchema.optional(),
      })
      .strict()
      .optional(),
    x11: z
      .object({
        enabled: z.boolean().optional(),
        display: sshX11DisplaySchema.optional(),
      })
      .strict()
      .optional(),
    sshAgent: z
      .object({
        enabled: z.boolean().optional(),
        path: sshAgentPathSchema.removeDefault().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const knownHostKeySchema = z
  .object({
    ...entityFields,
    host: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65_535),
    algorithm: z.string().trim().min(1).max(128),
    fingerprint: z.string().trim().min(1).max(256),
    publicKey: z.string().min(1).max(131_072),
    firstSeenAt: timestampSchema,
    lastSeenAt: timestampSchema,
  })
  .strict();
export const workspaceSectionSchema = z.enum([
  'hosts',
  'files',
  'tunnels',
  'commands',
  'ai',
  'settings',
]);
export const workspaceContentSurfaceSchema = z.enum(['terminal', 'section']);
export const workspaceLayoutModeSchema = z.enum([
  'c1',
  'c2',
  'r2',
  'c3',
  'r3',
  'c2x2',
  'c1r2',
  'r1c2',
]);
export const DEFAULT_TERMINAL_APPEARANCE = {
  fontFamily: 'Maple Mono, mono, courier-new, courier, monospace',
  fontSize: 16,
  lineHeight: 1,
  cursorStyle: 'block',
  cursorBlink: false,
} as const;
export const DEFAULT_TERMINAL_BEHAVIOR = {
  scrollback: 3_000,
  rendererPreference: 'dom',
  unicodeVersion: '11',
  ligaturesEnabled: true,
  imageSequencesEnabled: false,
  wordSeparator: './\\()"\'-:,.;<>~!@#$%^&*|+=[]{}`~ ?',
  backspaceMode: '^?',
  shiftEnterMode: '\\n',
  encoding: 'utf-8',
  displayRaw: false,
  logTimestamps: false,
  pasteProtection: true,
  osc52Enabled: false,
  osc52ReadPolicy: 'deny',
  osc52WritePolicy: 'deny',
} as const;
export const DEFAULT_TERMINAL_TYPE = 'xterm-256color';
export const terminalAppearanceSchema = z
  .object({
    fontFamily: z.string().trim().min(1).max(256),
    fontSize: z.number().min(8).max(72),
    lineHeight: z.number().min(1).max(2),
    cursorStyle: z.enum(['block', 'underline', 'bar']),
    cursorBlink: z.boolean(),
  })
  .strict();
export const terminalClipboardAccessPolicySchema = z.enum(['deny', 'allow']);
export const terminalScrollbackSchema = z.number().int().min(0).max(100_000);
export const terminalRendererPreferenceSchema = z.enum(['dom', 'webgl']);
export const terminalUnicodeVersionSchema = z.enum(['6', '11']);
export const terminalWordSeparatorSchema = z.string().max(256);
export const terminalBackspaceModeSchema = z.enum(['^?', '^H']);
export const terminalShiftEnterModeSchema = z.string().max(256);
export const TERMINAL_ENCODINGS = [
  'utf-8',
  'gbk',
  'gb2312',
  'gb18030',
  'hz-gb-2312',
  'big5',
  'euc-jp',
  'iso-2022-jp',
  'shift-jis',
  'euc-kr',
  'iso-2022-kr',
  'utf-16be',
  'utf-16le',
  'ibm866',
  'iso-8859-2',
  'iso-8859-3',
  'iso-8859-4',
  'iso-8859-5',
  'iso-8859-6',
  'iso-8859-7',
  'iso-8859-8',
  'iso-8859-8i',
  'iso-8859-10',
  'iso-8859-13',
  'iso-8859-14',
  'iso-8859-15',
  'iso-8859-16',
  'koi8-r',
  'koi8-u',
  'macintosh',
  'windows-874',
  'windows-1250',
  'windows-1251',
  'windows-1252',
  'windows-1253',
  'windows-1254',
  'windows-1255',
  'windows-1256',
  'windows-1257',
  'windows-1258',
  'x-mac-cyrillic',
  'x-user-defined',
  'replacement',
] as const;
export const terminalEncodingSchema = z.enum(TERMINAL_ENCODINGS);
export const terminalBehaviorSchema = z
  .object({
    scrollback: terminalScrollbackSchema.default(DEFAULT_TERMINAL_BEHAVIOR.scrollback),
    rendererPreference: terminalRendererPreferenceSchema.default(
      DEFAULT_TERMINAL_BEHAVIOR.rendererPreference,
    ),
    unicodeVersion: terminalUnicodeVersionSchema.default(DEFAULT_TERMINAL_BEHAVIOR.unicodeVersion),
    ligaturesEnabled: z.boolean().default(DEFAULT_TERMINAL_BEHAVIOR.ligaturesEnabled),
    imageSequencesEnabled: z.boolean().default(DEFAULT_TERMINAL_BEHAVIOR.imageSequencesEnabled),
    wordSeparator: terminalWordSeparatorSchema.default(DEFAULT_TERMINAL_BEHAVIOR.wordSeparator),
    backspaceMode: terminalBackspaceModeSchema.default(DEFAULT_TERMINAL_BEHAVIOR.backspaceMode),
    shiftEnterMode: terminalShiftEnterModeSchema.default(DEFAULT_TERMINAL_BEHAVIOR.shiftEnterMode),
    encoding: terminalEncodingSchema.default(DEFAULT_TERMINAL_BEHAVIOR.encoding),
    displayRaw: z.boolean().default(DEFAULT_TERMINAL_BEHAVIOR.displayRaw),
    logTimestamps: z.boolean().default(DEFAULT_TERMINAL_BEHAVIOR.logTimestamps),
    pasteProtection: z.boolean(),
    osc52Enabled: z.boolean(),
    osc52ReadPolicy: terminalClipboardAccessPolicySchema,
    osc52WritePolicy: terminalClipboardAccessPolicySchema,
  })
  .strict();
export const terminalTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9+._-]*$/, 'Invalid terminal type');
export const terminalLangSchema = z
  .string()
  .trim()
  .min(1)
  .max(130)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/, 'Invalid LANG value');
const environmentNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Invalid environment variable name')
  .refine(
    (name) => !/^(?:TERM|LANG|NODE_OPTIONS|ELECTRON_.+|AXTERM_.+TOKEN)$/i.test(name),
    'Use the dedicated TERM/LANG fields; internal process variables cannot be overridden',
  )
  .refine(
    (name) => !/(?:PASSWORD|PASSWD|TOKEN|SECRET|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i.test(name),
    'Secret-like environment variables cannot be persisted in a terminal profile',
  );
export const terminalEnvironmentSchema = z
  .record(
    environmentNameSchema,
    z
      .string()
      .max(4096)
      .refine((value) => !/[\r\n]/.test(value), 'Environment values must be single-line'),
  )
  .refine((environment) => Object.keys(environment).length <= 64, {
    message: 'At most 64 environment variables are allowed',
  });
export const DEFAULT_TERMINAL_THEME_ID = '00000000-0000-4000-8000-000000000001';
export const terminalBackgroundSchema = z
  .object({
    kind: z.enum(['none', 'text', 'image']),
    assetId: idSchema.nullable(),
    text: z.string().max(240),
    textSize: z.number().int().min(12).max(240),
    textColor: z.string().regex(/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i),
    textFontFamily: z.string().trim().min(1).max(256),
    opacity: z.number().min(0).max(1),
    blur: z.number().min(0).max(50),
    brightness: z.number().min(0).max(10),
    grayscale: z.number().min(0).max(1),
    contrast: z.number().min(0).max(10),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === 'image' && !value.assetId)
      context.addIssue({ code: 'custom', path: ['assetId'], message: 'Image asset is required' });
    if (value.kind !== 'image' && value.assetId)
      context.addIssue({
        code: 'custom',
        path: ['assetId'],
        message: 'Only image backgrounds may reference an asset',
      });
    if (value.kind === 'text' && !value.text.trim())
      context.addIssue({ code: 'custom', path: ['text'], message: 'Background text is required' });
  });
export const DEFAULT_TERMINAL_BACKGROUND = {
  kind: 'none',
  assetId: null,
  text: '',
  textSize: 48,
  textColor: '#ffffff',
  textFontFamily: 'Maple Mono',
  opacity: 1,
  blur: 0,
  brightness: 1,
  grayscale: 0,
  contrast: 1,
} as const;
export const terminalVisualSettingsSchema = z
  .object({
    themeId: idSchema.default(DEFAULT_TERMINAL_THEME_ID),
    background: terminalBackgroundSchema.default(DEFAULT_TERMINAL_BACKGROUND),
  })
  .strict();
export const persistedTerminalTabSchema = z
  .object({
    id: idSchema,
    title: z.string().max(100),
    kind: z.enum(['local', 'ssh', 'telnet', 'serial', 'rdp', 'vnc', 'spice', 'web']),
    hostId: idSchema.optional(),
    connectionId: idSchema.optional(),
    bookmarkId: idSchema.optional(),
    profileId: idSchema.optional(),
    appearance: terminalAppearanceSchema.optional(),
    behavior: terminalBehaviorSchema.optional(),
    visual: terminalVisualSettingsSchema.optional(),
    tabNumber: z.number().int().min(1).max(9_999).optional(),
    pinned: z.boolean().default(false),
    paneIndex: z.number().int().min(0).max(3).default(0),
  })
  .strict();
export const workspaceLayoutSchema = z
  .object({
    section: workspaceSectionSchema,
    // Optional for settings written before the rail/panel state was separated
    // from the terminal selection. Renderer restoration infers the legacy mode.
    contentSurface: workspaceContentSurfaceSchema.optional(),
    sidebarOpen: z.boolean(),
    split: z.boolean().default(false),
    tabs: z.array(persistedTerminalTabSchema).max(20),
    activeTerminalId: idSchema.nullable(),
    secondaryTerminalId: idSchema.nullable().default(null),
    layoutMode: workspaceLayoutModeSchema.default('c1'),
    // A layout keeps pane positions stable. `null` represents an Electerm-style
    // empty batch instead of implicitly distributing unrelated tabs into it.
    paneTerminalIds: z.array(idSchema.nullable()).max(4).default([]),
    focusedPane: z.number().int().min(0).max(3).default(0),
  })
  .strict();
export const namedWorkspaceSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1).max(80),
    layout: workspaceLayoutSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const terminalShortcutButtonSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9:+_-]*$/u),
    label: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .refine(
        (value) =>
          [...value].every((character) => {
            const code = character.codePointAt(0) ?? 0;
            return code > 31 && code !== 127;
          }),
        'Shortcut labels cannot contain control characters',
      ),
    data: z.string().min(1).max(64),
    custom: z.boolean().default(false),
  })
  .strict();

const terminalShortcutButtonsSchema = z
  .array(terminalShortcutButtonSchema)
  .max(96)
  .superRefine((buttons, context) => {
    const ids = new Set<string>();
    for (const [index, button] of buttons.entries()) {
      if (ids.has(button.id))
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: 'Shortcut button IDs must be unique',
        });
      ids.add(button.id);
    }
  });

const shortcutEscape = '\u001b';
const shortcutControl = (letter: string) => String.fromCharCode(letter.charCodeAt(0) - 96);

export const DEFAULT_TERMINAL_SHORTCUT_BUTTONS = [
  { id: 'esc', label: 'Esc', data: shortcutEscape, custom: false },
  { id: 'tab', label: 'Tab', data: '\t', custom: false },
  ...['c', 'v', 'z', 'y', 'a', 'x', 's', 'f', 'r', 'g', 'h', 'n', 'p', 'l'].map((letter) => ({
    id: `ctrl+${letter}`,
    label: `Ctrl+${letter.toUpperCase()}`,
    data: shortcutControl(letter),
    custom: false,
  })),
  { id: 'enter', label: 'Enter', data: '\r', custom: false },
  { id: 'char-58', label: ':', data: ':', custom: false },
  { id: 'arrow-up', label: '↑', data: `${shortcutEscape}[A`, custom: false },
  { id: 'arrow-down', label: '↓', data: `${shortcutEscape}[B`, custom: false },
  { id: 'arrow-left', label: '←', data: `${shortcutEscape}[D`, custom: false },
  { id: 'arrow-right', label: '→', data: `${shortcutEscape}[C`, custom: false },
  ...Array.from({ length: 12 }, (_, index) => {
    const number = index + 1;
    const suffix =
      number <= 4
        ? `O${String.fromCharCode(79 + number)}`
        : `[${[15, 17, 18, 19, 20, 21, 23, 24][number - 5]}~`;
    return {
      id: `f${number}`,
      label: `F${number}`,
      data: `${shortcutEscape}${suffix}`,
      custom: false,
    };
  }),
];

const defaultTerminalSettings = {
  defaultProfileId: null,
  screenReaderMode: false,
  autoReconnectTerminal: false,
  restoreTerminalSessionOnReload: false,
  commandSuggestionsEnabled: false,
  dragDropBehavior: 'ask' as const,
  shortcutBarEnabled: true,
  shortcutBarButtons: DEFAULT_TERMINAL_SHORTCUT_BUTTONS,
  visual: {
    themeId: DEFAULT_TERMINAL_THEME_ID,
    background: DEFAULT_TERMINAL_BACKGROUND,
  },
};

const terminalSettingsSchema = z
  .object({
    defaultProfileId: idSchema.nullable(),
    screenReaderMode: z.boolean(),
    autoReconnectTerminal: z.boolean(),
    restoreTerminalSessionOnReload: z.boolean(),
    commandSuggestionsEnabled: z.boolean(),
    dragDropBehavior: z.enum(['ask', 'upload', 'path-insert']),
    shortcutBarEnabled: z.boolean(),
    shortcutBarButtons: terminalShortcutButtonsSchema,
    visual: terminalVisualSettingsSchema,
  })
  .strict();

const persistedTerminalSettingsSchema = z.preprocess(
  (value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { ...defaultTerminalSettings, ...value }
      : value,
  terminalSettingsSchema,
);

export const fileAddressBookmarkSchema = z
  .object({
    id: idSchema,
    hostId: idSchema.nullable(),
    path: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => value.startsWith('/')),
  })
  .strict();
export const fileManagerColumnSchema = z.enum([
  'name',
  'size',
  'modifiedAt',
  'accessedAt',
  'owner',
  'group',
  'mode',
  'path',
  'extension',
]);
const fileManagerSortSchema = z
  .object({
    property: fileManagerColumnSchema,
    direction: z.enum(['asc', 'desc']),
  })
  .strict();
const defaultFileManagerSettings = {
  showHiddenFiles: true,
  externalEditor: '',
  refreshOnFocus: false,
  followTerminalCwd: false,
  sshSplitView: false,
  remoteAddressBookmarks: [] as Array<z.infer<typeof fileAddressBookmarkSchema>>,
  columns: ['name', 'size', 'modifiedAt'] as Array<z.infer<typeof fileManagerColumnSchema>>,
  localSort: { property: 'modifiedAt' as const, direction: 'desc' as const },
  remoteSort: { property: 'modifiedAt' as const, direction: 'desc' as const },
};
const fileManagerSettingsSchema = z
  .object({
    showHiddenFiles: z.boolean(),
    externalEditor: z.string().trim().max(4_096),
    refreshOnFocus: z.boolean(),
    followTerminalCwd: z.boolean(),
    sshSplitView: z.boolean(),
    remoteAddressBookmarks: z.array(fileAddressBookmarkSchema).max(64),
    columns: z
      .array(fileManagerColumnSchema)
      .min(1)
      .max(9)
      .refine((columns) => columns[0] === 'name' && new Set(columns).size === columns.length),
    localSort: fileManagerSortSchema,
    remoteSort: fileManagerSortSchema,
  })
  .strict();
const persistedFileManagerSettingsSchema = z.preprocess(
  (value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { ...defaultFileManagerSettings, ...value }
      : value,
  fileManagerSettingsSchema,
);

export const terminalInformationItemSchema = z.enum([
  'sysinfo',
  'cpu',
  'memory',
  'uptime',
  'users',
  'network',
  'disks',
  'activities',
]);
export const remoteMonitorItemSchema = z.enum([
  'hostname',
  'cpu',
  'cpuHistory',
  'memory',
  'upload',
  'download',
  'uptime',
  'users',
  'disks',
]);
export const DEFAULT_TERMINAL_INFORMATION_ITEMS = [
  'sysinfo',
  'uptime',
  'cpu',
  'memory',
  'activities',
  'network',
  'disks',
] as const;
export const DEFAULT_REMOTE_MONITOR_ITEMS = [
  'hostname',
  'cpu',
  'cpuHistory',
  'memory',
  'upload',
  'download',
  'uptime',
  'users',
  'disks',
] as const;
const defaultMonitorSettings = {
  terminalInformationItems: [...DEFAULT_TERMINAL_INFORMATION_ITEMS],
  remoteMonitorBarEnabled: false,
  remoteMonitorBarItems: [...DEFAULT_REMOTE_MONITOR_ITEMS],
};
const monitorSettingsSchema = z
  .object({
    terminalInformationItems: z
      .array(terminalInformationItemSchema)
      .max(terminalInformationItemSchema.options.length)
      .refine((items) => new Set(items).size === items.length),
    remoteMonitorBarEnabled: z.boolean(),
    remoteMonitorBarItems: z
      .array(remoteMonitorItemSchema)
      .max(remoteMonitorItemSchema.options.length)
      .refine((items) => new Set(items).size === items.length),
  })
  .strict();
const persistedMonitorSettingsSchema = z.preprocess(
  (value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { ...defaultMonitorSettings, ...value }
      : value,
  monitorSettingsSchema,
);

export const APP_LANGUAGES = [
  'ar',
  'de',
  'en',
  'es',
  'fr',
  'hu',
  'id',
  'ja',
  'ko',
  'pl',
  'pt-BR',
  'ru',
  'tr',
  'zh-CN',
  'zh-TW',
] as const;
export const appLanguageSchema = z.enum(APP_LANGUAGES);

export const ACTIVITY_RAIL_ITEM_IDS = [
  'newBookmark',
  'quickConnect',
  'bookmarks',
  'terminalThemes',
  'setting',
  'settingSync',
  'widgets',
] as const;
export const activityRailItemSchema = z.enum(ACTIVITY_RAIL_ITEM_IDS);
export const DEFAULT_ACTIVITY_RAIL_ITEMS = [...ACTIVITY_RAIL_ITEM_IDS] as const;
const activityRailItemsSchema = z
  .array(activityRailItemSchema)
  .min(1)
  .max(ACTIVITY_RAIL_ITEM_IDS.length)
  .refine((items) => new Set(items).size === items.length, 'Activity rail items must be unique');
export const startupSessionsSchema = z.union([z.array(idSchema).max(20), idSchema]);

export const settingsSchema = z
  .object({
    appearance: z
      .object({ theme: z.enum(['dark', 'light', 'system']), language: appLanguageSchema })
      .strict(),
    workspace: z
      .object({
        restoreLayout: z.boolean(),
        aiInspectorOpen: z.boolean(),
        layout: workspaceLayoutSchema.optional(),
        namedWorkspaces: z.array(namedWorkspaceSchema).max(20).default([]),
        activeWorkspaceId: idSchema.nullable().default(null),
        startupSessions: startupSessionsSchema.default([]),
        showTabNumber: z.boolean().default(true),
        switchTabOnHover: z.boolean().default(false),
        activityRailItems: activityRailItemsSchema.default([...DEFAULT_ACTIVITY_RAIL_ITEMS]),
      })
      .strict(),
    privacy: z
      .object({
        // Connection metadata is safe to retain by default for recent-session UX.
        // Terminal bytes, commands and authentication material are never part of it.
        connectionHistoryEnabled: z.boolean(),
        // Commands are more sensitive than connection metadata and stay off until
        // the user explicitly enables shell-integration-backed collection.
        commandHistoryEnabled: z.boolean().default(false),
        // Masks host/IP display in shared lists and monitoring surfaces. The
        // canonical connection target remains available to Runtime adapters.
        hideAddresses: z.boolean().default(false),
      })
      .strict()
      .default({
        connectionHistoryEnabled: true,
        commandHistoryEnabled: false,
        hideAddresses: false,
      }),
    network: z
      .object({
        proxy: globalProxySchema,
      })
      .strict()
      .default({ proxy: DEFAULT_GLOBAL_PROXY }),
    shortcuts: shortcutSettingsSchema,
    terminal: persistedTerminalSettingsSchema.default(defaultTerminalSettings),
    fileManager: persistedFileManagerSettingsSchema.default(defaultFileManagerSettings),
    monitor: persistedMonitorSettingsSchema.default(defaultMonitorSettings),
    version: z.number().int().positive(),
  })
  .strict();
export const updateSettingsSchema = z
  .object({
    appearance: settingsSchema.shape.appearance.partial().optional(),
    // Keep this as an explicit sparse patch. Calling `partial()` on the persisted
    // schema would retain field defaults and turn omitted keys into writes.
    workspace: z
      .object({
        restoreLayout: z.boolean().optional(),
        aiInspectorOpen: z.boolean().optional(),
        layout: workspaceLayoutSchema.optional(),
        namedWorkspaces: z.array(namedWorkspaceSchema).max(20).optional(),
        activeWorkspaceId: idSchema.nullable().optional(),
        startupSessions: startupSessionsSchema.optional(),
        showTabNumber: z.boolean().optional(),
        switchTabOnHover: z.boolean().optional(),
        activityRailItems: activityRailItemsSchema.optional(),
      })
      .strict()
      .optional(),
    privacy: z
      .object({
        connectionHistoryEnabled: z.boolean().optional(),
        commandHistoryEnabled: z.boolean().optional(),
        hideAddresses: z.boolean().optional(),
      })
      .strict()
      .optional(),
    network: settingsSchema.shape.network.removeDefault().partial().optional(),
    shortcuts: shortcutSettingsSchema.removeDefault().partial().optional(),
    terminal: terminalSettingsSchema.partial().optional(),
    fileManager: fileManagerSettingsSchema.partial().optional(),
    monitor: monitorSettingsSchema.partial().optional(),
  })
  .strict();

export const credentialKindSchema = z.enum([
  'sshPassword',
  'privateKey',
  'privateKeyPassphrase',
  'sshCertificate',
  'protocolPassword',
  'proxyPassword',
  'aiApiKey',
  'mcpApiKey',
  'syncAccessToken',
  'syncEncryptionPassword',
]);
export const credentialMetadataSchema = z
  .object({
    ref: z.string(),
    kind: credentialKindSchema,
    label: z.string(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    storage: z.literal('local'),
  })
  .strict();
export const createCredentialSchema = z
  .object({
    kind: credentialKindSchema,
    label: z.string().trim().min(1).max(100),
    secret: z.string().min(1).max(131_072),
  })
  .strict();
export const replaceCredentialSchema = z
  .object({ secret: z.string().min(1).max(131_072) })
  .strict();

export const connectionStateSchema = z.enum([
  'created',
  'resolving',
  'connecting',
  'authenticating',
  'ready',
  'reconnecting',
  'closing',
  'closed',
  'failed',
]);
export const connectionSchema = z
  .object({
    id: idSchema,
    hostId: idSchema,
    connectionProfileId: idSchema.optional(),
    state: connectionStateSchema,
    errorCode: z.string().optional(),
    reconnectAttempt: z.number().int().nonnegative(),
    nextReconnectAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export const quickConnectTargetSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    hostname: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65_535).default(22),
    username: z.string().trim().min(1).max(128),
    authType: authTypeSchema.default('agent'),
    proxy: hostProxySchema,
    connectionOptions: sshConnectionOptionsSchema,
  })
  .strict();
export const createConnectionSchema = z
  .object({
    hostId: idSchema.optional(),
    target: quickConnectTargetSchema.optional(),
    connectionProfileId: idSchema.optional(),
    temporarySecret: z.string().max(131_072).optional(),
    temporaryPassphrase: z.string().max(16_384).optional(),
    temporaryCertificate: z.string().max(131_072).optional(),
    temporaryCredentialGrantId: z.string().min(1).max(256).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!!value.hostId === !!value.target)
      context.addIssue({
        code: 'custom',
        message: 'Exactly one of hostId or target is required',
        path: ['hostId'],
      });
  });

export const sshAgentProbeInputSchema = z
  .object({ path: sshAgentPathSchema.removeDefault().optional() })
  .strict();
export const sshAgentStatusSchema = z
  .object({
    platform: z.enum(['windows', 'macos', 'linux', 'other']),
    state: z.enum(['available', 'unavailable', 'invalid']),
    kind: z.enum(['pageant', 'unixSocket', 'windowsPipe']).nullable(),
    endpoint: z.string().max(4_096).nullable(),
    message: z.string().max(256),
  })
  .strict();

const proxyTestEndpointSchema = z.object(proxyEndpointShape).strict();
export const proxyTestRequestSchema = z
  .object({
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('global') }).strict(),
      z.object({ kind: z.literal('host'), hostId: idSchema }).strict(),
      z
        .object({
          kind: z.literal('custom'),
          endpoint: proxyTestEndpointSchema,
          temporaryPassword: z.string().min(1).max(16_384).optional(),
        })
        .strict()
        .superRefine((value, context) => {
          const hasAuthentication = !!value.endpoint.credentialRef || !!value.temporaryPassword;
          if (!!value.endpoint.username !== hasAuthentication)
            context.addIssue({
              code: 'custom',
              message: 'Proxy username requires a saved or temporary password',
              path: ['endpoint', 'credentialRef'],
            });
        }),
    ]),
    target: z
      .object({
        host: z.string().trim().min(1).max(253),
        port: z.number().int().min(1).max(65_535),
      })
      .strict(),
    timeoutMs: z.number().int().min(250).max(30_000).default(10_000),
  })
  .strict();
export const proxyTestResultSchema = z
  .object({
    reachable: z.literal(true),
    protocol: z.enum(['http', 'https', 'socks5', 'socks5h']),
    proxyHost: z.string(),
    proxyPort: z.number().int().min(1).max(65_535),
    target: z.object({ host: z.string(), port: z.number().int() }).strict(),
    latencyMs: z.number().int().nonnegative(),
  })
  .strict();

export const interactionKindSchema = z.enum([
  'unknownHostKey',
  'changedHostKey',
  'keyboardInteractive',
  'temporarySecret',
  'aiApproval',
]);
export const interactionSchema = z
  .object({
    id: idSchema,
    kind: interactionKindSchema,
    connectionId: idSchema.optional(),
    severity: z.enum(['info', 'warning', 'high']),
    title: z.string(),
    detail: z.string(),
    fields: z.array(z.object({ id: z.string(), label: z.string(), secret: z.boolean() }).strict()),
    createdAt: timestampSchema,
  })
  .strict();
export const interactionResponseSchema = z
  .object({
    accepted: z.boolean(),
    remember: z.boolean().default(false),
    values: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const terminalProfileSchema = z
  .object({
    ...entityFields,
    name: z.string().trim().min(1).max(100),
    shell: z.string().trim().min(1).max(4096).nullable(),
    shellArgs: z.array(z.string().max(4096)).max(64).default([]),
    cwd: z.string().trim().min(1).max(4096).nullable(),
    loginShell: z.boolean().default(false),
    env: terminalEnvironmentSchema.default({}),
    term: terminalTypeSchema.default(DEFAULT_TERMINAL_TYPE),
    lang: terminalLangSchema.nullable().default(null),
    fontFamily: terminalAppearanceSchema.shape.fontFamily.default(
      DEFAULT_TERMINAL_APPEARANCE.fontFamily,
    ),
    fontSize: terminalAppearanceSchema.shape.fontSize.default(DEFAULT_TERMINAL_APPEARANCE.fontSize),
    lineHeight: terminalAppearanceSchema.shape.lineHeight.default(
      DEFAULT_TERMINAL_APPEARANCE.lineHeight,
    ),
    cursorStyle: terminalAppearanceSchema.shape.cursorStyle.default(
      DEFAULT_TERMINAL_APPEARANCE.cursorStyle,
    ),
    cursorBlink: terminalAppearanceSchema.shape.cursorBlink.default(
      DEFAULT_TERMINAL_APPEARANCE.cursorBlink,
    ),
    scrollback: terminalBehaviorSchema.shape.scrollback.default(
      DEFAULT_TERMINAL_BEHAVIOR.scrollback,
    ),
    rendererPreference: terminalBehaviorSchema.shape.rendererPreference.default(
      DEFAULT_TERMINAL_BEHAVIOR.rendererPreference,
    ),
    unicodeVersion: terminalBehaviorSchema.shape.unicodeVersion.default(
      DEFAULT_TERMINAL_BEHAVIOR.unicodeVersion,
    ),
    ligaturesEnabled: terminalBehaviorSchema.shape.ligaturesEnabled.default(
      DEFAULT_TERMINAL_BEHAVIOR.ligaturesEnabled,
    ),
    imageSequencesEnabled: terminalBehaviorSchema.shape.imageSequencesEnabled.default(
      DEFAULT_TERMINAL_BEHAVIOR.imageSequencesEnabled,
    ),
    wordSeparator: terminalBehaviorSchema.shape.wordSeparator.default(
      DEFAULT_TERMINAL_BEHAVIOR.wordSeparator,
    ),
    backspaceMode: terminalBehaviorSchema.shape.backspaceMode.default(
      DEFAULT_TERMINAL_BEHAVIOR.backspaceMode,
    ),
    shiftEnterMode: terminalBehaviorSchema.shape.shiftEnterMode.default(
      DEFAULT_TERMINAL_BEHAVIOR.shiftEnterMode,
    ),
    encoding: terminalBehaviorSchema.shape.encoding.default(DEFAULT_TERMINAL_BEHAVIOR.encoding),
    displayRaw: terminalBehaviorSchema.shape.displayRaw.default(
      DEFAULT_TERMINAL_BEHAVIOR.displayRaw,
    ),
    logTimestamps: terminalBehaviorSchema.shape.logTimestamps.default(
      DEFAULT_TERMINAL_BEHAVIOR.logTimestamps,
    ),
    pasteProtection: z.boolean().default(DEFAULT_TERMINAL_BEHAVIOR.pasteProtection),
    osc52Enabled: z.boolean().default(DEFAULT_TERMINAL_BEHAVIOR.osc52Enabled),
    osc52ReadPolicy: terminalClipboardAccessPolicySchema.default(
      DEFAULT_TERMINAL_BEHAVIOR.osc52ReadPolicy,
    ),
    osc52WritePolicy: terminalClipboardAccessPolicySchema.default(
      DEFAULT_TERMINAL_BEHAVIOR.osc52WritePolicy,
    ),
  })
  .strict();
export const terminalProfileInputSchema = z
  .object({
    name: terminalProfileSchema.shape.name,
    shell: terminalProfileSchema.shape.shell.default(null),
    shellArgs: terminalProfileSchema.shape.shellArgs,
    cwd: terminalProfileSchema.shape.cwd.default(null),
    loginShell: terminalProfileSchema.shape.loginShell,
    env: terminalProfileSchema.shape.env,
    term: terminalProfileSchema.shape.term,
    lang: terminalProfileSchema.shape.lang,
    fontFamily: terminalProfileSchema.shape.fontFamily.default(
      DEFAULT_TERMINAL_APPEARANCE.fontFamily,
    ),
    fontSize: terminalProfileSchema.shape.fontSize.default(DEFAULT_TERMINAL_APPEARANCE.fontSize),
    lineHeight: terminalProfileSchema.shape.lineHeight.default(
      DEFAULT_TERMINAL_APPEARANCE.lineHeight,
    ),
    cursorStyle: terminalProfileSchema.shape.cursorStyle.default(
      DEFAULT_TERMINAL_APPEARANCE.cursorStyle,
    ),
    cursorBlink: terminalProfileSchema.shape.cursorBlink.default(
      DEFAULT_TERMINAL_APPEARANCE.cursorBlink,
    ),
    scrollback: terminalProfileSchema.shape.scrollback,
    rendererPreference: terminalProfileSchema.shape.rendererPreference,
    unicodeVersion: terminalProfileSchema.shape.unicodeVersion,
    ligaturesEnabled: terminalProfileSchema.shape.ligaturesEnabled,
    imageSequencesEnabled: terminalProfileSchema.shape.imageSequencesEnabled,
    wordSeparator: terminalProfileSchema.shape.wordSeparator,
    backspaceMode: terminalProfileSchema.shape.backspaceMode,
    shiftEnterMode: terminalProfileSchema.shape.shiftEnterMode,
    encoding: terminalProfileSchema.shape.encoding,
    displayRaw: terminalProfileSchema.shape.displayRaw,
    logTimestamps: terminalProfileSchema.shape.logTimestamps,
    pasteProtection: terminalProfileSchema.shape.pasteProtection,
    osc52Enabled: terminalProfileSchema.shape.osc52Enabled,
    osc52ReadPolicy: terminalProfileSchema.shape.osc52ReadPolicy,
    osc52WritePolicy: terminalProfileSchema.shape.osc52WritePolicy,
  })
  .strict();
export const terminalProfilePatchSchema = z
  .object({
    name: terminalProfileSchema.shape.name.optional(),
    shell: terminalProfileSchema.shape.shell.optional(),
    shellArgs: z.array(z.string().max(4096)).max(64).optional(),
    cwd: terminalProfileSchema.shape.cwd.optional(),
    loginShell: z.boolean().optional(),
    env: terminalEnvironmentSchema.optional(),
    term: terminalTypeSchema.optional(),
    lang: terminalLangSchema.nullable().optional(),
    fontFamily: terminalAppearanceSchema.shape.fontFamily.optional(),
    fontSize: terminalAppearanceSchema.shape.fontSize.optional(),
    lineHeight: terminalAppearanceSchema.shape.lineHeight.optional(),
    cursorStyle: terminalAppearanceSchema.shape.cursorStyle.optional(),
    cursorBlink: terminalAppearanceSchema.shape.cursorBlink.optional(),
    scrollback: terminalScrollbackSchema.optional(),
    rendererPreference: terminalRendererPreferenceSchema.optional(),
    unicodeVersion: terminalUnicodeVersionSchema.optional(),
    ligaturesEnabled: z.boolean().optional(),
    imageSequencesEnabled: z.boolean().optional(),
    wordSeparator: terminalWordSeparatorSchema.optional(),
    backspaceMode: terminalBackspaceModeSchema.optional(),
    shiftEnterMode: terminalShiftEnterModeSchema.optional(),
    encoding: terminalEncodingSchema.optional(),
    displayRaw: z.boolean().optional(),
    logTimestamps: z.boolean().optional(),
    pasteProtection: z.boolean().optional(),
    osc52Enabled: z.boolean().optional(),
    osc52ReadPolicy: terminalClipboardAccessPolicySchema.optional(),
    osc52WritePolicy: terminalClipboardAccessPolicySchema.optional(),
  })
  .strict();
export const terminalRecordingSchema = z
  .object({
    terminalId: idSchema,
    state: z.enum(['active', 'stopped', 'error']),
    fileName: z.string().min(1).max(255),
    timestamps: z.boolean(),
    bytesWritten: z.number().int().nonnegative(),
    startedAt: timestampSchema,
    stoppedAt: timestampSchema.optional(),
    errorCode: z.string().max(100).optional(),
  })
  .strict();
export const startTerminalRecordingSchema = z
  .object({
    grantId: z.string().min(1).max(256),
    timestamps: z.boolean().default(false),
    includeRecent: z.boolean().default(true),
  })
  .strict();
export const terminalTransferProtocolSchema = z.enum(['zmodem', 'xmodem', 'trzsz']);
export const terminalTransferDirectionSchema = z.enum(['upload', 'download']);
export const terminalTransferStateSchema = z
  .object({
    terminalId: idSchema,
    protocol: terminalTransferProtocolSchema,
    direction: terminalTransferDirectionSchema,
    state: z.enum([
      'waiting-selection',
      'waiting-peer',
      'transferring',
      'completed',
      'failed',
      'canceled',
    ]),
    selection: z.enum(['file', 'directory']).optional(),
    fileName: z.string().max(255).optional(),
    fileCount: z.number().int().min(0).max(10_000).optional(),
    transferredBytes: z.number().int().nonnegative().optional(),
    totalBytes: z.number().int().nonnegative().optional(),
    speedBytesPerSecond: z.number().int().nonnegative().optional(),
    errorCode: z.string().max(100).optional(),
    updatedAt: timestampSchema,
  })
  .strict();
export const terminalTransferActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('start'),
      protocol: z.literal('xmodem'),
      direction: terminalTransferDirectionSchema,
      grantId: z.string().min(1).max(256),
      fileName: z.string().trim().min(1).max(255).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('provide-selection'),
      protocol: z.enum(['zmodem', 'trzsz']),
      grantId: z.string().min(1).max(256),
    })
    .strict(),
  z.object({ action: z.literal('cancel') }).strict(),
]);
export const terminalSessionSchema = z
  .object({
    id: idSchema,
    kind: z.enum(['local', 'ssh', 'telnet', 'serial']),
    title: z.string(),
    state: z.enum(['opening', 'ready', 'closed', 'failed']),
    connectionId: idSchema.optional(),
    bookmarkId: idSchema.optional(),
    profileId: idSchema.optional(),
    appearance: terminalAppearanceSchema.default(DEFAULT_TERMINAL_APPEARANCE),
    behavior: terminalBehaviorSchema.default(DEFAULT_TERMINAL_BEHAVIOR),
    recording: terminalRecordingSchema.optional(),
    exitCode: z.number().int().nullable().optional(),
    createdAt: timestampSchema,
  })
  .strict();
export const terminalInformationGroupNameSchema = terminalInformationItemSchema;
export const terminalInformationGroupStateSchema = z.enum([
  'ready',
  'stale',
  'unsupported',
  'error',
]);
const terminalInformationGroupSchema = <T extends z.ZodType>(data: T) =>
  z
    .object({
      state: terminalInformationGroupStateSchema,
      updatedAt: timestampSchema.nullable(),
      errorCode: z.string().max(64).nullable(),
      data: data.nullable(),
    })
    .strict();
export const terminalSystemInformationSchema = z
  .object({
    os: z.string().max(256),
    hostname: z.string().max(255),
    kernel: z.string().max(256),
    arch: z.string().max(64),
    shell: z.string().max(128),
  })
  .strict();
export const terminalMemoryInformationSchema = z
  .object({
    totalBytes: z.number().nonnegative(),
    availableBytes: z.number().nonnegative(),
    usedBytes: z.number().nonnegative(),
    swapTotalBytes: z.number().nonnegative().nullable(),
    swapUsedBytes: z.number().nonnegative().nullable(),
    percent: z.number().min(0).max(100),
  })
  .strict();
export const terminalUptimeInformationSchema = z
  .object({ seconds: z.number().nonnegative(), bootTime: timestampSchema.nullable() })
  .strict();
export const terminalNetworkInterfaceSchema = z
  .object({
    name: z.string().max(128),
    state: z.string().max(32).nullable(),
    ipv4: z.string().max(64).nullable(),
    receivedBytes: z.number().int().nonnegative().nullable(),
    transmittedBytes: z.number().int().nonnegative().nullable(),
    receiveRate: z.number().nonnegative().nullable(),
    transmitRate: z.number().nonnegative().nullable(),
  })
  .strict();
export const terminalNetworkInformationSchema = z
  .object({
    defaultInterface: z.string().max(128).nullable(),
    interfaces: z.array(terminalNetworkInterfaceSchema).max(32),
  })
  .strict();
export const terminalUserSessionSchema = z
  .object({
    username: z.string().max(128),
    terminal: z.string().max(128),
    startedAt: z.string().max(128),
    source: z.string().max(255).nullable(),
  })
  .strict();
export const terminalUsersInformationSchema = z
  .object({
    users: z.array(z.string().max(128)).max(64),
    sessions: z.array(terminalUserSessionSchema).max(64),
  })
  .strict();
export const terminalDiskInformationSchema = z
  .object({
    filesystem: z.string().max(255),
    totalBytes: z.number().int().nonnegative(),
    usedBytes: z.number().int().nonnegative(),
    availableBytes: z.number().int().nonnegative(),
    percent: z.number().min(0).max(100),
    mount: z.string().max(4_096),
  })
  .strict();
export const terminalActivityInformationSchema = z
  .object({
    pid: z.number().int().positive(),
    username: z.string().max(128),
    cpuPercent: z.number().nonnegative(),
    memoryBytes: z.number().int().nonnegative(),
    command: z.string().max(256),
  })
  .strict();
export const terminalInformationSnapshotSchema = z
  .object({
    terminalId: idSchema,
    kind: terminalSessionSchema.shape.kind,
    sampledAt: timestampSchema,
    cpuHistory: z
      .array(z.object({ sampledAt: timestampSchema, percent: z.number().min(0).max(100) }).strict())
      .max(60),
    groups: z
      .object({
        sysinfo: terminalInformationGroupSchema(terminalSystemInformationSchema),
        cpu: terminalInformationGroupSchema(z.number().min(0).max(100)),
        memory: terminalInformationGroupSchema(terminalMemoryInformationSchema),
        uptime: terminalInformationGroupSchema(terminalUptimeInformationSchema),
        users: terminalInformationGroupSchema(terminalUsersInformationSchema),
        network: terminalInformationGroupSchema(terminalNetworkInformationSchema),
        disks: terminalInformationGroupSchema(z.array(terminalDiskInformationSchema).max(64)),
        activities: terminalInformationGroupSchema(
          z.array(terminalActivityInformationSchema).max(50),
        ),
      })
      .strict(),
  })
  .strict();
export const createTerminalSchema = z
  .object({
    kind: z.enum(['local', 'ssh', 'telnet', 'serial']),
    connectionId: idSchema.optional(),
    bookmarkId: idSchema.optional(),
    profileId: idSchema.optional(),
    environment: z
      .record(
        z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        z
          .string()
          .max(4_096)
          .refine((value) => !/[\r\n\0]/.test(value)),
      )
      .refine(
        (value) => Object.keys(value).length <= 64,
        'At most 64 environment values are allowed',
      )
      .optional(),
    workingDirectory: z
      .discriminatedUnion('scope', [
        z
          .object({
            scope: z.literal('local'),
            grantId: z.string().min(1).max(256),
            path: z
              .string()
              .max(4_096)
              .refine(
                (value) =>
                  !value.startsWith('/') &&
                  !value.startsWith('\\') &&
                  !value.includes('\\') &&
                  !value.includes('\0') &&
                  value
                    .split('/')
                    .every((segment) => segment !== '.' && segment !== '..' && !!segment),
                'Expected a portable path relative to the granted directory',
              )
              .or(z.literal('')),
          })
          .strict(),
        z
          .object({
            scope: z.literal('remote'),
            path: z
              .string()
              .min(1)
              .max(4_096)
              .refine((value) => value.startsWith('/'), 'Remote path must be absolute'),
          })
          .strict(),
      ])
      .optional(),
    cols: z.number().int().min(2).max(500).default(80),
    rows: z.number().int().min(2).max(300).default(24),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === 'ssh' && !value.connectionId)
      context.addIssue({ code: 'custom', message: 'SSH terminals require a connectionId' });
    if ((value.kind === 'telnet' || value.kind === 'serial') && !value.bookmarkId)
      context.addIssue({
        code: 'custom',
        message: `${value.kind} terminals require a bookmarkId`,
      });
    if (value.kind !== 'ssh' && value.connectionId)
      context.addIssue({ code: 'custom', message: 'Only SSH terminals use a connectionId' });
    if (value.kind !== 'ssh' && value.environment)
      context.addIssue({
        code: 'custom',
        message: 'Only SSH terminals accept command-line environment values',
        path: ['environment'],
      });
    if (
      value.kind !== 'ssh' &&
      value.kind !== 'telnet' &&
      value.kind !== 'serial' &&
      value.bookmarkId
    )
      context.addIssue({
        code: 'custom',
        message: 'Only SSH, Telnet or Serial terminals use a bookmarkId',
      });
    if (
      value.workingDirectory &&
      value.workingDirectory.scope !==
        (value.kind === 'local' ? 'local' : value.kind === 'ssh' ? 'remote' : undefined)
    )
      context.addIssue({
        code: 'custom',
        message: 'Terminal kind and working-directory scope must match',
        path: ['workingDirectory', 'scope'],
      });
  });
export const TERMINAL_INPUT_FRAME_MAX_BYTES = 64 * 1024;
export const TERMINAL_REPLAY_MAX_BYTES = 128 * 1024;
export const TERMINAL_CLIENT_PROTOCOL_PREFIX = 'terminal-client.';
export const terminalControlSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('resize'),
      cols: z.number().int().min(2).max(500),
      rows: z.number().int().min(2).max(300),
    })
    .strict(),
  z.object({ type: z.literal('signal'), signal: z.enum(['SIGINT', 'SIGTERM', 'SIGHUP']) }).strict(),
  z.object({ type: z.literal('ping'), nonce: z.string().max(128) }).strict(),
  z.object({ type: z.literal('close') }).strict(),
]);
export const terminalServerControlSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }).strict(),
  z
    .object({
      type: z.literal('status'),
      state: z.enum(['opening', 'ready', 'closed', 'failed', 'reconnecting', 'stale']),
    })
    .strict(),
  z
    .object({
      type: z.literal('replay'),
      firstSequence: z.number().int().positive().optional(),
      lastSequence: z.number().int().nonnegative(),
      byteLength: z.number().int().nonnegative().max(TERMINAL_REPLAY_MAX_BYTES),
      truncated: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal('exit'), exitCode: z.number().int().nullable() }).strict(),
  z
    .object({
      type: z.literal('error'),
      code: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .regex(/^[A-Z][A-Z0-9_]*$/),
    })
    .strict(),
  z.object({ type: z.literal('pong'), nonce: z.string().max(128) }).strict(),
  z
    .object({
      type: z.literal('shellIntegration'),
      state: z.enum(['pending', 'active', 'unavailable']),
    })
    .strict(),
  z.object({ type: z.literal('recording'), recording: terminalRecordingSchema }).strict(),
  z.object({ type: z.literal('transfer'), transfer: terminalTransferStateSchema }).strict(),
]);

export const remotePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith('/'), 'Remote path must be absolute');
export const ftpConnectionSchema = z
  .object({
    id: idSchema,
    bookmarkId: idSchema,
    name: z.string().trim().min(1).max(100),
    hostname: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65_535),
    username: z.string().trim().min(1).max(128),
    security: z.enum(['plain', 'explicit-tls', 'implicit-tls']),
    encoding: z.enum(['utf-8', 'gbk', 'gb18030', 'big5', 'shift-jis', 'euc-jp', 'euc-kr']),
    initialDirectory: remotePathSchema,
    state: z.enum(['connecting', 'ready', 'closing', 'closed', 'failed']),
    errorCode: z.string().optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export const createFtpConnectionSchema = z.object({ bookmarkId: idSchema }).strict();
export const serialPortInfoSchema = z
  .object({
    path: z.string().min(1).max(1_024),
    manufacturer: z.string().max(512).optional(),
    serialNumber: z.string().max(512).optional(),
    pnpId: z.string().max(1_024).optional(),
    locationId: z.string().max(512).optional(),
    vendorId: z.string().max(64).optional(),
    productId: z.string().max(64).optional(),
  })
  .strict();
export const rdpSessionSchema = z
  .object({
    id: idSchema,
    bookmarkId: idSchema,
    title: z.string().min(1).max(100),
    state: z.enum(['created', 'attached', 'ready', 'closed', 'failed']),
    width: z.number().int().min(320).max(8_192),
    height: z.number().int().min(240).max(4_320),
    scaleViewport: z.boolean(),
    clipboard: z.boolean(),
    errorCode: z.string().max(100).optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export const createRdpSessionSchema = z
  .object({
    bookmarkId: idSchema,
    width: z.number().int().min(320).max(8_192).optional(),
    height: z.number().int().min(240).max(4_320).optional(),
    temporaryPassword: z.string().max(16_384).optional(),
  })
  .strict();
export const rdpCredentialBootstrapSchema = z
  .object({
    username: z.string().min(1).max(128),
    password: z.string().max(16_384),
    domain: z.string().max(128),
    destination: z.string().min(1).max(320),
  })
  .strict();
export const resizeRdpSessionSchema = z
  .object({
    width: z.number().int().min(320).max(8_192),
    height: z.number().int().min(240).max(4_320),
  })
  .strict();
export const RDP_FRAME_MAX_BYTES = 4 * 1024 * 1024;
export const vncSessionSchema = z
  .object({
    id: idSchema,
    bookmarkId: idSchema,
    title: z.string().min(1).max(100),
    state: z.enum(['created', 'connecting', 'ready', 'closed', 'failed']),
    viewOnly: z.boolean(),
    clipViewport: z.boolean(),
    scaleViewport: z.boolean(),
    qualityLevel: z.number().int().min(0).max(9),
    compressionLevel: z.number().int().min(0).max(9),
    shared: z.boolean(),
    showDotCursor: z.boolean(),
    clipboard: z.boolean(),
    errorCode: z.string().max(100).optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export const createVncSessionSchema = z
  .object({
    bookmarkId: idSchema,
    temporaryPassword: z.string().max(16_384).optional(),
  })
  .strict();
export const vncCredentialBootstrapSchema = z
  .object({
    username: z.string().max(128),
    password: z.string().max(16_384),
  })
  .strict();
export const VNC_FRAME_MAX_BYTES = 4 * 1024 * 1024;
export const spiceSessionSchema = z
  .object({
    id: idSchema,
    bookmarkId: idSchema,
    title: z.string().min(1).max(100),
    state: z.enum(['created', 'connecting', 'ready', 'closed', 'failed']),
    viewOnly: z.boolean(),
    scaleViewport: z.boolean(),
    activeChannels: z.number().int().nonnegative().max(16),
    errorCode: z.string().max(100).optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export const createSpiceSessionSchema = z
  .object({
    bookmarkId: idSchema,
    temporaryPassword: z.string().max(16_384).optional(),
  })
  .strict();
export const spiceCredentialBootstrapSchema = z
  .object({ password: z.string().max(16_384) })
  .strict();
export const SPICE_FRAME_MAX_BYTES = 4 * 1024 * 1024;
export const webSessionBoundsSchema = z
  .object({
    x: z.number().int().min(0).max(32_768),
    y: z.number().int().min(0).max(32_768),
    width: z.number().int().min(1).max(32_768),
    height: z.number().int().min(1).max(32_768),
  })
  .strict();
export const webSessionSchema = z
  .object({
    id: idSchema,
    bookmarkId: idSchema,
    title: z.string().min(1).max(100),
    description: z.string().max(2_000),
    state: z.enum(['created', 'loading', 'ready', 'auth-required', 'failed']),
    url: z.url().max(4_096),
    currentUrl: z.url().max(4_096),
    userAgent: z.string().max(512).nullable(),
    hideAddressBar: z.boolean(),
    loading: z.boolean(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    zoomFactor: z.number().min(0.25).max(5),
    visible: z.boolean(),
    blockedUrl: z.url().max(4_096).optional(),
    errorCode: z.string().max(100).optional(),
    authChallenge: z
      .object({
        id: idSchema,
        host: z.string().max(253),
        realm: z.string().max(512).optional(),
        isProxy: z.boolean(),
      })
      .strict()
      .optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export const createWebSessionSchema = z.object({ bookmarkId: idSchema }).strict();
export const webSessionPresentationSchema = z
  .object({ bounds: webSessionBoundsSchema.optional(), visible: z.boolean().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Expected a presentation change');
export const webSessionActionSchema = z
  .object({
    action: z.enum([
      'back',
      'forward',
      'reload',
      'stop',
      'set-zoom',
      'open-external',
      'open-blocked-external',
    ]),
    zoomFactor: z.number().min(0.25).max(5).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === 'set-zoom' && value.zoomFactor === undefined)
      context.addIssue({
        code: 'custom',
        path: ['zoomFactor'],
        message: 'Zoom factor is required',
      });
    if (value.action !== 'set-zoom' && value.zoomFactor !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['zoomFactor'],
        message: 'Zoom factor is only valid for set-zoom',
      });
  });
export const webSessionAuthResponseSchema = z
  .object({
    challengeId: idSchema,
    username: z.string().max(1_024),
    password: z.string().max(16_384),
  })
  .strict();
export const deepLinkProtocolSchema = z.enum([
  'local',
  'ssh',
  'telnet',
  'vnc',
  'rdp',
  'spice',
  'serial',
  'ftp',
  'http',
  'https',
]);
export const enqueueDeepLinkSchema = z
  .object({ source: z.string().trim().min(1).max(16_384) })
  .strict();
export const deepLinkReceiptSchema = z
  .object({
    id: idSchema,
    status: z.enum(['ready', 'rejected']),
    protocol: deepLinkProtocolSchema.optional(),
    errorCode: z.string().max(100).optional(),
    receivedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict();
export const deepLinkIntentSchema = deepLinkReceiptSchema
  .extend({ source: z.string().max(16_384).optional() })
  .superRefine((value, context) => {
    if (value.status === 'ready' && (!value.protocol || !value.source))
      context.addIssue({
        code: 'custom',
        message: 'A ready deep link requires protocol and source',
      });
    if (value.status === 'rejected' && (!value.errorCode || value.source || value.protocol))
      context.addIssue({
        code: 'custom',
        message: 'A rejected deep link contains only a safe error code',
      });
  });
export const nextDeepLinkIntentSchema = deepLinkIntentSchema.nullable();
export const remoteFileEntrySchema = z
  .object({
    name: z.string(),
    path: remotePathSchema,
    type: z.enum(['file', 'directory', 'symlink', 'other']),
    size: z.number().int().nonnegative(),
    mode: z.number().int().nonnegative().optional(),
    modifiedAt: timestampSchema.optional(),
    accessedAt: timestampSchema.optional(),
    owner: z.string().optional(),
    group: z.string().optional(),
    revision: z.string(),
  })
  .strict();
export const pathInputSchema = z.object({ path: remotePathSchema }).strict();
export const renamePathSchema = z.object({ from: remotePathSchema, to: remotePathSchema }).strict();
export const chmodPathSchema = z
  .object({ path: remotePathSchema, mode: z.number().int().min(0).max(0o7777) })
  .strict();
export const remoteTextSchema = z
  .object({
    path: remotePathSchema,
    content: z.string().max(2 * 1024 * 1024),
    revision: z.string(),
    lineEnding: z.enum(['lf', 'crlf']),
  })
  .strict();
export const writeRemoteTextSchema = remoteTextSchema
  .extend({ overwriteRevision: z.string() })
  .omit({ revision: true })
  .strict();
export const externalEditorStateSchema = z.enum([
  'watching',
  'changed',
  'saved',
  'conflict',
  'error',
]);
export const externalEditorSessionSchema = z
  .object({
    id: idSchema,
    connectionId: idSchema,
    remotePath: remotePathSchema,
    fileName: z.string().min(1).max(255),
    state: externalEditorStateSchema,
    message: z.string().max(500).optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict();
export const createExternalEditorSchema = z.object({ path: remotePathSchema }).strict();
export type ExternalEditorSession = z.infer<typeof externalEditorSessionSchema>;
const comparisonLocalPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.startsWith('\\') &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      value.split('/').every((segment) => segment !== '.' && segment !== '..' && !!segment),
    'Expected a portable path relative to the granted directory',
  );
export const fileComparisonSourceSchema = z.discriminatedUnion('scope', [
  z
    .object({
      scope: z.literal('local'),
      grantId: z.string().min(1).max(256),
      path: comparisonLocalPathSchema,
    })
    .strict(),
  z
    .object({
      scope: z.literal('remote'),
      connectionId: idSchema,
      path: remotePathSchema,
    })
    .strict(),
]);
export const createFileComparisonSchema = z
  .object({ left: fileComparisonSourceSchema, right: fileComparisonSourceSchema })
  .strict();
export const fileComparisonEntrySchema = z
  .object({
    scope: z.enum(['local', 'remote']),
    name: z.string().min(1).max(1_024),
    path: z.string().min(1).max(4_096),
    size: z.number().int().nonnegative(),
    mode: z.number().int().nonnegative().optional(),
    modifiedAt: timestampSchema.optional(),
    accessedAt: timestampSchema.optional(),
    owner: z.string().optional(),
    group: z.string().optional(),
    content: z
      .string()
      .max(2 * 1024 * 1024)
      .optional(),
    lineCount: z.number().int().nonnegative().max(10_000).optional(),
  })
  .strict();
export const fileComparisonSchema = z
  .object({
    status: z.enum(['equal', 'different', 'unsupported', 'too-large']),
    reason: z.enum(['binary', 'directory', 'too-many-bytes', 'too-many-lines']).optional(),
    left: fileComparisonEntrySchema,
    right: fileComparisonEntrySchema,
  })
  .strict();
export type FileComparisonSource = z.infer<typeof fileComparisonSourceSchema>;
export type CreateFileComparison = z.infer<typeof createFileComparisonSchema>;
export type FileComparison = z.infer<typeof fileComparisonSchema>;
export const conflictStrategySchema = z.enum(['skip', 'overwrite', 'rename']);
export const transferConflictPolicySchema = z.enum(['skip', 'overwrite', 'rename', 'ask']);
export const transferConflictDecisionSchema = z
  .object({
    strategy: conflictStrategySchema,
    applyToAll: z.boolean().default(false),
  })
  .strict();
export const remoteEntriesOperationRequestSchema = z
  .object({
    paths: z.array(remotePathSchema).min(1).max(1_000),
    destination: remotePathSchema,
    operation: z.enum(['copy', 'move']),
    conflict: conflictStrategySchema.default('rename'),
  })
  .strict();
export type RemoteEntriesOperationRequest = z.infer<typeof remoteEntriesOperationRequestSchema>;
export const createTransferSchema = z
  .object({
    connectionId: idSchema,
    direction: z.enum(['upload', 'download']),
    grantId: z.string().min(1),
    localPath: z
      .string()
      .min(1)
      .max(4_096)
      .refine(
        (value) =>
          !value.startsWith('/') &&
          !value.startsWith('\\') &&
          !value.includes('\\') &&
          !value.includes('\0') &&
          value.split('/').every((segment) => segment !== '.' && segment !== '..' && !!segment),
        'Expected a portable path relative to the granted directory',
      )
      .optional(),
    remotePath: remotePathSchema,
    recursive: z.boolean().default(false),
    archive: z.boolean().default(false),
    conflict: transferConflictPolicySchema.default('skip'),
  })
  .strict();
export const transferRouteInputSchema = createTransferSchema
  .omit({ connectionId: true, direction: true })
  .strict();
export const remoteCopyTransferRouteInputSchema = z
  .object({
    sourceConnectionId: idSchema,
    targetConnectionId: idSchema,
    sourcePath: remotePathSchema,
    targetPath: remotePathSchema,
    recursive: z.boolean().default(false),
    conflict: transferConflictPolicySchema.default('skip'),
  })
  .strict();
export const fileGrantRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['open-file', 'open-directory', 'save-file']) }).strict(),
  z.object({ kind: z.literal('home-directory') }).strict(),
  z
    .object({
      kind: z.literal('directory-path'),
      path: z.string().trim().min(1).max(4_096),
    })
    .strict(),
]);
export const droppedFileImportHeadersSchema = z
  .object({
    'X-Axterm-File-Name': z.string().min(1).max(1_024),
    'X-Axterm-File-Size': z.coerce
      .number()
      .int()
      .min(0)
      .max(4 * 1024 * 1024 * 1024),
  })
  .strict();
export const insertGrantedPathsSchema = z
  .object({ grantIds: z.array(z.string().min(1).max(256)).min(1).max(32) })
  .strict();
export const insertGrantedPathsResultSchema = z
  .object({ inserted: z.number().int().min(1).max(32) })
  .strict();
export const transferSchema = z
  .object({
    id: idSchema,
    connectionId: idSchema,
    direction: z.enum(['upload', 'download', 'remote-copy']),
    state: z.enum([
      'queued',
      'preparing',
      'running',
      'paused',
      'awaiting-decision',
      'succeeded',
      'failed',
      'canceled',
    ]),
    bytesTransferred: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative().optional(),
    bytesPerSecond: z.number().nonnegative().optional(),
    errorCode: z.string().optional(),
    source: z.string().max(8_192).optional(),
    destination: z.string().max(8_192).optional(),
    conflict: z
      .object({
        path: z.string().min(1).max(4_096),
        type: z.enum(['file', 'directory', 'unknown']),
      })
      .strict()
      .optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export const clearTransfersResultSchema = z
  .object({ cleared: z.number().int().nonnegative() })
  .strict();

export const quickCommandStepSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().max(100),
    command: z.string().min(1).max(16_384),
    delayMs: z.number().int().min(1).max(65_535),
  })
  .strict();
export const quickCommandSchema = z
  .object({
    ...entityFields,
    groupId: idSchema.nullable(),
    position: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(60),
    command: z.string().min(1).max(16_384),
    commands: z.array(quickCommandStepSchema).min(1).max(32),
    description: z.string().max(2_000),
    tags: z.array(z.string().trim().min(1).max(60)).max(32),
    shortcut: z.string().trim().min(1).max(100).nullable(),
    inputOnly: z.boolean(),
    clickCount: z.number().int().nonnegative(),
  })
  .strict();
export const quickCommandInputSchema = quickCommandSchema
  .omit({ id: true, createdAt: true, updatedAt: true, version: true, position: true })
  .strict();
export const quickCommandPatchSchema = quickCommandInputSchema
  .omit({ groupId: true })
  .partial()
  .strict();
export const quickCommandGroupSchema = z
  .object({
    ...entityFields,
    parentId: idSchema.nullable(),
    name: z.string().trim().min(1).max(60),
    position: z.number().int().nonnegative(),
  })
  .strict();
export const quickCommandTreeSchema = z
  .object({
    revision: z.number().int().positive(),
    etag: z.string().regex(/^"quick-command-tree-v\d+"$/),
    groups: z.array(quickCommandGroupSchema),
    commands: z.array(quickCommandSchema),
  })
  .strict();
export const quickCommandGroupInputSchema = z
  .object({ parentId: idSchema.nullable(), name: z.string().trim().min(1).max(60) })
  .strict();
export const quickCommandGroupPatchSchema = z
  .object({ name: z.string().trim().min(1).max(60) })
  .partial()
  .strict();
export const quickCommandTreeNodeSchema = z
  .object({ kind: z.enum(['group', 'command']), id: idSchema })
  .strict();
export const moveQuickCommandTreeNodeSchema = z
  .object({
    source: quickCommandTreeNodeSchema,
    target: quickCommandTreeNodeSchema,
    position: z.enum(['before', 'inside', 'after']),
  })
  .strict();

export const batchOperationStepInputSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1).max(100),
    command: z.string().min(1).max(16_384),
    delayMs: z.number().int().min(0).max(65_535).default(0),
    continueOnError: z.boolean().default(false),
  })
  .strict();
export const createBatchOperationSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    bookmarkIds: z.array(idSchema).min(1).max(64),
    steps: z.array(batchOperationStepInputSchema).min(1).max(32),
    concurrency: z.number().int().min(1).max(8).default(4),
    connectionTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.bookmarkIds).size !== value.bookmarkIds.length)
      context.addIssue({
        code: 'custom',
        path: ['bookmarkIds'],
        message: 'Bookmark IDs must be unique',
      });
    if (new Set(value.steps.map(({ id }) => id)).size !== value.steps.length)
      context.addIssue({ code: 'custom', path: ['steps'], message: 'Step IDs must be unique' });
  });
export const batchOperationStateSchema = z.enum([
  'queued',
  'running',
  'canceling',
  'succeeded',
  'failed',
  'canceled',
  'interrupted',
]);
export const batchOperationTargetStateSchema = z.enum([
  'queued',
  'connecting',
  'running',
  'succeeded',
  'failed',
  'canceled',
]);
export const batchOperationStepResultSchema = z
  .object({
    stepId: idSchema,
    name: z.string().trim().min(1).max(100),
    state: z.enum(['queued', 'running', 'succeeded', 'failed', 'skipped', 'canceled']),
    exitCode: z.number().int().nullable(),
    errorCode: z.string().max(100).optional(),
    startedAt: timestampSchema.optional(),
    finishedAt: timestampSchema.optional(),
  })
  .strict();
export const batchOperationTargetSchema = z
  .object({
    bookmarkId: idSchema,
    title: z.string().trim().min(1).max(100),
    state: batchOperationTargetStateSchema,
    errorCode: z.string().max(100).optional(),
    steps: z.array(batchOperationStepResultSchema).min(1).max(32),
    startedAt: timestampSchema.optional(),
    finishedAt: timestampSchema.optional(),
  })
  .strict();
export const batchOperationSchema = z
  .object({
    ...entityFields,
    name: z.string().trim().min(1).max(100),
    state: batchOperationStateSchema,
    concurrency: z.number().int().min(1).max(8),
    targetCount: z.number().int().min(1).max(64),
    completedCount: z.number().int().nonnegative().max(64),
    succeededCount: z.number().int().nonnegative().max(64),
    failedCount: z.number().int().nonnegative().max(64),
    canceledCount: z.number().int().nonnegative().max(64),
    targets: z.array(batchOperationTargetSchema).min(1).max(64),
  })
  .strict();
export const clearBatchOperationsResultSchema = z
  .object({ cleared: z.number().int().nonnegative() })
  .strict();

export const widgetIdSchema = z.enum([
  'file-renamer',
  'local-file-server',
  'local-ftp-server',
  'local-ssh-server',
  'mcp-server',
]);
export const widgetDefinitionSchema = z
  .object({
    id: widgetIdSchema,
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(500),
    version: z.string().trim().min(1).max(32),
    type: z.enum(['once', 'instance']),
    builtin: z.literal(true),
    singleInstance: z.boolean(),
  })
  .strict();
export const widgetInstanceStateSchema = z.enum([
  'starting',
  'running',
  'stopping',
  'stopped',
  'failed',
]);
export const widgetServerInfoSchema = z
  .object({
    url: z.url(),
    rootName: z.string().trim().min(1).max(255),
    username: z.string().trim().min(1).max(255).nullable().default(null),
    authentication: z.enum(['none', 'password', 'bearer']).default('none'),
    protocol: z.enum(['http', 'ftp', 'ssh', 'mcp']).optional(),
    protocolVersion: z.string().trim().min(1).max(32).optional(),
    activeSessions: z.number().int().nonnegative().max(32).optional(),
    toolCount: z.number().int().nonnegative().max(64).optional(),
  })
  .strict();
export const widgetInstanceSchema = z
  .object({
    ...entityFields,
    widgetId: widgetIdSchema,
    title: z.string().trim().min(1).max(100),
    state: widgetInstanceStateSchema,
    bindHost: z.string().max(255).nullable(),
    port: z.number().int().min(0).max(65_535).nullable(),
    serverInfo: widgetServerInfoSchema.nullable(),
    ownerGeneration: idSchema,
    errorCode: z.string().max(100).optional(),
  })
  .strict();
export const startLocalFileServerSchema = z
  .object({
    grantId: z.string().min(1).max(256),
    title: z.string().trim().min(1).max(100).default('Static File Server'),
    host: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine(
        (value) =>
          value === 'localhost' ||
          value === '127.0.0.1' ||
          value === '::1' ||
          value === '0.0.0.0' ||
          value === '::',
        'Expected a supported loopback or all-interface bind address',
      )
      .default('127.0.0.1'),
    port: z.number().int().min(0).max(65_535).default(3_456),
    index: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine(
        (value) => !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..',
        'Index must be a file name',
      )
      .default('index.html'),
    dotfiles: z.enum(['allow', 'deny', 'ignore']).default('allow'),
    cacheControl: z.boolean().default(true),
    maxAgeMs: z.number().int().min(0).max(31_536_000_000).default(31_536_000_000),
    lastModified: z.boolean().default(true),
    etag: z.boolean().default(true),
    acceptRanges: z.boolean().default(true),
    redirect: z.boolean().default(true),
  })
  .strict();
export const renameWidgetInstanceSchema = z
  .object({ title: z.string().trim().min(1).max(100) })
  .strict();
const widgetUsernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/[\0\r\n]/u.test(value), 'Username cannot contain control lines');
const widgetPasswordSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !/[\0\r\n]/u.test(value), 'Password cannot contain control lines');
export const startLocalFtpServerSchema = z
  .object({
    grantId: z.string().min(1).max(256),
    title: z.string().trim().min(1).max(100).default('Local FTP Server'),
    host: startLocalFileServerSchema.shape.host.default('127.0.0.1'),
    port: z.number().int().min(0).max(65_535).default(2_121),
    anonymous: z.boolean().default(false),
    username: widgetUsernameSchema.default('ftpuser'),
    password: widgetPasswordSchema.optional(),
    passivePortStart: z.number().int().min(1_024).max(65_535).default(50_000),
    passivePortEnd: z.number().int().min(1_024).max(65_535).default(50_031),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.anonymous && !value.password)
      context.addIssue({
        code: 'custom',
        path: ['password'],
        message: 'Password is required when anonymous login is disabled',
      });
    if (value.passivePortEnd < value.passivePortStart)
      context.addIssue({
        code: 'custom',
        path: ['passivePortEnd'],
        message: 'Passive port end must be greater than or equal to its start',
      });
    if (value.passivePortEnd - value.passivePortStart > 63)
      context.addIssue({
        code: 'custom',
        path: ['passivePortEnd'],
        message: 'Passive port range is limited to 64 ports',
      });
  });
export const startLocalSshServerSchema = z
  .object({
    grantId: z.string().min(1).max(256),
    title: z.string().trim().min(1).max(100).default('SSH Server'),
    host: startLocalFileServerSchema.shape.host.default('127.0.0.1'),
    port: z.number().int().min(0).max(65_535).default(22_225),
    username: widgetUsernameSchema.default('test'),
    password: widgetPasswordSchema,
  })
  .strict();

const registeredAiToolNames = [
  'host.getSummary',
  'terminal.getRecentOutput',
  'terminal.execReadOnly',
  'sftp.list',
  'sftp.readText',
  'system.inspectDisk',
  'system.inspectMemory',
  'system.inspectProcesses',
  'system.inspectService',
  'terminal.exec',
] as const;
export const aiToolNameSchema = z.enum(registeredAiToolNames);
export const startMcpServerSchema = z
  .object({
    title: z.string().trim().min(1).max(100).default('MCP Server'),
    host: z
      .enum(['localhost', '127.0.0.1', '::1'])
      .default('127.0.0.1')
      .describe('MCP servers are restricted to loopback interfaces'),
    port: z.number().int().min(0).max(65_535).default(30_837),
    credentialRef: z.string().min(1).max(256),
    enabledTools: z
      .array(aiToolNameSchema)
      .min(1)
      .max(registeredAiToolNames.length)
      .default([...registeredAiToolNames]),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.enabledTools).size !== value.enabledTools.length)
      context.addIssue({
        code: 'custom',
        path: ['enabledTools'],
        message: 'Enabled MCP tools must be unique',
      });
  });

const fileRenameTemplateSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) => !value.includes('/') && !value.includes('\\'),
    'Template cannot contain paths',
  );
export const previewFileRenameSchema = z
  .object({
    grantId: z.string().min(1).max(256),
    template: fileRenameTemplateSchema.default('{name}-{n}.{ext}'),
    includeSubfolders: z.boolean().default(false),
    fileTypes: z.string().trim().min(1).max(512).default('*'),
    startNumber: z.number().int().min(0).max(1_000_000).default(1),
    preserveCase: z.boolean().default(true),
  })
  .strict();
export const fileRenamePreviewItemSchema = z
  .object({
    source: z.string().min(1).max(4_096),
    target: z.string().min(1).max(4_096),
    state: z.enum(['ready', 'unchanged', 'conflict']),
  })
  .strict();
export const fileRenamePreviewSchema = z
  .object({
    id: idSchema,
    rootName: z.string().trim().min(1).max(255),
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    total: z.number().int().nonnegative().max(1_000),
    ready: z.number().int().nonnegative().max(1_000),
    conflicts: z.number().int().nonnegative().max(1_000),
    canRun: z.boolean(),
    items: z.array(fileRenamePreviewItemSchema).max(1_000),
  })
  .strict();
export const runFileRenameSchema = z.object({ previewId: idSchema }).strict();
export const fileRenameResultSchema = z
  .object({
    previewId: idSchema,
    renamed: z.number().int().nonnegative().max(1_000),
    items: z.array(fileRenamePreviewItemSchema).max(1_000),
    finishedAt: timestampSchema,
  })
  .strict();

export const triggerMatchSchema = z
  .object({
    type: z.enum(['text', 'regex']),
    value: z.string().min(1).max(512),
    caseSensitive: z.boolean().default(false),
  })
  .strict();
export const triggerActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('send'), value: z.string().max(16_384) }).strict(),
  z.object({ type: z.literal('notify'), value: z.literal('') }).strict(),
]);
export const triggerRuleSchema = z
  .object({
    ...entityFields,
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
    match: triggerMatchSchema,
    action: triggerActionSchema,
    sendEnter: z.boolean(),
    mode: z.enum(['repeat', 'once', 'cooldown']),
    cooldownMs: z.number().int().min(0).max(600_000),
  })
  .strict();
export const triggerRuleInputSchema = triggerRuleSchema
  .omit({ id: true, createdAt: true, updatedAt: true, version: true })
  .strict();
export const triggerRulePatchSchema = triggerRuleInputSchema.partial().strict();
export const replaceTriggersSchema = z.array(triggerRuleInputSchema).max(256);
export const triggerCollectionSchema = z
  .object({
    revision: z.number().int().positive(),
    etag: z.string().regex(/^"trigger-list-v\d+"$/),
    triggers: z.array(triggerRuleSchema).max(256),
  })
  .strict();

export const tunnelTypeSchema = z.enum(['local', 'remote', 'dynamic']);
export const tunnelProfileSchema = z
  .object({
    ...entityFields,
    name: z.string(),
    hostId: idSchema,
    type: tunnelTypeSchema,
    bindHost: z.string(),
    bindPort: z.number().int().min(0).max(65_535),
    targetHost: z.string().nullable(),
    targetPort: z.number().int().min(1).max(65_535).nullable(),
    allowNonLoopback: z.boolean(),
  })
  .strict();
const tunnelProfileInputBaseSchema = tunnelProfileSchema
  .omit({ id: true, createdAt: true, updatedAt: true, version: true })
  .strict();
export const tunnelProfileInputSchema = tunnelProfileInputBaseSchema.superRefine(
  (value, context) => {
    if (value.type !== 'dynamic' && (!value.targetHost || !value.targetPort))
      context.addIssue({ code: 'custom', message: 'Forwarding target is required' });
    if (value.type === 'dynamic' && (value.targetHost || value.targetPort))
      context.addIssue({ code: 'custom', message: 'Dynamic tunnels do not use a fixed target' });
    if (
      value.type !== 'remote' &&
      !value.allowNonLoopback &&
      !['127.0.0.1', 'localhost', '::1'].includes(value.bindHost)
    )
      context.addIssue({
        code: 'custom',
        message: 'Non-loopback binding requires explicit opt-in',
      });
  },
);
export const tunnelProfilePatchSchema = tunnelProfileInputBaseSchema.partial().strict();
export const tunnelSchema = z
  .object({
    id: idSchema,
    profileId: idSchema.optional(),
    connectionId: idSchema,
    type: tunnelTypeSchema,
    state: z.enum(['starting', 'active', 'stopping', 'closed', 'failed']),
    bindHost: z.string(),
    bindPort: z.number().int(),
    errorCode: z.string().optional(),
    createdAt: timestampSchema,
  })
  .strict();
export const startTunnelSchema = z
  .object({
    connectionId: idSchema,
    profileId: idSchema.optional(),
    profile: tunnelProfileInputSchema.optional(),
  })
  .strict()
  .refine((value) => !!value.profileId || !!value.profile, { message: 'A profile is required' });

export const aiProviderProtocolSchema = z.enum(['openai-chat', 'openai-responses', 'anthropic']);
export const aiProviderAuthSchema = z.enum(['bearer', 'x-api-key']);
export const DEFAULT_AI_ROLE =
  'Terminal expert. Explain commands and effects clearly, prefer safe steps, and never claim a command was executed.';
const aiBaseUrlSchema = z
  .url()
  .trim()
  .max(2_048)
  .refine((input) => {
    const value = new URL(input);
    return (
      ['http:', 'https:'].includes(value.protocol) &&
      !!value.hostname &&
      !value.username &&
      !value.password &&
      !value.search &&
      !value.hash
    );
  }, 'AI base URL must be an HTTP(S) URL without credentials, query or fragment');
const aiApiPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/, 'AI API path must be an absolute URL path');
export const aiProviderSchema = z
  .object({
    ...entityFields,
    name: z.string().trim().min(1).max(120),
    baseUrl: aiBaseUrlSchema,
    apiPath: aiApiPathSchema.default('/chat/completions'),
    protocol: aiProviderProtocolSchema.default('openai-chat'),
    auth: aiProviderAuthSchema.default('bearer'),
    role: z.string().trim().min(1).max(16_384).default(DEFAULT_AI_ROLE),
    proxy: proxyEndpointSchema.nullable().default(null),
    timeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
    credentialRef: z.string().min(1).max(256),
    enabled: z.boolean(),
  })
  .strict();
export const aiProviderInputSchema = aiProviderSchema
  .omit({ id: true, createdAt: true, updatedAt: true, version: true })
  .strict();
export const aiProviderPatchSchema = aiProviderInputSchema.partial().strict();
export const aiModelSchema = z
  .object({
    ...entityFields,
    providerId: idSchema,
    name: z.string(),
    model: z.string(),
    capabilities: z.array(z.enum(['chat', 'tools'])),
  })
  .strict();
export const aiModelInputSchema = aiModelSchema
  .omit({ id: true, createdAt: true, updatedAt: true, version: true })
  .strict();
export const aiModelPatchSchema = aiModelInputSchema.partial().strict();
export const aiProviderTestResultSchema = z
  .object({
    providerId: idSchema,
    protocol: aiProviderProtocolSchema,
    ok: z.literal(true),
    latencyMs: z.number().int().nonnegative(),
    models: z.array(z.string().min(1).max(512)).max(500),
  })
  .strict();
export const aiUseCaseSchema = z.enum([
  'explainCommand',
  'explainOutput',
  'generateCommand',
  'createBookmark',
  'createTheme',
  'diagnose',
]);
export const aiConversationInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    modelId: idSchema,
    useCase: aiUseCaseSchema.default('diagnose'),
  })
  .strict();
export const aiConversationPatchSchema = aiConversationInputSchema.partial().strict();
export const aiConversationSchema = z
  .object({
    ...entityFields,
    name: z.string().trim().min(1).max(120),
    modelId: idSchema,
    useCase: aiUseCaseSchema,
    messageCount: z.number().int().nonnegative(),
    lastMessageAt: timestampSchema.nullable(),
  })
  .strict();
export const aiMessageStateSchema = z.enum(['complete', 'failed', 'canceled']);
export const aiAttachmentMetadataSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    size: z
      .number()
      .int()
      .nonnegative()
      .max(100 * 1024),
    includedBytes: z
      .number()
      .int()
      .nonnegative()
      .max(50 * 1024),
    truncated: z.boolean(),
  })
  .strict();
export const aiAttachmentPreviewSchema = aiAttachmentMetadataSchema
  .extend({
    id: idSchema,
    preview: z.string().max(8 * 1024),
    redacted: z.boolean(),
    expiresAt: timestampSchema,
  })
  .strict();
export const aiAttachmentPrepareSchema = z.object({ grantId: z.string().min(1).max(256) }).strict();
export const aiMessageSchema = z
  .object({
    ...entityFields,
    conversationId: idSchema,
    runId: idSchema,
    role: z.enum(['user', 'assistant']),
    content: z.string().max(2 * 1024 * 1024),
    attachments: z.array(aiAttachmentMetadataSchema).max(8).default([]),
    state: aiMessageStateSchema,
    errorCode: z.string().max(160).optional(),
  })
  .strict();
export const aiConversationDetailSchema = z
  .object({ conversation: aiConversationSchema, messages: z.array(aiMessageSchema).max(1_000) })
  .strict();
export const aiToolProposalSchema = z
  .object({
    name: aiToolNameSchema,
    args: z.record(z.string(), z.unknown()),
    target: z.string().min(1).max(512),
  })
  .strict();
export const aiRequestSchema = z
  .object({
    modelId: idSchema,
    conversationId: idSchema.optional(),
    useCase: aiUseCaseSchema,
    prompt: z.string().max(16_384),
    context: z.string().max(131_072).default(''),
    attachmentIds: z.array(idSchema).max(8).default([]),
    terminalId: idSchema.optional(),
    tool: aiToolProposalSchema.optional(),
  })
  .strict();
export const aiUseCaseInputSchema = aiRequestSchema.omit({ useCase: true }).strict();
export const aiRunStateSchema = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'canceled',
]);
export const aiRunSchema = z
  .object({
    ...entityFields,
    conversationId: idSchema.optional(),
    state: aiRunStateSchema,
    useCase: aiUseCaseSchema,
    result: z.string().optional(),
    errorCode: z.string().optional(),
  })
  .strict();
export const aiToolRiskSchema = z.enum(['read_only', 'mutating', 'destructive', 'privileged']);
export const aiToolCallSchema = z
  .object({
    ...entityFields,
    runId: idSchema,
    toolName: z.string(),
    risk: aiToolRiskSchema,
    argsHash: z.string(),
    args: z.record(z.string(), z.unknown()),
    target: z.string(),
    state: z.enum(['proposed', 'waiting_approval', 'running', 'succeeded', 'failed', 'canceled']),
    resultMetadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export const aiApprovalSchema = z
  .object({
    ...entityFields,
    runId: idSchema,
    toolCallId: idSchema,
    argsHash: z.string(),
    target: z.string(),
    state: z.enum(['pending', 'approved', 'rejected', 'expired']),
    expiresAt: timestampSchema,
    decidedAt: timestampSchema.optional(),
  })
  .strict();
export const aiApprovalDecisionSchema = z
  .object({ decision: z.enum(['approve_once', 'reject']), argsHash: z.string() })
  .strict();

export const domainEventSchema = z
  .object({
    cursor: z.number().int().positive(),
    eventId: idSchema,
    type: z.string(),
    aggregateId: z.string(),
    payload: z.unknown(),
    createdAt: timestampSchema,
  })
  .strict();
export const diagnosticsSchema = z
  .object({
    generation: idSchema,
    uptimeSeconds: z.number().nonnegative(),
    resources: z.record(z.string(), z.number().int().nonnegative()),
    database: z.enum(['ok', 'degraded']),
    updater: z
      .object({
        state: z.enum([
          'disabled',
          'idle',
          'checking',
          'available',
          'downloading',
          'ready',
          'error',
        ]),
        availableVersion: z.string().optional(),
        progress: z.number().min(0).max(100).optional(),
        errorCode: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export const openExternalUrlSchema = z.object({ url: z.url() }).strict();
export const diagnosticExportRequestSchema = z.object({ grantId: z.string().min(1) }).strict();
export const diagnosticExportSchema = z
  .object({ bytes: z.number().int().nonnegative(), createdAt: timestampSchema })
  .strict();
export const diagnosticLogsSchema = z
  .object({ lines: z.array(z.string()), truncated: z.boolean() })
  .strict();

export type HostGroup = z.infer<typeof hostGroupSchema>;
export type Host = z.infer<typeof hostSchema>;
export type KnownHostKey = z.infer<typeof knownHostKeySchema>;
export type ProxyEndpointConfig = z.infer<typeof proxyEndpointSchema>;
export type ProxyCommandConfig = z.infer<typeof proxyCommandSchema>;
export type HostProxyConfig = z.infer<typeof hostProxySchema>;
export type GlobalProxyConfig = z.infer<typeof globalProxySchema>;
export type ProxyTestRequest = z.input<typeof proxyTestRequestSchema>;
export type ProxyTestResult = z.infer<typeof proxyTestResultSchema>;
export type SshConnectionOptions = z.infer<typeof sshConnectionOptionsSchema>;
export type SshAlgorithms = z.infer<typeof sshAlgorithmsSchema>;
export type SshStartup = z.infer<typeof sshStartupSchema>;
export type SshX11 = z.infer<typeof sshX11Schema>;
export type SshAgentConfig = z.infer<typeof sshAgentSchema>;
export type SshAgentStatus = z.infer<typeof sshAgentStatusSchema>;
export type SshReconnectPolicy = z.infer<typeof sshReconnectPolicySchema>;
export type AppLanguage = z.infer<typeof appLanguageSchema>;
export type ActivityRailItem = z.infer<typeof activityRailItemSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type Connection = z.infer<typeof connectionSchema>;
export type FtpConnection = z.infer<typeof ftpConnectionSchema>;
export type SerialPortInfo = z.infer<typeof serialPortInfoSchema>;
export type RdpSession = z.infer<typeof rdpSessionSchema>;
export type CreateRdpSessionInput = z.input<typeof createRdpSessionSchema>;
export type RdpCredentialBootstrap = z.infer<typeof rdpCredentialBootstrapSchema>;
export type VncSession = z.infer<typeof vncSessionSchema>;
export type CreateVncSessionInput = z.input<typeof createVncSessionSchema>;
export type VncCredentialBootstrap = z.infer<typeof vncCredentialBootstrapSchema>;
export type SpiceSession = z.infer<typeof spiceSessionSchema>;
export type CreateSpiceSessionInput = z.input<typeof createSpiceSessionSchema>;
export type SpiceCredentialBootstrap = z.infer<typeof spiceCredentialBootstrapSchema>;
export type WebSession = z.infer<typeof webSessionSchema>;
export type CreateWebSessionInput = z.infer<typeof createWebSessionSchema>;
export type WebSessionPresentation = z.infer<typeof webSessionPresentationSchema>;
export type WebSessionAction = z.infer<typeof webSessionActionSchema>;
export type WebSessionAuthResponse = z.infer<typeof webSessionAuthResponseSchema>;
export type EnqueueDeepLink = z.infer<typeof enqueueDeepLinkSchema>;
export type DeepLinkReceipt = z.infer<typeof deepLinkReceiptSchema>;
export type DeepLinkIntent = z.infer<typeof deepLinkIntentSchema>;
export type Interaction = z.infer<typeof interactionSchema>;
export type TerminalAppearance = z.infer<typeof terminalAppearanceSchema>;
export type TerminalBehavior = z.infer<typeof terminalBehaviorSchema>;
export type TerminalBackground = z.infer<typeof terminalBackgroundSchema>;
export type TerminalVisualSettings = z.infer<typeof terminalVisualSettingsSchema>;
export type TerminalRecording = z.infer<typeof terminalRecordingSchema>;
export type TerminalShortcutButton = z.infer<typeof terminalShortcutButtonSchema>;
export type StartTerminalRecordingInput = z.infer<typeof startTerminalRecordingSchema>;
export type TerminalTransferProtocol = z.infer<typeof terminalTransferProtocolSchema>;
export type TerminalTransferDirection = z.infer<typeof terminalTransferDirectionSchema>;
export type TerminalTransferState = z.infer<typeof terminalTransferStateSchema>;
export type TerminalTransferAction = z.infer<typeof terminalTransferActionSchema>;
export type TerminalProfile = z.infer<typeof terminalProfileSchema>;
export type QuickCommand = z.infer<typeof quickCommandSchema>;
export type QuickCommandStep = z.infer<typeof quickCommandStepSchema>;
export type QuickCommandGroup = z.infer<typeof quickCommandGroupSchema>;
export type QuickCommandTree = z.infer<typeof quickCommandTreeSchema>;
export type QuickCommandTreeNode = z.infer<typeof quickCommandTreeNodeSchema>;
export type MoveQuickCommandTreeNodeInput = z.input<typeof moveQuickCommandTreeNodeSchema>;
export type BatchOperation = z.infer<typeof batchOperationSchema>;
export type BatchOperationTarget = z.infer<typeof batchOperationTargetSchema>;
export type BatchOperationStepResult = z.infer<typeof batchOperationStepResultSchema>;
export type CreateBatchOperationInput = z.input<typeof createBatchOperationSchema>;
export type CreateBatchOperationRequest = z.infer<typeof createBatchOperationSchema>;
export type WidgetId = z.infer<typeof widgetIdSchema>;
export type WidgetDefinition = z.infer<typeof widgetDefinitionSchema>;
export type WidgetInstance = z.infer<typeof widgetInstanceSchema>;
export type StartLocalFileServerInput = z.input<typeof startLocalFileServerSchema>;
export type StartLocalFtpServerInput = z.input<typeof startLocalFtpServerSchema>;
export type StartLocalSshServerInput = z.input<typeof startLocalSshServerSchema>;
export type StartMcpServerInput = z.input<typeof startMcpServerSchema>;
export type RenameWidgetInstanceInput = z.input<typeof renameWidgetInstanceSchema>;
export type PreviewFileRenameInput = z.input<typeof previewFileRenameSchema>;
export type FileRenamePreview = z.infer<typeof fileRenamePreviewSchema>;
export type FileRenameResult = z.infer<typeof fileRenameResultSchema>;
export type TriggerRule = z.infer<typeof triggerRuleSchema>;
export type TriggerRuleInput = z.input<typeof triggerRuleInputSchema>;
export type TriggerRulePatch = z.input<typeof triggerRulePatchSchema>;
export type TriggerCollection = z.infer<typeof triggerCollectionSchema>;
export type TerminalSession = z.infer<typeof terminalSessionSchema>;
export type TerminalInformationGroupName = z.infer<typeof terminalInformationGroupNameSchema>;
export type TerminalInformationSnapshot = z.infer<typeof terminalInformationSnapshotSchema>;
export type RemoteMonitorItem = z.infer<typeof remoteMonitorItemSchema>;
export type TerminalServerControl = z.infer<typeof terminalServerControlSchema>;
export type RemoteFileEntry = z.infer<typeof remoteFileEntrySchema>;
export type Transfer = z.infer<typeof transferSchema>;
export type TunnelProfile = z.infer<typeof tunnelProfileSchema>;
export type Tunnel = z.infer<typeof tunnelSchema>;
export type AiRun = z.infer<typeof aiRunSchema>;
export type AiAttachmentMetadata = z.infer<typeof aiAttachmentMetadataSchema>;
export type AiAttachmentPreview = z.infer<typeof aiAttachmentPreviewSchema>;
export type AiConversation = z.infer<typeof aiConversationSchema>;
export type AiConversationDetail = z.infer<typeof aiConversationDetailSchema>;
export type AiMessage = z.infer<typeof aiMessageSchema>;
export type AiProvider = z.infer<typeof aiProviderSchema>;
export type AiModel = z.infer<typeof aiModelSchema>;
export type AiProviderProtocol = z.infer<typeof aiProviderProtocolSchema>;
export type AiProviderAuth = z.infer<typeof aiProviderAuthSchema>;
export type AiProviderTestResult = z.infer<typeof aiProviderTestResultSchema>;
export type AiToolCall = z.infer<typeof aiToolCallSchema>;
export type AiApproval = z.infer<typeof aiApprovalSchema>;
export type CreateHostGroupInput = z.input<typeof createHostGroupSchema>;
export type CreateHostInput = z.input<typeof createHostSchema>;
export type UpdateHostInput = z.input<typeof updateHostSchema>;
export type UpdateSettingsInput = z.input<typeof updateSettingsSchema>;
export type CredentialKind = z.infer<typeof credentialKindSchema>;
export type CreateCredentialInput = z.input<typeof createCredentialSchema>;
export type CreateTerminalInput = z.input<typeof createTerminalSchema>;
export type TerminalProfileInput = z.input<typeof terminalProfileInputSchema>;
export type TerminalProfilePatch = z.input<typeof terminalProfilePatchSchema>;
export type CreateConnectionInput = z.input<typeof createConnectionSchema>;
export type QuickConnectTarget = z.infer<typeof quickConnectTargetSchema>;
export type QuickConnectTargetInput = z.input<typeof quickConnectTargetSchema>;
export type TransferRouteInput = z.input<typeof transferRouteInputSchema>;
export type RemoteCopyTransferRouteInput = z.input<typeof remoteCopyTransferRouteInputSchema>;
export type TransferConflictDecision = z.input<typeof transferConflictDecisionSchema>;
export type QuickCommandInput = z.input<typeof quickCommandInputSchema>;
export type QuickCommandPatch = z.input<typeof quickCommandPatchSchema>;
export type QuickCommandGroupInput = z.input<typeof quickCommandGroupInputSchema>;
export type QuickCommandGroupPatch = z.input<typeof quickCommandGroupPatchSchema>;
export type TunnelProfileInput = z.input<typeof tunnelProfileInputSchema>;
export type StartTunnelInput = z.input<typeof startTunnelSchema>;
export type AiProviderInput = z.input<typeof aiProviderInputSchema>;
export type AiProviderPatch = z.input<typeof aiProviderPatchSchema>;
export type AiModelInput = z.input<typeof aiModelInputSchema>;
export type AiModelPatch = z.input<typeof aiModelPatchSchema>;
export type AiRequestInput = z.input<typeof aiRequestSchema>;
export type AiConversationInput = z.input<typeof aiConversationInputSchema>;
export type AiConversationPatch = z.input<typeof aiConversationPatchSchema>;
