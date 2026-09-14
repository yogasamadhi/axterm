import { z } from 'zod';
import { entityFields, idSchema } from './resources';

const profileUsernameSchema = z.string().trim().min(1).max(128).nullable().default(null);
const profileCredentialRefSchema = z.string().min(1).max(256).nullable().default(null);

/**
 * Electerm keeps one reusable Profile with protocol-specific credential sections.
 * Axterm preserves that shape at the REST boundary, but stores only opaque local
 * credential references in the product database. Plaintext secrets are rejected by
 * the strict schemas and are written through the Desktop Host capability instead.
 */
export const sshProfileValuesSchema = z
  .object({
    username: profileUsernameSchema,
    passwordCredentialRef: profileCredentialRefSchema,
    privateKeyCredentialRef: profileCredentialRefSchema,
    passphraseCredentialRef: profileCredentialRefSchema,
    certificateCredentialRef: profileCredentialRefSchema,
  })
  .strict()
  .default({
    username: null,
    passwordCredentialRef: null,
    privateKeyCredentialRef: null,
    passphraseCredentialRef: null,
    certificateCredentialRef: null,
  });

export const passwordProfileValuesSchema = z
  .object({
    username: profileUsernameSchema,
    passwordCredentialRef: profileCredentialRefSchema,
  })
  .strict()
  .default({ username: null, passwordCredentialRef: null });

const sshProfilePatchSchema = z
  .object({
    username: profileUsernameSchema.removeDefault().optional(),
    passwordCredentialRef: profileCredentialRefSchema.removeDefault().optional(),
    privateKeyCredentialRef: profileCredentialRefSchema.removeDefault().optional(),
    passphraseCredentialRef: profileCredentialRefSchema.removeDefault().optional(),
    certificateCredentialRef: profileCredentialRefSchema.removeDefault().optional(),
  })
  .strict();

const passwordProfilePatchSchema = z
  .object({
    username: profileUsernameSchema.removeDefault().optional(),
    passwordCredentialRef: profileCredentialRefSchema.removeDefault().optional(),
  })
  .strict();

export const connectionProfileSchema = z
  .object({
    ...entityFields,
    name: z.string().trim().min(1).max(60),
    isDefault: z.boolean(),
    ssh: sshProfileValuesSchema,
    telnet: passwordProfileValuesSchema,
    vnc: passwordProfileValuesSchema,
    rdp: passwordProfileValuesSchema,
    ftp: passwordProfileValuesSchema,
    spice: passwordProfileValuesSchema,
  })
  .strict();

export const connectionProfileInputSchema = z
  .object({
    name: connectionProfileSchema.shape.name,
    isDefault: z.boolean().default(false),
    ssh: sshProfileValuesSchema,
    telnet: passwordProfileValuesSchema,
    vnc: passwordProfileValuesSchema,
    rdp: passwordProfileValuesSchema,
    ftp: passwordProfileValuesSchema,
    spice: passwordProfileValuesSchema,
  })
  .strict();

export const connectionProfilePatchSchema = z
  .object({
    name: connectionProfileSchema.shape.name.optional(),
    isDefault: z.boolean().optional(),
    ssh: sshProfilePatchSchema.optional(),
    telnet: passwordProfilePatchSchema.optional(),
    vnc: passwordProfilePatchSchema.optional(),
    rdp: passwordProfilePatchSchema.optional(),
    ftp: passwordProfilePatchSchema.optional(),
    spice: passwordProfilePatchSchema.optional(),
  })
  .strict()
  .refine(
    (input) =>
      Object.values(input).some(
        (value) => value === null || typeof value !== 'object' || Object.keys(value).length > 0,
      ),
    'Connection Profile update is empty',
  );

export const connectionProfileIdSchema = z
  .object({ connectionProfileId: idSchema.nullable() })
  .strict();

export type SshProfileValues = z.infer<typeof sshProfileValuesSchema>;
export type PasswordProfileValues = z.infer<typeof passwordProfileValuesSchema>;
export type ConnectionProfile = z.infer<typeof connectionProfileSchema>;
export type ConnectionProfileInput = z.input<typeof connectionProfileInputSchema>;
export type ConnectionProfilePatch = z.input<typeof connectionProfilePatchSchema>;
