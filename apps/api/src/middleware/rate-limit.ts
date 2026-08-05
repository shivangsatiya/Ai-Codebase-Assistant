import { rateLimit, MINUTE, HOUR, ipKeyGenerator } from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { RateLimitedError } from '../utils/errors';
import type { AuthenticatedRequest } from './require-auth';

/**
 * Every limiter reports through the same error shape as the rest of the
 * API ({ error: { code, message } }) rather than express-rate-limit's
 * default response - the client shouldn't need a special case for "the
 * request was fine, but there were too many of them" versus any other
 * handled error.
 */
function rateLimitHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(new RateLimitedError());
}

/**
 * IP-based, not user-based - applied to /register and /login, where no
 * authenticated identity exists yet. The known weakness (shared IPs -
 * NAT, corporate networks, mobile carriers - punish everyone behind one
 * address for one abuser's attempts) is the same trade-off this project
 * already hit for real with GitHub's unauthenticated rate limit during
 * Day 3-4. It's still the right choice here: there is no better identity
 * to key on before a user has authenticated at all.
 *
 * Deliberately ONE shared limiter instance applied to BOTH routes, not
 * one each - meaning register and login draw from the same combined
 * budget per IP (5 total auth attempts per 15 minutes, not 5 of each).
 * This is a real design decision, not an oversight: separate budgets
 * would let an attacker interleave register and login attempts to
 * effectively double their allowed request rate against this endpoint
 * pair. A combined budget closes that gap, at the cost of a legitimate
 * user's login attempts counting against the same pool as any
 * registration attempts they made moments earlier - an acceptable
 * trade-off for how rarely a real user does both in quick succession.
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * MINUTE,
  limit: env.RATE_LIMIT_AUTH_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

/**
 * Why wrap the IP fallback in ipKeyGenerator() instead of using req.ip
 * directly?
 *
 * This fallback should never actually execute — both limiters that use
 * it only run AFTER requireAuth, which always sets req.userId or stops
 * the request before reaching here. But express-rate-limit can't know
 * that statically: it sees a function that COULD return a raw IP and
 * refuses to start (ERR_ERL_KEY_GEN_IPV6) until it's wrapped. The real
 * concern the check is protecting against: a raw IPv6 address is often
 * one of many addresses assigned to the same client/subnet, so keying
 * on it directly would let an attacker rotate through addresses to
 * bypass the limit entirely. ipKeyGenerator() normalizes to a subnet
 * prefix instead, closing that gap even in this defensive, effectively
 * dead code path.
 */
function userOrIpKey(req: Request): string {
  const userId = (req as AuthenticatedRequest).userId;
  if (userId) return userId;
  return ipKeyGenerator(req.ip ?? 'unknown');
}

/**
 * User-based (keyed by the authenticated user's id, not their IP) -
 * MUST be applied after requireAuth in the middleware chain, since
 * req.userId doesn't exist until that middleware sets it. Importing a
 * repository triggers a real clone plus CPU-bound local embedding
 * inference - the most expensive single operation this API performs -
 * so this is the strictest of the three limiters.
 */
export const importRateLimiter = rateLimit({
  windowMs: HOUR,
  limit: env.RATE_LIMIT_IMPORT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  handler: rateLimitHandler,
});

/**
 * User-based, same reasoning as importRateLimiter. Looser than import
 * (30/hour vs 10/hour) since a single chat message costs one Groq call
 * and one local query embedding - real but meaningfully cheaper than a
 * full repository import.
 */
export const chatRateLimiter = rateLimit({
  windowMs: HOUR,
  limit: env.RATE_LIMIT_CHAT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  handler: rateLimitHandler,
});

/**
 * User-based, same reasoning as importRateLimiter/chatRateLimiter.
 * Applied to GET /api/auth/github specifically - being authenticated
 * doesn't rate-limit anything on its own, and nothing else stops a
 * buggy client (or a confused user double-clicking) from spamming
 * GitHubOAuthState record creation. A real gap the design review
 * required fixing, not present in the original design.
 */
export const githubOAuthRateLimiter = rateLimit({
  windowMs: HOUR,
  limit: env.RATE_LIMIT_GITHUB_OAUTH_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  handler: rateLimitHandler,
});
