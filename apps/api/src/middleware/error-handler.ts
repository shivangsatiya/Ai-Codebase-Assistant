import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * Why one error-handling middleware instead of try/catch + res.status()
 * scattered in every route?
 *
 * Every response error, from any route, has the exact same shape:
 * { error: { code, message } }. The frontend can write one error-handling
 * path instead of guessing the shape per-endpoint. And every unexpected
 * error (a bug, not an AppError) gets logged with full detail server-side
 * but never leaks a stack trace or internal detail to the client.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    logger.warn({ requestId: req.id, code: err.code, message: err.message }, 'Handled error');
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message },
    });
    return;
  }

  // express.json() (via body-parser) throws a SyntaxError with its own
  // `statusCode`/`status` of 400 when the request body isn't valid JSON.
  // That's a malformed CLIENT request, not a bug in our code — without
  // this check it was falling through to the generic 500 branch below,
  // hiding a routine "you sent bad JSON" behind a scary-looking
  // "something went wrong" message.
  if (
    err instanceof SyntaxError &&
    'status' in err &&
    (err as { status?: number }).status === 400 &&
    'body' in err
  ) {
    logger.warn({ requestId: req.id }, 'Malformed JSON in request body');
    res.status(400).json({
      error: { code: 'MALFORMED_JSON', message: 'Request body must be valid JSON' },
    });
    return;
  }

  // Mongoose throws a CastError when a route param (like :id) isn't a
  // validly-formatted ObjectId - e.g. GET /repositories/not-a-real-id.
  // That's a routine malformed request, not a server bug, so it gets a
  // clean 400 rather than falling through to the generic 500 below.
  if (err instanceof Error && err.name === 'CastError') {
    logger.warn({ requestId: req.id, message: err.message }, 'Invalid ID format in request');
    res.status(400).json({
      error: { code: 'INVALID_ID', message: 'The provided ID is not a valid identifier' },
    });
    return;
  }

  // Anything reaching here is a bug, not an expected failure mode —
  // log full detail server-side, return a generic message to the client.
  logger.error({ requestId: req.id, err }, 'Unhandled error');
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' },
  });
}
