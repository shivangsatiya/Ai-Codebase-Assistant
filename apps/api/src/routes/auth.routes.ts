import { Router, type Request, type Response, type NextFunction } from 'express';
import { AuthService } from '../services/auth.service';
import { MongoUserRepository } from '../repositories/user.repository';
import { MongoRefreshTokenRepository } from '../repositories/refresh-token.repository';
import { validateBody } from '../middleware/validate';
import { authRateLimiter } from '../middleware/rate-limit';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  type RegisterInput,
  type LoginInput,
  type RefreshInput,
  type LogoutInput,
} from './auth.schemas';

// Composition root for this route module: the one place that decides
// "use the real Mongo-backed repositories." AuthService itself has no
// idea Mongo exists.
const authService = new AuthService(new MongoUserRepository(), new MongoRefreshTokenRepository());

export const authRouter = Router();

authRouter.post(
  '/register',
  authRateLimiter,
  validateBody(registerSchema),
  async (req: Request<unknown, unknown, RegisterInput>, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body;
      const result = await authService.register(email, password);
      res.status(201).json({
        userId: result.userId,
        email: result.email,
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
      });
    } catch (err) {
      next(err);
    }
  },
);

authRouter.post(
  '/login',
  authRateLimiter,
  validateBody(loginSchema),
  async (req: Request<unknown, unknown, LoginInput>, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body;
      const result = await authService.login(email, password);
      res.status(200).json({
        userId: result.userId,
        email: result.email,
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
      });
    } catch (err) {
      next(err);
    }
  },
);

authRouter.post(
  '/refresh',
  authRateLimiter,
  validateBody(refreshSchema),
  async (req: Request<unknown, unknown, RefreshInput>, res: Response, next: NextFunction) => {
    try {
      const { refreshToken } = req.body;
      const result = await authService.refresh(refreshToken);
      res.status(200).json({
        userId: result.userId,
        email: result.email,
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
      });
    } catch (err) {
      next(err);
    }
  },
);

authRouter.post(
  '/logout',
  authRateLimiter,
  validateBody(logoutSchema),
  async (req: Request<unknown, unknown, LogoutInput>, res: Response, next: NextFunction) => {
    try {
      const { refreshToken } = req.body;
      await authService.logout(refreshToken);
      // 204: the client's next move is the same whether the token was
      // valid or not (discard it, treat the session as ended) - there's
      // no useful response body to return either way.
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);
