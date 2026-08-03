import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema } from 'zod';
import { ValidationError } from '../utils/errors';

/**
 * One generic validator, reused for every route's request body — instead
 * of hand-rolling `if (!email) return res.status(422)...` checks in every
 * handler. Route handlers stay thin (per the folder-structure decision:
 * "routes = thin HTTP layer only"); validation logic lives in the schema
 * files, not scattered across controllers.
 */
export function validateBody(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const firstIssue = result.error.issues[0];
      const message = firstIssue ? firstIssue.message : 'Invalid request body';
      return next(new ValidationError(message));
    }

    req.body = result.data;
    next();
  };
}
