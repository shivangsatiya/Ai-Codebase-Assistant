import express from 'express';
import request from 'supertest';
import { rateLimit } from 'express-rate-limit';
import { errorHandler } from '../src/middleware/error-handler';
import { RateLimitedError } from '../src/utils/errors';

/**
 * These tests exercise the real express-rate-limit middleware against a
 * minimal Express app - not a mock of the library. Type-checking that
 * the configuration compiles is not the same as proving the library
 * actually blocks the Nth request; this proves the latter, directly.
 */
function buildTestApp(limit: number, keyGenerator?: (req: express.Request) => string) {
  const app = express();
  app.use(express.json());

  const limiter = rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator } : {}),
    handler: (_req, _res, next) => next(new RateLimitedError()),
  });

  app.get('/test', limiter, (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.use(errorHandler);
  return app;
}

describe('rate limiting', () => {
  it('allows requests up to the configured limit', async () => {
    const app = buildTestApp(3);

    const first = await request(app).get('/test');
    const second = await request(app).get('/test');
    const third = await request(app).get('/test');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
  });

  it("blocks the request that exceeds the limit with a 429 and the app's standard error shape", async () => {
    const app = buildTestApp(2);

    await request(app).get('/test');
    await request(app).get('/test');
    const thirdRequest = await request(app).get('/test');

    expect(thirdRequest.status).toBe(429);
    expect(thirdRequest.body).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
    });
  });

  it('tracks separate counters per key when a custom keyGenerator is used (simulating per-user limiting)', async () => {
    const app = buildTestApp(1, (req) => (req.headers['x-user-id'] as string) ?? 'anonymous');

    // User "alice" uses her one allowed request.
    const aliceFirst = await request(app).get('/test').set('x-user-id', 'alice');
    const aliceSecond = await request(app).get('/test').set('x-user-id', 'alice');

    // User "bob" has his own separate counter - his first request must
    // still succeed even though alice already exhausted her limit. This
    // is the specific behavior importRateLimiter/chatRateLimiter rely on
    // to key by req.userId rather than sharing one global counter.
    const bobFirst = await request(app).get('/test').set('x-user-id', 'bob');

    expect(aliceFirst.status).toBe(200);
    expect(aliceSecond.status).toBe(429);
    expect(bobFirst.status).toBe(200);
  });

  it('sends standard RateLimit-* headers so clients can see their remaining quota', async () => {
    const app = buildTestApp(5);

    const response = await request(app).get('/test');

    expect(response.headers).toHaveProperty('ratelimit-limit');
    expect(response.headers).toHaveProperty('ratelimit-remaining');
  });
});
