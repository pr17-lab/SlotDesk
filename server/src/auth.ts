// Better Auth configuration (D-021, D-029).
//
// Why the name mapping: our tables are snake_case and plural, and `user` is a
// reserved word in PostgreSQL, so each library model and camelCase field is
// mapped to our own table and column names below.
//
// The identity tables are created by our own node-pg-migrate migrations,
// never by the Better Auth CLI's `migrate` command.
import { betterAuth } from 'better-auth';
import { config } from './config.js';
import { pool } from './db.js';

export const auth = betterAuth({
  database: pool,
  secret: config.authSecret,
  baseURL: config.authUrl,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 15,
    maxPasswordLength: 128,
  },
  telemetry: { enabled: false },
  user: {
    modelName: 'users',
    fields: {
      emailVerified: 'email_verified',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
  session: {
    modelName: 'sessions',
    fields: {
      expiresAt: 'expires_at',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      ipAddress: 'ip_address',
      userAgent: 'user_agent',
      userId: 'user_id',
    },
  },
  account: {
    modelName: 'accounts',
    fields: {
      accountId: 'account_id',
      providerId: 'provider_id',
      userId: 'user_id',
      accessToken: 'access_token',
      refreshToken: 'refresh_token',
      idToken: 'id_token',
      accessTokenExpiresAt: 'access_token_expires_at',
      refreshTokenExpiresAt: 'refresh_token_expires_at',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
  verification: {
    modelName: 'verifications',
    fields: {
      expiresAt: 'expires_at',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
});
