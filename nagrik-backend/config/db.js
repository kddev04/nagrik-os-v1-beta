'use strict';
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,                     // Max connections in pool
  min: 2,                      // Min idle connections
  idleTimeoutMillis: 30000,    // Close idle connections after 30s
  connectionTimeoutMillis: 5000, // Fail fast if no connection in 5s
  statement_timeout: 10000,    // Kill queries running > 10s
});

pool.on('connect', () => {
  if (process.env.NODE_ENV === 'development') {
    console.log('[DB] New client connected');
  }
});

pool.on('error', (err) => {
  console.error('[DB] Pool error:', err.message);
});

/**
 * Execute a parameterized query.
 * ALL SQL queries in the app MUST go through this function.
 * This prevents SQL injection by enforcing parameterization.
 *
 * @param {string} text - SQL query with $1, $2 placeholders
 * @param {Array}  params - Values for placeholders
 * @returns {Promise<pg.QueryResult>}
 */
const query = async (text, params = []) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    if (process.env.NODE_ENV === 'development') {
      const ms = Date.now() - start;
      const preview = text.replace(/\s+/g, ' ').substring(0, 70);
      if (ms > 200) console.warn(`[DB SLOW ${ms}ms] ${preview}`);
    }
    return result;
  } catch (err) {
    const preview = text.replace(/\s+/g, ' ').substring(0, 100);
    console.error(`[DB ERROR] ${preview}`);
    console.error(`[DB ERROR] ${err.message}`);
    throw err;
  }
};

/**
 * Get a dedicated client for transactions.
 * Always use try/finally to release the client.
 *
 * Usage:
 *   const client = await getClient();
 *   try {
 *     await client.query('BEGIN');
 *     await client.query(sql1, params1);
 *     await client.query(sql2, params2);
 *     await client.query('COMMIT');
 *   } catch (err) {
 *     await client.query('ROLLBACK');
 *     throw err;
 *   } finally {
 *     client.release();
 *   }
 */
const getClient = () => pool.connect();

/**
 * Check if DB is reachable (used in /health endpoint)
 */
const ping = async () => {
  const result = await query('SELECT 1 AS ok');
  return result.rows[0].ok === 1;
};

module.exports = { query, getClient, ping, pool };
