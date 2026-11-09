import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

// One connection pool for the entire application. No queries run at startup;
// the pool connects on first use. There is a single DATABASE_URL until Step 7
// adds a direct-connection URL for Neon (D-023).
export const pool = new pg.Pool({ connectionString: config.databaseUrl });

// pg-pool re-emits an idle client's connection error on the pool, and an
// 'error' event with no listener crashes Node. The pool removes that client
// by itself, so logging is all we do.
pool.on('error', (err) => {
  logger.error({ err }, 'Idle database client error');
});
