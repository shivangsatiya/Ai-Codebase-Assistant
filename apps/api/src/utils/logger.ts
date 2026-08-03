import pino from 'pino';
import { env } from '../config/env';

/**
 * Why pino instead of console.log?
 *
 * console.log produces unstructured text — fine to read in a terminal,
 * useless to search or alert on once you have real traffic. "find every
 * failed login for this user in the last hour" is a grep-and-pray exercise
 * with console.log, and a one-line query against structured JSON logs with
 * pino. Every log line here is a JSON object with consistent fields
 * (level, time, msg, plus whatever context we attach), which is what makes
 * request-id correlation in the logging middleware actually useful.
 */

/**
 * Fields redacted from every log line, wherever they appear in the
 * object being logged - not just at one specific path.
 *
 * `req.headers.authorization` / `req.headers.cookie` address the
 * specific, verified leak: pino-http serializes every request's headers
 * into every log line, and the bearer token was showing up in plaintext
 * on every authenticated request.
 *
 * The wildcard entries (`*.password`, `*.accessToken`, etc.) are defense
 * in depth: they redact a field by NAME regardless of where it shows up
 * in a logged object's shape. That matters because the alternative -
 * remembering to scrub sensitive fields by hand at every call site that
 * might log an object containing one - fails silently the one time a
 * future change logs a full user or token object without thinking about
 * it. Redacting by name is the "secure by default" version of this;
 * remembering by convention is the "secure until someone forgets" one.
 *
 * Exported as a named constant (not inlined into the pino() call below)
 * specifically so the test suite asserts against this exact list rather
 * than a hand-copied duplicate - a redaction list that can silently
 * drift from what's actually configured is worse than having no test at
 * all, since it would report success while protecting nothing.
 */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.passwordHash',
  '*.accessToken',
  '*.refreshToken',
  '*.token',
];

export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: {
    paths: REDACTED_PATHS,
    censor: '[Redacted]',
  },
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});
