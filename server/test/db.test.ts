import { describe, expect, it } from 'vitest';
import pg from 'pg';

describe('database pool', () => {
  it('imports without throwing (pool is created lazily, not at import time)', async () => {
    // Importing db.ts must not throw even when the database is not running.
    // pg.Pool connects on first query, not at construction time.
    const { pool } = await import('../src/db.js');
    expect(pool).toBeInstanceOf(pg.Pool);
  });

  it('pool totalCount is 0 before any query (no eager connection)', async () => {
    const { pool } = await import('../src/db.js');
    // totalCount is 0 until a client is checked out; this proves that
    // constructing the pool does not open a socket to the database.
    expect(pool.totalCount).toBe(0);
  });
});
