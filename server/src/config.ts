import { z } from 'zod';

export type NodeEnv = 'development' | 'test' | 'production';

export interface Config {
  port: number;
  nodeEnv: NodeEnv;
  databaseUrl: string;
}

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

// Zod schema for all three environment variables (D-022). The PORT field calls
// parsePort so both the schema and the standalone function stay in sync.
const envSchema = z.object({
  PORT: z
    .string()
    .optional()
    .transform((val) => parsePort(val)),
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  DATABASE_URL: databaseUrlSchema,
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const messages = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new Error(`Environment configuration error: ${messages}`);
}

export const config: Config = {
  port: parsed.data.PORT,
  nodeEnv: parsed.data.NODE_ENV as NodeEnv,
  databaseUrl: parsed.data.DATABASE_URL,
};
