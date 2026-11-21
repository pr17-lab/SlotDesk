import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

// One connection pool for the whole app; it connects on first use. In
// production DATABASE_URL is Neon's direct, non-pooled string (D-031).
export const pool = new pg.Pool({ connectionString: config.databaseUrl });

// An idle client's connection error comes out on the pool, and an 'error'
// event with no listener crashes Node. The pool drops that client itself, so
// we just log it.
pool.on('error', (err) => {
  logger.error({ err }, 'Idle database client error');
});

// Runs `work` in one transaction: BEGIN, work, COMMIT, or ROLLBACK and
// rethrow if it throws. Every transaction goes through here, so the
// lost-connection handling lives in one place (D-014).
export async function withTransaction<T>(
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let discardClient = false;
  // A checked-out client has no 'error' listener, and pg emits 'error' when
  // the connection drops. Without this, that would crash the whole process.
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
    // true makes the pool throw the client away instead of reusing a
    // connection in an unknown state.
    client.release(discardClient);
  }
}
