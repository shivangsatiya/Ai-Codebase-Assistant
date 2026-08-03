import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { UnauthorizedError } from '../utils/errors';

export interface AuthenticatedRequest extends Request {
  userId?: string;
}

interface AccessTokenPayload {
  sub: string;
  type: 'access' | 'refresh';
}

function isAccessTokenPayload(payload: unknown): payload is AccessTokenPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'sub' in payload &&
    'type' in payload &&
    (payload as AccessTokenPayload).type === 'access'
  );
}

export function requireAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    next(new UnauthorizedError('Missing or malformed Authorization header'));
    return;
  }

  const token = header.slice('Bearer '.length);

  try {
    const payload = jwt.verify(token, env.JWT_SECRET);

    // Reject refresh tokens presented as access tokens — otherwise a
    // longer-lived refresh token could be used directly against protected
    // routes, defeating the point of having two token types.
    if (!isAccessTokenPayload(payload)) {
      next(new UnauthorizedError('Invalid token type'));
      return;
    }

    req.userId = payload.sub;
    next();
  } catch {
    next(new UnauthorizedError('Invalid or expired token'));
  }
}
