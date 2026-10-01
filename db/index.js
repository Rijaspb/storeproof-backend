import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
});

// Without this handler, an error on an idle connection crashes the process
pool.on('error', (err) => console.error('Database pool error:', err.message));

export default pool;
