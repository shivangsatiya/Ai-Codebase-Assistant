import pinoHttp from 'pino-http';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';

/**
 * pino-http attaches a unique `req.id` to every request and logs a single
 * structured line per request/response pair, including latency. This is
 * what error-handler.ts references as `req.id` — the same id ties
 * together "request came in" / "error happened" / "response went out" in
 * the logs, which is what actually makes production debugging tractable
 * once there's more than one request in flight at a time.
 */
export const requestLogger = pinoHttp({
  logger,
  genReqId: (req) => (req.headers['x-request-id'] as string) || randomUUID(),
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
});
