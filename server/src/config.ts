import path from 'node:path';
import { z } from 'zod';

// Exported on its own so the unit tests can hit every branch. The schema
// below calls it too, so there's one set of rules.
export const parsePort = (value: string | undefined): number => {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') {
    return 3000;
  }
  // Digits only, before Number() gets a chance to accept 0x10, 1e3 or 3000.5.
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

// DATABASE_URL must be a postgres: or postgresql: URL. Exported for tests.
export const databaseUrlSchema = z
  .string()
  .url({ message: 'DATABASE_URL must be a valid URL' })
  .refine(
    (val) => val.startsWith('postgres://') || val.startsWith('postgresql://'),
    { message: 'DATABASE_URL must use the postgres: or postgresql: scheme' },
  );

// The messages name the variable but never show its value, so the secret
// can't leak into a log.
export const authSecretSchema = z
  .string({ message: 'BETTER_AUTH_SECRET is required' })
  .min(32, { message: 'BETTER_AUTH_SECRET must be at least 32 characters' });

// BETTER_AUTH_URL: the address the browser uses for the app.
export const authUrlSchema = z
  .string({ message: 'BETTER_AUTH_URL is required' })
  .url({ message: 'BETTER_AUTH_URL must be a valid URL' })
  .refine((val) => val.startsWith('http://') || val.startsWith('https://'), {
    message: 'BETTER_AUTH_URL must use the http: or https: scheme',
  });

// All environment variables (D-022). Exported so tests can check the
// production rule without touching process.env.
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
    // Folder of the built React app. Tests point it at a fixture.
    CLIENT_DIST_DIR: z.string().min(1).optional(),
  })
  // In production the session cookie must only travel over HTTPS; http is
  // fine for localhost.
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
  // Defaults to client/dist next to server/. src/ and dist/ sit at the same
  // depth, so this works under tsx and after the build.
  clientDistDir: path.resolve(
    parsed.data.CLIENT_DIST_DIR ??
      path.join(import.meta.dirname, '..', '..', 'client', 'dist'),
  ),
};
