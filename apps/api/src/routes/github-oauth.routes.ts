import { Router, type Response, type NextFunction, type Request } from 'express';
import { githubOAuthService } from '../config/composition-root';
import { requireAuth, type AuthenticatedRequest } from '../middleware/require-auth';
import { githubOAuthRateLimiter } from '../middleware/rate-limit';
import { logger } from '../utils/logger';

export const githubOAuthRouter = Router();

/**
 * Escapes the handful of characters that matter for safely interpolating
 * a value into HTML. GitHub's own username rules make injecting HTML
 * through a legitimate username effectively impossible today, but
 * relying on an upstream service's validation rules as the ONLY defense
 * against writing untrusted-shaped data into HTML is exactly the kind
 * of assumption worth not making, regardless of how unlikely it is to
 * matter in practice right now.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Minimal, deliberate exception to this API being pure JSON everywhere
 * else: a human's actual browser lands on the callback URL directly
 * after approving (or declining) on GitHub's own page - there is no
 * frontend yet to hand a JSON response to, and showing raw JSON to a
 * person in a browser tab would be a real UX regression compared to
 * literally every other response in this project. No templating engine
 * or new dependency for this - just a small inline HTML string.
 */
function renderResultPage(res: Response, status: number, title: string, message: string): void {
  res.status(status).type('html').send(
    `<!DOCTYPE html><html><head><title>${title}</title></head>` +
      `<body style="font-family: system-ui, sans-serif; max-width: 480px; margin: 4rem auto; text-align: center;">` +
      `<h1>${title}</h1><p>${message}</p></body></html>`,
  );
}

githubOAuthRouter.get(
  '/github',
  requireAuth,
  githubOAuthRateLimiter,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const authorizeUrl = await githubOAuthService.initiateConnect(req.userId as string);
      res.redirect(authorizeUrl);
    } catch (err) {
      next(err);
    }
  },
);

githubOAuthRouter.get('/github/callback', async (req: Request, res: Response) => {
  // If the user clicks "Cancel" on GitHub's own consent screen, GitHub
  // redirects here with an `error` param instead of `code`/`state` -
  // this is an expected, normal user choice, not a broken request.
  if (req.query.error) {
    renderResultPage(res, 200, 'GitHub connection cancelled', 'You declined the request. No changes were made.');
    return;
  }

  const code = req.query.code;
  const state = req.query.state;

  if (typeof code !== 'string' || typeof state !== 'string') {
    renderResultPage(res, 400, 'Something went wrong', 'This link is missing required information. Please try connecting again.');
    return;
  }

  try {
    const { githubUsername } = await githubOAuthService.handleCallback(code, state);
    renderResultPage(
      res,
      200,
      'GitHub connected',
      `Successfully connected as <strong>${escapeHtml(githubUsername)}</strong>. You can close this tab.`,
    );
  } catch (err) {
    // This route deliberately never falls through to the app's normal
    // JSON error-handler middleware - every response here is HTML,
    // success or failure, since a human's browser is what's looking at
    // it. The real error is still logged server-side in full.
    logger.error({ err }, 'GitHub OAuth callback failed');
    renderResultPage(
      res,
      400,
      'Connection failed',
      'Something went wrong connecting your GitHub account. Please try again.',
    );
  }
});

githubOAuthRouter.delete(
  '/github',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await githubOAuthService.disconnect(req.userId as string);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);
