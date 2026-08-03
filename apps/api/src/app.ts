import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { env } from './config/env';
import { requestLogger } from './middleware/request-logger';
import { errorHandler } from './middleware/error-handler';
import { authRouter } from './routes/auth.routes';
import { repositoryRouter } from './routes/repository.routes';
import { chatRouter } from './routes/chat.routes';

export function createApp(): Express {
  const app = express();

  /**
   * Why this matters for rate limiting specifically: Render (this
   * project's deployment target) sits in front of every request as a
   * reverse proxy. Without telling Express to trust it, every request's
   * "IP address" as Express sees it is Render's proxy IP, not the real
   * client's - which would make the IP-based auth rate limiter treat
   * every user as the same single caller, either rate-limiting everyone
   * together or (depending on the limiter's exact behavior) not
   * meaningfully limiting anyone. `1` means "trust exactly one hop in
   * front of us," matching Render's single-reverse-proxy setup - a
   * different deployment target (behind multiple proxies/CDNs) would
   * need a different number, not a blind copy of this value.
   */
  app.set('trust proxy', 1);

  app.use(helmet());
  /**
   * Why an explicit allowlist instead of cors()'s permissive default?
   *
   * Bare `cors()` allows every origin (`Access-Control-Allow-Origin: *`).
   * That's low-risk today specifically because this API has no
   * cookie-based auth - every request needs an explicit Bearer token, so
   * a malicious site can't silently ride on a logged-in user's session
   * the way it could with cookies. But "low risk today" and "safe to
   * leave unexamined" are different claims - the moment this API gains
   * cookie-based auth or a browser extension integration, an open origin
   * policy becomes a real CSRF surface. Fixing the permissive default
   * before it's a live problem is cheaper than fixing it after a real
   * frontend already depends on the permissive behavior.
   */
  app.use(cors({ origin: env.ALLOWED_ORIGINS }));
  app.use(express.json({ limit: '1mb' }));
  app.use(requestLogger);

  /**
   * Why two separate endpoints instead of one?
   *
   * Liveness ("is the process running at all, or should it be killed and
   * restarted?") and readiness ("should traffic be routed here right
   * now?") are genuinely different questions, and conflating them means
   * an orchestrator has no way to tell "the process is fine but its
   * database connection dropped" from "the process is actually stuck" -
   * the correct response to each is different (do nothing but wait vs.
   * restart the process). Kubernetes, Render, and most orchestrators
   * expect exactly this split as separate probes, not one combined
   * endpoint.
   */
  app.get('/health/live', (_req, res) => {
    // If this handler can run at all, the process is alive - no
    // dependency checks here on purpose. A liveness probe that checks a
    // downstream dependency (like the database) would cause an
    // orchestrator to kill and restart a perfectly healthy process just
    // because Mongo had a momentary blip - restarting doesn't fix a
    // database problem, it just adds churn on top of it.
    res.status(200).json({ status: 'ok' });
  });

  app.get('/health/ready', (_req, res) => {
    // mongoose.connection.readyState: 0 = disconnected, 1 = connected,
    // 2 = connecting, 3 = disconnecting. Only fully connected (1) counts
    // as ready - every route beyond a static response touches MongoDB,
    // so "connecting" or "disconnecting" both mean requests would fail
    // right now even though the process itself is alive.
    const isReady = mongoose.connection.readyState === 1;
    res.status(isReady ? 200 : 503).json({
      status: isReady ? 'ready' : 'not ready',
      mongo: mongoose.connection.readyState,
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/repositories', repositoryRouter);
  app.use('/api/chats', chatRouter);

  // Must be registered last — Express identifies error-handling
  // middleware by its four-argument signature (err, req, res, next), so
  // its position in the middleware chain, after every route, is what
  // makes it catch errors thrown/forwarded (via next(err)) anywhere above.
  app.use(errorHandler);

  return app;
}
