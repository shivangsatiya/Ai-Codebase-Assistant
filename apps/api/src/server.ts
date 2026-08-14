import { createApp } from './app';
import { connectDB, disconnectDB } from './config/db';
import { env } from './config/env';
import { staleJobRecoveryService } from './config/composition-root';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  await connectDB();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API server started');
  });

  // Milestone 4 Task 4.4 - the actual recovery mechanism for jobs
  // stuck by a crashed worker, or failed with a transient error worth
  // retrying. See stale-job-recovery.service.ts's own doc comment for
  // the real, honest multi-instance limitation of running this as a
  // plain in-process interval.
  const sweepIntervalHandle = staleJobRecoveryService.start(env.STALE_JOB_SWEEP_INTERVAL_MS);

  // Graceful shutdown: stop accepting new connections, let in-flight
  // requests finish, then close the DB connection — a `kill` from Render
  // or Docker shouldn't cut off a request mid-response.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down gracefully');
    clearInterval(sweepIntervalHandle);
    server.close(async () => {
      await disconnectDB();
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error during startup');
  process.exit(1);
});
