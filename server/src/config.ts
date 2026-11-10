import { z } from 'zod';

// Kept as a standalone exported function so existing unit tests can import and
// exercise every branch directly. The Zod schema below also calls it so the
// config object always goes through the same rules.
export const parsePort = (value: string | undefined): number => {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') {
    return 3000;
  }
  // Reject hex (0x...), scientific notation (1e3), decimals (3000.5), and
  // anything non-numeric before Number() widens the accepted set.
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid PORT "${value}": must be a plain integer between 1 and 65535`,
    );
  }
  const parsed = Number(trimmed);
  if (parsed < 1 || parsed > 65535) {
    throw new Error(
      `Invalid PORT "${value}": must be an integer between 1 and 65535`,
    );
  }
  return parsed;
};

// Zod schema for DATABASE_URL: must be a valid URL with the postgres: or
// postgresql: scheme. Exported so tests can validate individual values without
// constructing a full environment.
export const databaseUrlSchema = z
  .string()
  .url({ message: 'DATABASE_URL must be a valid URL' })
  .refine(
    (val) => val.startsWith('postgres://') || val.startsWith('postgresql://'),
    { message: 'DATABASE_URL must use the postgres: or postgresql: scheme' },
  );

// Zod schema for BETTER_AUTH_SECRET (D-029). Messages name the variable but
// never include its value, so a secret never ends up in a log or error.
export const authSecretSchema = z
  .string({ message: 'BETTER_AUTH_SECRET is required' })
  .min(32, { message: 'BETTER_AUTH_SECRET must be at least 32 characters' });

// Zod schema for BETTER_AUTH_URL (D-029): the public base URL of the app.
export const authUrlSchema = z
  .string({ message: 'BETTER_AUTH_URL is required' })
  .url({ message: 'BETTER_AUTH_URL must be a valid URL' })
  .refine((val) => val.startsWith('http://') || val.startsWith('https://'), {
    message: 'BETTER_AUTH_URL must use the http: or https: scheme',
  });

// Zod schema for all environment variables (D-022, D-029). The PORT field calls
// parsePort so both the schema and the standalone function stay in sync.
// Exported so tests can check the production URL rule without changing
// process.env.
export const envSchema = z
  .object({
    PORT: z
      .string()
      .optional()
      .transform((val) => parsePort(val)),
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    DATABASE_URL: databaseUrlSchema,
    BETTER_AUTH_SECRET: authSecretSchema,
    BETTER_AUTH_URL: authUrlSchema,
  })
  // Session cookies must only travel over HTTPS in production; http:// stays
  // allowed in development and test for localhost.
  .superRefine((env, ctx) => {
    if (
      env.NODE_ENV === 'production' &&
      !env.BETTER_AUTH_URL.startsWith('https://')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['BETTER_AUTH_URL'],
        message: 'BETTER_AUTH_URL must use https:// in production',
      });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const messages = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new Error(`Environment configuration error: ${messages}`);
}

export const config = {
  port: parsed.data.PORT,
  databaseUrl: parsed.data.DATABASE_URL,
  authSecret: parsed.data.BETTER_AUTH_SECRET,
  authUrl: parsed.data.BETTER_AUTH_URL,
};
