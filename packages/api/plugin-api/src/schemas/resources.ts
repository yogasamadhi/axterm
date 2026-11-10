import {
  DEFAULT_TERMINAL_THEME_ID,
  DEFAULT_TERMINAL_BACKGROUND,
  terminalVisualSettingsSchema,
} from './terminal-visual.ts';
export {
  DEFAULT_TERMINAL_THEME_ID,
  DEFAULT_TERMINAL_BACKGROUND,
  terminalBackgroundSchema,
  terminalVisualSettingsSchema,
} from './terminal-visual.ts';
export type { TerminalBackground, TerminalVisualSettings } from './terminal-visual.ts';
import {
  workspacePresentationRecordsSchema,
  workspacePresentationSchema,
} from '../workspace-presentation.ts';
// Pure first-party DTO contracts migrated from frozen Axterm resources (ADR-050).
import { z } from 'zod';
import { shortcutSettingsSchema } from './shortcuts.ts';
export const idSchema = z.uuid();
export const etagSchema = z.string().regex(/^"v\d+"$/);

export const timestampSchema = z.iso.datetime();

export const entityFields = {
  id: idSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  version: z.number().int().positive(),
};

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
  osc52Enabled: true,
  osc52ReadPolicy: 'deny',
  osc52WritePolicy: 'allow',
} as const;

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
    // A layout keeps pane positions stable. `null` represents an explicitly
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
    presentation: workspacePresentationSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.presentation) return;
    const ids = new Set(value.layout.tabs.map((tab) => tab.id));
    if (
      value.presentation.tabs.length !== ids.size ||
      value.presentation.tabs.some((tab) => !ids.has(tab.id))
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Named workspace presentation must describe the same sessions as its portable layout',
      });
    for (const tab of value.presentation.tabs) {
      const legacy = value.layout.tabs.find((item) => item.id === tab.id);
      if (
        tab.terminalVisual &&
        JSON.stringify(tab.terminalVisual) !== JSON.stringify(legacy?.visual)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Named workspace visual metadata must match its portable layout',
        });
    }
  });

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

export type TerminalShortcutButton = z.infer<typeof terminalShortcutButtonSchema>;

export const terminalShortcutButtonsSchema = z
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

export const APP_LANGUAGES = ['en', 'ja', 'zh-CN', 'zh-TW'] as const;

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
        importRevision: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER - 1)
          .default(0),
        restoreLayout: z.boolean(),
        aiInspectorOpen: z.boolean(),
        layout: workspaceLayoutSchema.optional(),
        presentations: workspacePresentationRecordsSchema.optional(),
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
        presentations: workspacePresentationRecordsSchema.optional(),
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
    shortcuts: shortcutSettingsSchema
      .removeDefault()
      .partial()
      .extend({
        bindings: shortcutSettingsSchema.removeDefault().shape.bindings.removeDefault().optional(),
      })
      .optional(),
    resetTerminalGestures: z.literal(true).optional(),
    terminal: terminalSettingsSchema.partial().optional(),
    fileManager: fileManagerSettingsSchema.partial().optional(),
    monitor: monitorSettingsSchema.partial().optional(),
  })
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

export type HostGroup = z.infer<typeof hostGroupSchema>;

export type Host = z.infer<typeof hostSchema>;

export type HostProxyConfig = z.infer<typeof hostProxySchema>;

export type Settings = z.infer<typeof settingsSchema>;

export type CreateHostGroupInput = z.input<typeof createHostGroupSchema>;

export type CreateHostInput = z.input<typeof createHostSchema>;

export type UpdateHostInput = z.input<typeof updateHostSchema>;

export type UpdateSettingsInput = z.input<typeof updateSettingsSchema>;

// Additional connection contracts migrated under ADR-051.
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

/** Flat transient route; secrets are execution input and never saved Host facts. */
export const connectionHopSchema = z
  .object({
    hostId: idSchema.optional(),
    target: quickConnectTargetSchema.optional(),
    connectionProfileId: idSchema.optional(),
    temporarySecret: z.string().max(131_072).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!!value.hostId === !!value.target)
      ctx.addIssue({
        code: 'custom',
        message: 'Exactly one hop Host or target is required',
        path: ['hostId'],
      });
  });
export type ConnectionHopInput = z.input<typeof connectionHopSchema>;
export const createConnectionSchema = z
  .object({
    hops: z.array(connectionHopSchema).max(8).optional(),
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

export const interactionPresentationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('sshHostKey'),
      username: z.string().max(128),
      hostname: z.string().max(253),
      port: z.number().int().min(1).max(65_535),
      algorithm: z.string().max(128),
      fingerprint: z.string().max(512),
      previousFingerprint: z.string().max(512).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('keyboardInteractive'),
      username: z.string().max(128),
      hostname: z.string().max(253),
      port: z.number().int().min(1).max(65_535),
      challengeName: z.string().max(512),
      instructions: z.string().max(8_192),
      attempt: z.number().int().min(1).max(64),
      promptCount: z.number().int().min(0).max(64),
    })
    .strict(),
]);

export const interactionSchema = z
  .object({
    id: idSchema,
    kind: interactionKindSchema,
    connectionId: idSchema.optional(),
    severity: z.enum(['info', 'warning', 'high']),
    title: z.string(),
    detail: z.string(),
    presentation: interactionPresentationSchema.optional(),
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

export type KnownHostKey = z.infer<typeof knownHostKeySchema>;

export type ProxyEndpointConfig = z.infer<typeof proxyEndpointSchema>;

export type GlobalProxyConfig = z.infer<typeof globalProxySchema>;

export type ProxyTestRequest = z.input<typeof proxyTestRequestSchema>;

export type ProxyTestResult = z.infer<typeof proxyTestResultSchema>;

export type SshAlgorithms = z.infer<typeof sshAlgorithmsSchema>;

export type SshStartup = z.infer<typeof sshStartupSchema>;

export type SshAgentStatus = z.infer<typeof sshAgentStatusSchema>;

export type Connection = z.infer<typeof connectionSchema>;

export type Interaction = z.infer<typeof interactionSchema>;

export type CreateConnectionInput = z.input<typeof createConnectionSchema>;

export type QuickConnectTarget = z.infer<typeof quickConnectTargetSchema>;

export const DEFAULT_TERMINAL_APPEARANCE = {
  fontFamily: 'Maple Mono, mono, courier-new, courier, monospace',
  fontSize: 16,
  lineHeight: 1,
  cursorStyle: 'block',
  cursorBlink: false,
} as const;

export const DEFAULT_TERMINAL_TYPE = 'xterm-256color';

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

export const LIGHT_TERMINAL_THEME_ID = '00000000-0000-4000-8000-000000000002';

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

export type TerminalProfile = z.infer<typeof terminalProfileSchema>;

export type TerminalProfileInput = z.input<typeof terminalProfileInputSchema>;

export type TerminalProfilePatch = z.input<typeof terminalProfilePatchSchema>;
