// Better Auth configuration (D-029).
//
// Our tables are snake_case and plural (and `user` is reserved in
// PostgreSQL), so each library model and field is mapped to our names below.
// The tables come from our own migrations, never Better Auth's CLI.
import { betterAuth } from 'better-auth';
import { config } from './config.js';
import { pool } from './db.js';
import { hashPassword, verifyPassword } from './password.js';

// shortcut: Better Auth's rate limit uses its defaults (kept in memory, on only in production, reset on every restart), move it to database storage if a second instance appears or restarts start resetting limits under attack (D-029 C)
export const auth = betterAuth({
  database: pool,
  secret: config.authSecret,
  baseURL: config.authUrl,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 15,
    maxPasswordLength: 128,
    // Our own scrypt settings, stored in each hash (src/password.ts).
    password: { hash: hashPassword, verify: verifyPassword },
  },
  telemetry: { enabled: false },
  advanced: {
    // Keep the origin and CSRF checks on everywhere. Without this, Better
    // Auth turns them off when NODE_ENV is test or TEST is set (D-029).
    disableOriginCheck: false,
    // Read the client IP only from Cloudflare's cf-connecting-ip. On Render,
    // x-forwarded-for holds several addresses (one can be forged), and Better
    // Auth would then put everyone in one rate-limit bucket (D-031).
    ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
  },
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
