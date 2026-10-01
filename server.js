import 'dotenv/config';
import app from './app.js';
import db from './db/index.js';

const PORT = process.env.PORT || 3000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Finish in-flight requests and close the DB pool, then exit
function shutdown(signal, exitCode = 0) {
  console.log(`${signal} received, shutting down`);

  // Force exit if connections refuse to drain
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();

  server.close(async () => {
    try {
      await db.end();
      process.exit(exitCode);
    } catch (err) {
      console.error('Error closing DB pool:', err.message);
      process.exit(1);
    }
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Process state is undefined after these; log and exit so the supervisor restarts us
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  shutdown('uncaughtException', 1);
});
