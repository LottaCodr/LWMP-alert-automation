import crypto from 'node:crypto';
import { z } from 'zod';

/**
 * Typed, validated process configuration.
 *
 * Reading `process.env` ad-hoc across modules makes it impossible to know what a
 * deployment needs. Everything is parsed once at boot: production refuses to
 * start with missing secrets, development falls back to explicit demo values.
 */

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().min(1).optional(),
  MIGRATIONS_DATABASE_URL: z.string().min(1).optional(),
  PG_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  PGSSLMODE: z.string().optional(),
  PG_SSL_REJECT_UNAUTHORIZED: z.string().optional(),

  SESSION_SECRET: z.string().min(1).optional(),
  FIELD_ENCRYPTION_KEY: z.string().min(1).optional(),
  PHONE_HASH_KEY: z.string().min(1).optional(),

  APP_ORIGIN: z.string().min(1).optional(),
  WEBAUTHN_ORIGIN: z.string().min(1).optional(),
  WEBAUTHN_RP_ID: z.string().min(1).optional(),
  TOTP_ISSUER: z.string().default('Living Water Mega Parish'),
  /** Comma-separated list of browser origins allowed to call the API with credentials. */
  CORS_ORIGINS: z.string().optional(),
  /** Injected by Render; used as a last-resort base URL for invitation links. */
  RENDER_EXTERNAL_URL: z.string().optional(),

  MESSAGE_MODE: z.enum(['mock', 'live']).default('mock'),
  EMAIL_MODE: z.enum(['mock', 'resend']).default('mock'),
  RESEND_API_KEY: z.string().optional(),
  INVITE_FROM_EMAIL: z.string().optional(),

  META_WHATSAPP_TOKEN: z.string().optional(),
  META_PHONE_NUMBER_ID: z.string().optional(),
  META_BIRTHDAY_TEMPLATE: z.string().optional(),
  META_TEMPLATE_LANGUAGE: z.string().default('en_US'),
  META_GRAPH_VERSION: z.string().default('v23.0'),
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  META_APP_SECRET: z.string().optional(),

  TERMII_API_KEY: z.string().optional(),
  TERMII_SENDER_ID: z.string().optional(),
  TERMII_WEBHOOK_SECRET: z.string().optional(),
  TERMII_BASE_URL: z.string().default('https://v3.api.termii.com'),
  TERMII_SMS_CHANNEL: z.string().default('dnd'),
  TERMII_OTP_MODE: z.enum(['native', 'local']).default('native'),

  /** Log threshold. Defaults to debug in development and info in production. */
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  PROVIDER_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(3000).max(30000).default(10000),
  SCHEDULER_ENABLED: z.enum(['true', 'false']).default('false'),
  SEED_DEMO_DATA: z.enum(['true', 'false']).optional(),
});

export type AppConfig = z.infer<typeof envSchema> & {
  isProduction: boolean;
  isTest: boolean;
};

function load(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n- ${issues.join('\n- ')}`);
  }

  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';

  if (isProduction) {
    const missing: string[] = [];
    if (!env.DATABASE_URL) missing.push('DATABASE_URL');
    if (!env.SESSION_SECRET) missing.push('SESSION_SECRET');
    if (!env.FIELD_ENCRYPTION_KEY) missing.push('FIELD_ENCRYPTION_KEY');
    if (!env.PHONE_HASH_KEY) missing.push('PHONE_HASH_KEY');
    if (!env.APP_ORIGIN) missing.push('APP_ORIGIN');
    if (!env.WEBAUTHN_ORIGIN) missing.push('WEBAUTHN_ORIGIN');
    if (!env.WEBAUTHN_RP_ID) missing.push('WEBAUTHN_RP_ID');
    if (missing.length) {
      throw new Error(
        `Refusing production startup: configure ${missing.join(', ')} through your host's encrypted environment variables.`,
      );
    }
    if (env.EMAIL_MODE !== 'resend' || !env.RESEND_API_KEY || !env.INVITE_FROM_EMAIL) {
      throw new Error(
        'Refusing production startup: configure staff-invitation email (EMAIL_MODE=resend, RESEND_API_KEY, INVITE_FROM_EMAIL).',
      );
    }
    if (env.MESSAGE_MODE === 'live') {
      const deliveryMissing = (
        [
          ['META_WHATSAPP_TOKEN', env.META_WHATSAPP_TOKEN],
          ['META_PHONE_NUMBER_ID', env.META_PHONE_NUMBER_ID],
          ['META_BIRTHDAY_TEMPLATE', env.META_BIRTHDAY_TEMPLATE],
          ['META_APP_SECRET', env.META_APP_SECRET],
          ['TERMII_API_KEY', env.TERMII_API_KEY],
          ['TERMII_SENDER_ID', env.TERMII_SENDER_ID],
          ['TERMII_WEBHOOK_SECRET', env.TERMII_WEBHOOK_SECRET],
        ] as const
      )
        .filter(([, value]) => !value)
        .map(([name]) => name);
      if (deliveryMissing.length) {
        throw new Error(
          `Refusing live delivery startup: configure ${deliveryMissing.join(', ')} or keep MESSAGE_MODE=mock.`,
        );
      }
    }
  }

  return { ...env, isProduction, isTest: env.NODE_ENV === 'test' };
}

export const config = load();

/** True when the data store is the in-memory runtime, so per-process secrets are safe. */
const isEphemeralDatabase = (config.DATABASE_URL ?? '').startsWith('pgmem://');

/**
 * Cryptographic material, resolved once at boot.
 *
 * No secret is committed to this repository. In production all three are
 * mandatory (validated above). Outside production:
 *   - the in-memory `pgmem://` runtime gets fresh per-process values, which is
 *     safe because that data does not outlive the process;
 *   - any real database refuses to start, because falling back to a published
 *     key would silently encrypt member data with material that is in git.
 */
function resolveMaterial(name: string, value: string | undefined): string {
  if (value) return value;
  if (isEphemeralDatabase) return crypto.randomBytes(32).toString('base64');
  throw new Error(
    `Refusing to start: set ${name} in your environment (see .env.example). Generate one with \`openssl rand -base64 32\`. Only the in-memory pgmem:// runtime may start without it.`,
  );
}

export const sessionSecret = resolveMaterial('SESSION_SECRET', config.SESSION_SECRET);
export const fieldEncryptionMaterial = resolveMaterial('FIELD_ENCRYPTION_KEY', config.FIELD_ENCRYPTION_KEY);
export const phoneHashMaterial = resolveMaterial('PHONE_HASH_KEY', config.PHONE_HASH_KEY);

/**
 * Meta webhook subscription token. Generated per process when unset so nothing
 * credential-like is committed; set `META_WEBHOOK_VERIFY_TOKEN` for a stable
 * value while wiring up the Meta developer console.
 */
export const webhookVerifyToken = config.META_WEBHOOK_VERIFY_TOKEN ?? crypto.randomBytes(24).toString('hex');

/** True when simulated delivery is safe to expose in the UI (mock mode outside production). */
export const exposesDemoHints = !config.isProduction && config.MESSAGE_MODE === 'mock';

export function providerRequestTimeoutMs(): number {
  return config.PROVIDER_REQUEST_TIMEOUT_MS;
}
