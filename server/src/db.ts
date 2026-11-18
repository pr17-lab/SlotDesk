import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

// One connection pool for the entire application. No queries run at startup;
// the pool connects on first use. One DATABASE_URL is used by the app and by
// migrations; in production it is Neon's direct (non-pooled) connection
// string (D-031).
export const pool = new pg.Pool({ connectionString: config.databaseUrl });

// pg-pool re-emits an idle client's connection error on the pool, and an
// 'error' event with no listener crashes Node. The pool removes that client
// by itself, so logging is all we do.
pool.on('error', (err) => {
  logger.error({ err }, 'Idle database client error');
});

// Runs `work` inside one transaction on one pooled client: BEGIN, then
// `work`, then COMMIT. If `work` throws, the transaction is rolled back and
// the error is rethrown. Every function that needs a transaction uses this,
// so the lost-connection rule (D-014) lives in one place.
export async function withTransaction<T>(
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let discardClient = false;
  // A checked-out client has no 'error' listener (pg-pool removes its own
  // while the client is out), and pg emits 'error' when the connection drops.
  // Without this listener that event would crash the whole process.
  const onError = (): void => {
    discardClient = true;
  };
  client.on('error', onError);
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discardClient = true;
    }
    throw error;
  } finally {
    client.removeListener('error', onError);
    // A truthy value makes pg-pool destroy the client instead of reusing a
    // connection whose transaction state is unknown.
    client.release(discardClient);
  }
}
