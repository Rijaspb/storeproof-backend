import pg from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set');
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000, // server aborts the query
  query_timeout: 12000, // client-side backstop
});

// Without this handler, an error on an idle connection crashes the process
pool.on('error', (err) => console.error('Database pool error:', err.message));

export default pool;
