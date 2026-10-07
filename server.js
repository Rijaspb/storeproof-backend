import 'dotenv/config';
import app from './app.js';
import db from './db/index.js';

const PORT = process.env.PORT || 3000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

const server = app.listen(PORT, (err) => {
  if (err) return;
  console.log(`Server running on http://localhost:${PORT}`);
});

server.on('error', (err) => {
  console.error('Server failed to start:', err.message);
  process.exit(1);
});

// Finish in-flight requests and close the DB pool, then exit
let shuttingDown = false;
function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
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

// Unexpected process errors can leave the app in an unsafe state; exit so the supervisor restarts it
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  shutdown('uncaughtException', 1);
});
