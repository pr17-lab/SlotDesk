import pg from 'pg';
import { config } from './config.js';

// One connection pool for the entire application. No queries run at startup;
// the pool connects on first use. There is a single DATABASE_URL until Step 7
// adds a direct-connection URL for Neon (D-023).
export const pool = new pg.Pool({ connectionString: config.databaseUrl });
