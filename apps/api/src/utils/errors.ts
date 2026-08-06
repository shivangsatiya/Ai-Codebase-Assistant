/**
 * Why a custom error hierarchy instead of throwing plain Error or strings?
 *
 * Services shouldn't know about HTTP. A service saying "this email is
 * already taken" shouldn't need to know it becomes a 409 — that's a
 * presentation-layer concern. So services throw a typed AppError with a
 * machine-readable `code`, and one piece of middleware (error-handler.ts)
 * is the single place that maps codes -> status codes. Add a new error
 * type once, get consistent handling everywhere it's thrown.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super('CONFLICT', message, 409);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super('VALIDATION_ERROR', message, 422);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Invalid credentials') {
    super('UNAUTHORIZED', message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super('FORBIDDEN', message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super('NOT_FOUND', message, 404);
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Too many requests') {
    super('RATE_LIMITED', message, 429);
  }
}

export class NotImplementedError extends AppError {
  constructor(message = 'Not implemented yet') {
    super('NOT_IMPLEMENTED', message, 501);
  }
}
