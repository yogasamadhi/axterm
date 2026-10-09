import { z } from 'zod';
import {
  authTypeSchema,
  createHostSchema,
  hostSchema,
  hostProxySchema,
  idSchema,
  sshConnectionOptionsSchema,
  terminalEncodingSchema,
  timestampSchema,
  triggerRuleInputSchema,
  updateHostSchema,
} from './resources';

const versionedFields = {
  id: idSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  version: z.number().int().positive(),
};

export const bookmarkProtocolSchema = z.enum([
  'ssh',
  'local',
  'telnet',
  'serial',
  'rdp',
  'vnc',
  'ftp',
  'spice',
  'web',
]);
export const bookmarkColorSchema = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i)
  .nullable();
export const bookmarkTreeEtagSchema = z.string().regex(/^"bookmark-tree-v\d+"$/);
export const bookmarkQuickCommandSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    command: z.string().min(1).max(16_384),
  })
  .strict();
export const bookmarkQuickCommandsSchema = z.array(bookmarkQuickCommandSchema).max(64);
export const bookmarkTriggerSchema = triggerRuleInputSchema.extend({ id: idSchema }).strict();
export const bookmarkTriggersSchema = z
  .array(bookmarkTriggerSchema)
  .max(32)
  .superRefine((triggers, context) => {
    if (new Set(triggers.map(({ id }) => id)).size !== triggers.length)
      context.addIssue({ code: 'custom', message: 'Bookmark trigger IDs must be unique' });
  });

export const ftpBookmarkSettingsSchema = z
  .object({
    hostname: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65_535).default(21),
    username: z.string().trim().min(1).max(128).default('anonymous'),
    credentialRef: z.string().min(1).max(256).nullable().default(null),
    security: z.enum(['plain', 'explicit-tls', 'implicit-tls']).default('plain'),
    tlsVerify: z.boolean().default(true),
    encoding: z
      .enum(['utf-8', 'gbk', 'gb18030', 'big5', 'shift-jis', 'euc-jp', 'euc-kr'])
      .default('utf-8'),
    initialDirectory: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => value.startsWith('/'), 'FTP initial directory must be absolute')
      .default('/'),
  })
  .strict();

const telnetPromptSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => {
    try {
      const delimited = value.match(/^\/(.+)\/([gimsuy]*)$/);
      void (delimited ? new RegExp(delimited[1]!, delimited[2]) : new RegExp(value, 'i'));
      return true;
    } catch {
      return false;
    }
  }, 'Telnet prompt must be a valid regular expression');
export const telnetBookmarkSettingsSchema = z
  .object({
    hostname: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65_535).default(23),
    username: z.string().max(128).default('root'),
    credentialRef: z.string().min(1).max(256).nullable().default(null),
    loginPrompt: telnetPromptSchema.default('/login[: ]*$|user(?:name)?[: ]*$/i'),
    passwordPrompt: telnetPromptSchema.default('/password[: ]*$/i'),
    encoding: terminalEncodingSchema.default('utf-8'),
    connectionTimeoutMs: z.number().int().min(250).max(120_000).default(10_000),
  })
  .strict();

export const serialBookmarkSettingsSchema = z
  .object({
    path: z.string().trim().min(1).max(1_024),
    baudRate: z.number().int().min(50).max(4_000_000).default(9_600),
    dataBits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).default(8),
    stopBits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).default(1),
    parity: z.enum(['none', 'even', 'mark', 'odd', 'space']).default('none'),
    lock: z.boolean().default(true),
    rtscts: z.boolean().default(false),
    xon: z.boolean().default(false),
    xoff: z.boolean().default(false),
    xany: z.boolean().default(false),
    txLineEnding: z.enum(['\r', '\n', '\r\n']).default('\r'),
    rxLineEnding: z.enum(['none', 'lf_to_crlf', 'cr_to_crlf']).default('none'),
    closeSequence: z.string().max(64).default('\\x01ky'),
    closeSequenceDelayMs: z.number().int().min(0).max(10_000).default(500),
    encoding: terminalEncodingSchema.default('utf-8'),
  })
  .strict();

export const rdpBookmarkSettingsSchema = z
  .object({
    hostname: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65_535).default(3_389),
    username: z.string().trim().min(1).max(128),
    credentialRef: z.string().min(1).max(256).nullable().default(null),
    domain: z.string().trim().max(128).default(''),
    proxy: hostProxySchema,
    jumpHostId: idSchema.nullable().default(null),
    connectionTimeoutMs: z.number().int().min(1_000).max(120_000).default(15_000),
    desktopWidth: z.number().int().min(320).max(8_192).default(1_280),
    desktopHeight: z.number().int().min(240).max(4_320).default(720),
    scaleViewport: z.boolean().default(false),
    clipboard: z.boolean().default(true),
  })
  .strict();

export const vncBookmarkSettingsSchema = z
  .object({
    hostname: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65_535).default(5_900),
    username: z.string().trim().max(128).default(''),
    credentialRef: z.string().min(1).max(256).nullable().default(null),
    proxy: hostProxySchema,
    jumpHostId: idSchema.nullable().default(null),
    connectionTimeoutMs: z.number().int().min(1_000).max(120_000).default(15_000),
    viewOnly: z.boolean().default(false),
    clipViewport: z.boolean().default(false),
    scaleViewport: z.boolean().default(true),
    qualityLevel: z.number().int().min(0).max(9).default(3),
    compressionLevel: z.number().int().min(0).max(9).default(1),
    shared: z.boolean().default(true),
    showDotCursor: z.boolean().default(true),
    clipboard: z.boolean().default(true),
  })
  .strict();

export const spiceBookmarkSettingsSchema = z
  .object({
    hostname: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65_535).default(5_900),
    credentialRef: z.string().min(1).max(256).nullable().default(null),
    proxy: hostProxySchema,
    jumpHostId: idSchema.nullable().default(null),
    connectionTimeoutMs: z.number().int().min(1_000).max(120_000).default(15_000),
    viewOnly: z.boolean().default(false),
    scaleViewport: z.boolean().default(true),
  })
  .strict();

export const webBookmarkSettingsSchema = z
  .object({
    url: z
      .url()
      .max(4_096)
      .refine((value) => {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
      }, 'Expected a credential-free HTTP(S) URL'),
    userAgent: z.string().trim().min(1).max(512).nullable().default(null),
    hideAddressBar: z.boolean().default(false),
  })
  .strict();

export const bookmarkGroupSchema = z
  .object({
    ...versionedFields,
    parentId: idSchema.nullable(),
    name: z.string().trim().min(1).max(80),
    color: bookmarkColorSchema,
    description: z.string().max(1_024),
    position: z.number().int().nonnegative(),
  })
  .strict();

const bookmarkObjectSchema = z
  .object({
    ...versionedFields,
    groupId: idSchema.nullable(),
    protocol: bookmarkProtocolSchema,
    hostId: idSchema.nullable(),
    title: z.string().trim().min(1).max(100),
    color: bookmarkColorSchema,
    description: z.string().max(2_000),
    position: z.number().int().nonnegative(),
    profileId: idSchema.nullable(),
    connectionProfileId: idSchema.nullable(),
    quickCommands: bookmarkQuickCommandsSchema,
    triggers: bookmarkTriggersSchema,
    ftp: ftpBookmarkSettingsSchema.nullable(),
    telnet: telnetBookmarkSettingsSchema.nullable(),
    serial: serialBookmarkSettingsSchema.nullable(),
    rdp: rdpBookmarkSettingsSchema.nullable(),
    vnc: vncBookmarkSettingsSchema.nullable(),
    spice: spiceBookmarkSettingsSchema.nullable(),
    web: webBookmarkSettingsSchema.nullable(),
    connectionDisplay: z.string().max(512).nullable(),
  })
  .strict();

export const bookmarkSchema = bookmarkObjectSchema.superRefine((bookmark, context) => {
  if (bookmark.protocol === 'ssh' && !bookmark.hostId)
    context.addIssue({ code: 'custom', path: ['hostId'], message: 'SSH bookmark requires hostId' });
  if (bookmark.protocol !== 'ssh' && bookmark.hostId)
    context.addIssue({
      code: 'custom',
      path: ['hostId'],
      message: 'Only SSH bookmarks may reference hostId',
    });
  if (bookmark.protocol === 'ftp' && !bookmark.ftp)
    context.addIssue({ code: 'custom', path: ['ftp'], message: 'FTP bookmark requires settings' });
  if (bookmark.protocol !== 'ftp' && bookmark.ftp)
    context.addIssue({
      code: 'custom',
      path: ['ftp'],
      message: 'Only FTP bookmarks use FTP settings',
    });
  if (bookmark.protocol === 'telnet' && !bookmark.telnet)
    context.addIssue({
      code: 'custom',
      path: ['telnet'],
      message: 'Telnet bookmark requires settings',
    });
  if (bookmark.protocol !== 'telnet' && bookmark.telnet)
    context.addIssue({
      code: 'custom',
      path: ['telnet'],
      message: 'Only Telnet bookmarks use Telnet settings',
    });
  if (bookmark.protocol === 'serial' && !bookmark.serial)
    context.addIssue({
      code: 'custom',
      path: ['serial'],
      message: 'Serial bookmark requires settings',
    });
  if (bookmark.protocol !== 'serial' && bookmark.serial)
    context.addIssue({
      code: 'custom',
      path: ['serial'],
      message: 'Only Serial bookmarks use Serial settings',
    });
  if (bookmark.protocol === 'rdp' && !bookmark.rdp)
    context.addIssue({ code: 'custom', path: ['rdp'], message: 'RDP bookmark requires settings' });
  if (bookmark.protocol !== 'rdp' && bookmark.rdp)
    context.addIssue({
      code: 'custom',
      path: ['rdp'],
      message: 'Only RDP bookmarks use RDP settings',
    });
  if (bookmark.protocol === 'vnc' && !bookmark.vnc)
    context.addIssue({ code: 'custom', path: ['vnc'], message: 'VNC bookmark requires settings' });
  if (bookmark.protocol !== 'vnc' && bookmark.vnc)
    context.addIssue({
      code: 'custom',
      path: ['vnc'],
      message: 'Only VNC bookmarks use VNC settings',
    });
  if (bookmark.protocol === 'spice' && !bookmark.spice)
    context.addIssue({
      code: 'custom',
      path: ['spice'],
      message: 'SPICE bookmark requires settings',
    });
  if (bookmark.protocol !== 'spice' && bookmark.spice)
    context.addIssue({
      code: 'custom',
      path: ['spice'],
      message: 'Only SPICE bookmarks use SPICE settings',
    });
  if (bookmark.protocol === 'web' && !bookmark.web)
    context.addIssue({
      code: 'custom',
      path: ['web'],
      message: 'Web bookmark requires settings',
    });
  if (bookmark.protocol !== 'web' && bookmark.web)
    context.addIssue({
      code: 'custom',
      path: ['web'],
      message: 'Only Web bookmarks use Web settings',
    });
});

export const bookmarkTreeSchema = z
  .object({
    revision: z.number().int().positive(),
    etag: bookmarkTreeEtagSchema,
    groups: z.array(bookmarkGroupSchema),
    bookmarks: z.array(bookmarkSchema),
  })
  .strict();

export const createBookmarkGroupSchema = bookmarkGroupSchema
  .pick({ parentId: true, name: true, color: true, description: true })
  .extend({
    parentId: idSchema.nullable().default(null),
    color: bookmarkColorSchema.default(null),
    description: z.string().max(1_024).default(''),
  })
  .strict();

export const updateBookmarkGroupSchema = createBookmarkGroupSchema
  .partial()
  .omit({ parentId: true })
  .refine((input) => Object.keys(input).length > 0, 'Bookmark group update is empty');

export const createBookmarkSchema = bookmarkObjectSchema
  .pick({
    groupId: true,
    protocol: true,
    hostId: true,
    title: true,
    color: true,
    description: true,
    profileId: true,
    connectionProfileId: true,
    quickCommands: true,
    triggers: true,
    ftp: true,
    telnet: true,
    serial: true,
    rdp: true,
    vnc: true,
    spice: true,
    web: true,
  })
  .extend({
    groupId: idSchema.nullable().default(null),
    color: bookmarkColorSchema.default(null),
    description: z.string().max(2_000).default(''),
    profileId: idSchema.nullable().default(null),
    connectionProfileId: idSchema.nullable().default(null),
    quickCommands: bookmarkQuickCommandsSchema.default([]),
    triggers: bookmarkTriggersSchema.default([]),
    ftp: ftpBookmarkSettingsSchema.nullable().default(null),
    telnet: telnetBookmarkSettingsSchema.nullable().default(null),
    serial: serialBookmarkSettingsSchema.nullable().default(null),
    rdp: rdpBookmarkSettingsSchema.nullable().default(null),
    vnc: vncBookmarkSettingsSchema.nullable().default(null),
    spice: spiceBookmarkSettingsSchema.nullable().default(null),
    web: webBookmarkSettingsSchema.nullable().default(null),
  })
  .strict()
  .superRefine((bookmark, context) => {
    if (bookmark.protocol === 'ssh' && !bookmark.hostId)
      context.addIssue({
        code: 'custom',
        path: ['hostId'],
        message: 'SSH bookmark requires hostId',
      });
    if (bookmark.protocol !== 'ssh' && bookmark.hostId)
      context.addIssue({
        code: 'custom',
        path: ['hostId'],
        message: 'Only SSH bookmarks may reference hostId',
      });
    if (bookmark.protocol === 'ftp' && !bookmark.ftp)
      context.addIssue({
        code: 'custom',
        path: ['ftp'],
        message: 'FTP bookmark requires settings',
      });
    if (bookmark.protocol !== 'ftp' && bookmark.ftp)
      context.addIssue({
        code: 'custom',
        path: ['ftp'],
        message: 'Only FTP bookmarks use FTP settings',
      });
    if (bookmark.protocol === 'telnet' && !bookmark.telnet)
      context.addIssue({
        code: 'custom',
        path: ['telnet'],
        message: 'Telnet bookmark requires settings',
      });
    if (bookmark.protocol !== 'telnet' && bookmark.telnet)
      context.addIssue({
        code: 'custom',
        path: ['telnet'],
        message: 'Only Telnet bookmarks use Telnet settings',
      });
    if (bookmark.protocol === 'serial' && !bookmark.serial)
      context.addIssue({
        code: 'custom',
        path: ['serial'],
        message: 'Serial bookmark requires settings',
      });
    if (bookmark.protocol !== 'serial' && bookmark.serial)
      context.addIssue({
        code: 'custom',
        path: ['serial'],
        message: 'Only Serial bookmarks use Serial settings',
      });
    if (bookmark.protocol === 'rdp' && !bookmark.rdp)
      context.addIssue({
        code: 'custom',
        path: ['rdp'],
        message: 'RDP bookmark requires settings',
      });
    if (bookmark.protocol !== 'rdp' && bookmark.rdp)
      context.addIssue({
        code: 'custom',
        path: ['rdp'],
        message: 'Only RDP bookmarks use RDP settings',
      });
    if (bookmark.protocol === 'vnc' && !bookmark.vnc)
      context.addIssue({
        code: 'custom',
        path: ['vnc'],
        message: 'VNC bookmark requires settings',
      });
    if (bookmark.protocol !== 'vnc' && bookmark.vnc)
      context.addIssue({
        code: 'custom',
        path: ['vnc'],
        message: 'Only VNC bookmarks use VNC settings',
      });
    if (bookmark.protocol === 'spice' && !bookmark.spice)
      context.addIssue({
        code: 'custom',
        path: ['spice'],
        message: 'SPICE bookmark requires settings',
      });
    if (bookmark.protocol !== 'spice' && bookmark.spice)
      context.addIssue({
        code: 'custom',
        path: ['spice'],
        message: 'Only SPICE bookmarks use SPICE settings',
      });
    if (bookmark.protocol === 'web' && !bookmark.web)
      context.addIssue({
        code: 'custom',
        path: ['web'],
        message: 'Web bookmark requires settings',
      });
    if (bookmark.protocol !== 'web' && bookmark.web)
      context.addIssue({
        code: 'custom',
        path: ['web'],
        message: 'Only Web bookmarks use Web settings',
      });
  });

export const updateBookmarkSchema = z
  .object({
    title: z.string().trim().min(1).max(100).optional(),
    color: bookmarkColorSchema.optional(),
    description: z.string().max(2_000).optional(),
    profileId: idSchema.nullable().optional(),
    connectionProfileId: idSchema.nullable().optional(),
    quickCommands: bookmarkQuickCommandsSchema.optional(),
    triggers: bookmarkTriggersSchema.optional(),
    ftp: ftpBookmarkSettingsSchema.nullable().optional(),
    telnet: telnetBookmarkSettingsSchema.nullable().optional(),
    serial: serialBookmarkSettingsSchema.nullable().optional(),
    rdp: rdpBookmarkSettingsSchema.nullable().optional(),
    vnc: vncBookmarkSettingsSchema.nullable().optional(),
    spice: spiceBookmarkSettingsSchema.nullable().optional(),
    web: webBookmarkSettingsSchema.nullable().optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, 'Bookmark update is empty');

// A saved SSH destination is one application command even though Host and Bookmark
// remain separate aggregates. Host contains connection facts; Bookmark contains the
// tree placement and presentation fields. `groupId` is deliberately absent from the
// Host input so the legacy host_groups table cannot become a second tree writer.
export const createSshBookmarkSchema = z
  .object({
    host: createHostSchema.omit({ groupId: true }).strict(),
    bookmark: z
      .object({
        groupId: idSchema.nullable().default(null),
        title: z.string().trim().min(1).max(100),
        color: bookmarkColorSchema.default(null),
        description: z.string().max(2_000).default(''),
        profileId: idSchema.nullable().default(null),
        connectionProfileId: idSchema.nullable().default(null),
        quickCommands: bookmarkQuickCommandsSchema.default([]),
        triggers: bookmarkTriggersSchema.default([]),
      })
      .strict(),
  })
  .strict();

// AI may only propose non-secret connection metadata. Keeping this schema strict
// makes password/private-key/token fields invalid instead of silently discarding
// them before the user reviews the draft.
export const aiBookmarkDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(100),
    hostname: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65_535),
    username: z.string().trim().min(1).max(128),
    authType: authTypeSchema,
    description: z.string().max(2_000),
    favorite: z.boolean(),
  })
  .strict();

export const sshBookmarkMutationResultSchema = z
  .object({
    host: hostSchema,
    bookmark: bookmarkSchema,
    tree: bookmarkTreeSchema,
  })
  .strict();

export const updateSshBookmarkSchema = z
  .object({
    host: updateHostSchema.omit({ groupId: true }).strict().default({}),
    bookmark: z
      .object({
        groupId: idSchema.nullable().optional(),
        title: z.string().trim().min(1).max(100).optional(),
        color: bookmarkColorSchema.optional(),
        description: z.string().max(2_000).optional(),
        profileId: idSchema.nullable().optional(),
        connectionProfileId: idSchema.nullable().optional(),
        quickCommands: bookmarkQuickCommandsSchema.optional(),
        triggers: bookmarkTriggersSchema.optional(),
      })
      .strict()
      .default({}),
  })
  .strict()
  .refine(
    ({ host, bookmark }) => Object.keys(host).length > 0 || Object.keys(bookmark).length > 0,
    'SSH Bookmark update is empty',
  );

export const deleteSshBookmarkEntryResultSchema = z
  .object({
    bookmarkId: idSchema,
    hostId: idSchema,
    hostDeleted: z.boolean(),
    remainingBookmarkIds: z.array(idSchema),
    retainedBy: z.array(z.enum(['bookmark', 'jumpHost', 'history', 'tunnel'])).max(4),
    tree: bookmarkTreeSchema,
  })
  .strict();

export const deleteSshBookmarkResultSchema = z
  .object({
    hostId: idSchema,
    bookmarkIds: z.array(idSchema),
    tree: bookmarkTreeSchema,
  })
  .strict();

export const importHostsSchema = z
  .object({
    grantId: z.string().min(1).max(256),
    groupId: idSchema.nullable().default(null),
  })
  .strict();

export const sshConfigImportNoticeCodeSchema = z.enum([
  'INCLUDE_NOT_FOLLOWED',
  'INCLUDE_AUTHORIZATION_REQUIRED',
  'INCLUDE_GRANT_INVALID',
  'INCLUDE_CYCLE_SKIPPED',
  'INCLUDE_LIMIT_EXCEEDED',
  'WILDCARD_HOST_SKIPPED',
  'MULTI_ALIAS_HOST_SKIPPED',
  'MISSING_USERNAME',
  'INVALID_PORT',
  'INVALID_OPTION',
  'IDENTITY_FILE_NOT_IMPORTED',
  'PROXY_COMMAND_NOT_IMPORTED',
  'CONFLICTING_HOST_SKIPPED',
  'MISSING_PROXY_JUMP',
  'PROXY_JUMP_CONFLICT',
  'PROXY_JUMP_CYCLE',
  'USER_EXCLUDED',
  'UNSUPPORTED_OPTION',
  'DUPLICATE_ALIAS_SKIPPED',
]);

export const sshConfigImportNoticeSchema = z
  .object({
    code: sshConfigImportNoticeCodeSchema,
    line: z.number().int().positive(),
    message: z.string().min(1).max(240),
  })
  .strict();

export const sshConfigImportItemSchema = z
  .object({
    index: z.number().int().nonnegative(),
    line: z.number().int().positive(),
    alias: z.string().min(1).max(100),
    status: z.enum(['imported', 'linked', 'unchanged', 'skipped']),
    hostId: idSchema.nullable(),
    bookmarkId: idSchema.nullable(),
    proxyJumps: z.array(z.string().min(1).max(253)).max(8),
    notices: z.array(sshConfigImportNoticeSchema).max(64),
  })
  .strict();

export const sshConfigImportResultSchema = z
  .object({
    source: z.literal('ssh-config'),
    importedAt: timestampSchema,
    createdHosts: z.array(hostSchema).max(1_000),
    createdBookmarks: z.array(bookmarkSchema).max(1_000),
    tree: bookmarkTreeSchema,
    items: z.array(sshConfigImportItemSchema).max(2_000),
    notices: z.array(sshConfigImportNoticeSchema).max(256),
    summary: z
      .object({
        total: z.number().int().nonnegative(),
        imported: z.number().int().nonnegative(),
        linked: z.number().int().nonnegative(),
        unchanged: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        warningCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const sshConfigIncludeGrantBindingSchema = z
  .object({
    includeId: z.string().min(1).max(160),
    grantId: z.string().min(1).max(256),
  })
  .strict();

export const previewSshConfigImportSchema = z
  .object({
    grantId: z.string().min(1).max(256),
    includeGrants: z.array(sshConfigIncludeGrantBindingSchema).max(128).default([]),
  })
  .strict();

export const sshConfigImportDraftSchema = z
  .object({
    id: z.string().min(1).max(160),
    selected: z.boolean(),
    name: createHostSchema.shape.name,
    title: z.string().trim().min(1).max(100),
    description: z.string().max(1_024),
    hostname: createHostSchema.shape.hostname,
    port: createHostSchema.shape.port,
    username: createHostSchema.shape.username,
    authType: authTypeSchema,
    proxy: hostProxySchema,
    proxyJumps: z.array(z.string().trim().min(1).max(253)).max(8),
    connectionOptions: sshConnectionOptionsSchema,
  })
  .strict();

export const sshConfigImportPreviewItemSchema = z
  .object({
    id: z.string().min(1).max(160),
    index: z.number().int().nonnegative(),
    line: z.number().int().positive(),
    sourceName: z.string().min(1).max(255),
    alias: z.string().min(1).max(100),
    status: z.enum(['imported', 'linked', 'unchanged', 'skipped']),
    draft: sshConfigImportDraftSchema.nullable(),
    notices: z.array(sshConfigImportNoticeSchema).max(64),
  })
  .strict();

export const sshConfigIncludeRequestSchema = z
  .object({
    id: z.string().min(1).max(160),
    sourceName: z.string().min(1).max(255),
    line: z.number().int().positive(),
    pattern: z.string().min(1).max(255),
    status: z.enum(['authorization-required', 'authorized', 'skipped']),
    grantName: z.string().min(1).max(255).nullable(),
    fileCount: z.number().int().nonnegative().max(64),
    notice: sshConfigImportNoticeSchema.nullable(),
  })
  .strict();

export const sshConfigImportPreviewSchema = z
  .object({
    previewId: idSchema,
    expiresAt: timestampSchema,
    sourceName: z.string().min(1).max(255),
    items: z.array(sshConfigImportPreviewItemSchema).max(2_000),
    includes: z.array(sshConfigIncludeRequestSchema).max(128),
    notices: z.array(sshConfigImportNoticeSchema).max(256),
    summary: z
      .object({
        total: z.number().int().nonnegative(),
        imported: z.number().int().nonnegative(),
        linked: z.number().int().nonnegative(),
        unchanged: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        warningCount: z.number().int().nonnegative(),
        selected: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const commitSshConfigImportSchema = z
  .object({
    previewId: idSchema,
    groupId: idSchema.nullable().default(null),
    items: z.array(sshConfigImportDraftSchema).max(1_000),
  })
  .strict();

export const bookmarkTreeNodeRefSchema = z
  .object({ kind: z.enum(['group', 'bookmark']), id: idSchema })
  .strict();
export const moveBookmarkTreeNodeSchema = z
  .object({
    source: bookmarkTreeNodeRefSchema,
    target: bookmarkTreeNodeRefSchema,
    position: z.enum(['before', 'inside', 'after']),
  })
  .strict()
  .refine(
    ({ source, target }) => source.kind !== target.kind || source.id !== target.id,
    'A bookmark tree node cannot target itself',
  );

export type BookmarkProtocol = z.infer<typeof bookmarkProtocolSchema>;
export type BookmarkGroup = z.infer<typeof bookmarkGroupSchema>;
export type Bookmark = z.infer<typeof bookmarkSchema>;
export type FtpBookmarkSettings = z.infer<typeof ftpBookmarkSettingsSchema>;
export type SpiceBookmarkSettings = z.infer<typeof spiceBookmarkSettingsSchema>;
export type WebBookmarkSettings = z.infer<typeof webBookmarkSettingsSchema>;
export type TelnetBookmarkSettings = z.infer<typeof telnetBookmarkSettingsSchema>;
export type SerialBookmarkSettings = z.infer<typeof serialBookmarkSettingsSchema>;
export type RdpBookmarkSettings = z.infer<typeof rdpBookmarkSettingsSchema>;
export type VncBookmarkSettings = z.infer<typeof vncBookmarkSettingsSchema>;
export type BookmarkTree = z.infer<typeof bookmarkTreeSchema>;
export type BookmarkTreeNodeRef = z.infer<typeof bookmarkTreeNodeRefSchema>;
export type BookmarkDropPosition = z.infer<typeof moveBookmarkTreeNodeSchema>['position'];
export type CreateBookmarkGroupInput = z.input<typeof createBookmarkGroupSchema>;
export type UpdateBookmarkGroupInput = z.input<typeof updateBookmarkGroupSchema>;
export type CreateBookmarkInput = z.input<typeof createBookmarkSchema>;
export type UpdateBookmarkInput = z.input<typeof updateBookmarkSchema>;
export type MoveBookmarkTreeNodeInput = z.input<typeof moveBookmarkTreeNodeSchema>;
export type CreateSshBookmarkInput = z.input<typeof createSshBookmarkSchema>;
export type AiBookmarkDraft = z.infer<typeof aiBookmarkDraftSchema>;
export type SshBookmarkMutationResult = z.infer<typeof sshBookmarkMutationResultSchema>;
export type UpdateSshBookmarkInput = z.input<typeof updateSshBookmarkSchema>;
export type DeleteSshBookmarkEntryResult = z.infer<typeof deleteSshBookmarkEntryResultSchema>;
export type DeleteSshBookmarkResult = z.infer<typeof deleteSshBookmarkResultSchema>;
export type ImportHostsInput = z.input<typeof importHostsSchema>;
export type SshConfigImportNotice = z.infer<typeof sshConfigImportNoticeSchema>;
export type SshConfigImportItem = z.infer<typeof sshConfigImportItemSchema>;
export type SshConfigImportResult = z.infer<typeof sshConfigImportResultSchema>;
export type SshConfigIncludeGrantBinding = z.infer<typeof sshConfigIncludeGrantBindingSchema>;
export type PreviewSshConfigImportInput = z.input<typeof previewSshConfigImportSchema>;
export type SshConfigImportDraft = z.infer<typeof sshConfigImportDraftSchema>;
export type SshConfigImportPreviewItem = z.infer<typeof sshConfigImportPreviewItemSchema>;
export type SshConfigIncludeRequest = z.infer<typeof sshConfigIncludeRequestSchema>;
export type SshConfigImportPreview = z.infer<typeof sshConfigImportPreviewSchema>;
export type CommitSshConfigImportInput = z.input<typeof commitSshConfigImportSchema>;
