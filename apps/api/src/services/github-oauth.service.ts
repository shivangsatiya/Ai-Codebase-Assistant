import { randomBytes } from 'crypto';
import { performance } from 'perf_hooks';
import type { IGitHubOAuthClient } from '../clients/github-oauth.client';
import type { IGitHubConnectionRepository } from '../repositories/github-connection.repository';
import type { IGitHubOAuthStateRepository } from '../repositories/github-oauth-state.repository';
import type { ITokenEncryptor } from '../utils/token-encryptor';
import { UnauthorizedError, NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';

const STATE_TTL_MS = 10 * 60 * 1000; // matches GitHub's own authorization code expiry window
const TOKEN_EXCHANGE_MAX_ATTEMPTS = 2;
const TOKEN_EXCHANGE_RETRY_DELAY_MS = 300;

export class GitHubOAuthService {
  constructor(
    private readonly oauthClient: IGitHubOAuthClient,
    private readonly connectionRepo: IGitHubConnectionRepository,
    private readonly stateRepo: IGitHubOAuthStateRepository,
    private readonly tokenEncryptor: ITokenEncryptor,
  ) {}

  /**
   * Why generate the state here, in the service, rather than in the
   * route?
   *
   * The route's job is HTTP concerns (auth middleware, the redirect
   * itself); deciding how the state value is generated and how long it
   * lives is business logic that belongs with the rest of the OAuth
   * orchestration, testable without spinning up Express at all.
   */
  async initiateConnect(userId: string): Promise<string> {
    const state = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + STATE_TTL_MS);

    await this.stateRepo.create(state, userId, expiresAt);
    logger.info({ userId }, 'GitHub OAuth connect initiated');

    return this.oauthClient.buildAuthorizeUrl(state);
  }

  /**
   * Why does this method take only (code, state) and never a userId
   * parameter, unlike every other authenticated action in this
   * codebase?
   *
   * There is no userId to pass - the caller (the callback route) has no
   * JWT to read one from, since GitHub's redirect carries no
   * Authorization header. Identity is recovered entirely from the
   * consumed state record, which is the whole reason
   * GitHubOAuthStateModel exists. See milestone-2-design.md §2.3.
   */
  async handleCallback(code: string, state: string): Promise<{ userId: string; githubUsername: string }> {
    const startedAt = performance.now();

    const consumed = await this.stateRepo.consumeByState(state);
    if (!consumed) {
      throw new UnauthorizedError('Invalid or expired OAuth state');
    }
    const userId = consumed.userId.toString();

    const { accessToken, scopes } = await this.exchangeCodeWithRetry(code);
    const user = await this.oauthClient.fetchAuthenticatedUser(accessToken);
    const encryptedToken = this.tokenEncryptor.encrypt(accessToken);

    await this.connectionRepo.upsert({
      userId,
      githubUserId: user.githubUserId,
      githubUsername: user.githubUsername,
      encryptedToken,
      scopes,
    });

    const durationMs = Math.round(performance.now() - startedAt);
    logger.info({ userId, githubUsername: user.githubUsername, durationMs }, 'GitHub OAuth connected');

    return { userId, githubUsername: user.githubUsername };
  }

  /**
   * Why does a failed remote revoke not block local disconnection?
   *
   * The user's actual goal is "stop this app from holding my token" -
   * deleting our own stored copy achieves that regardless of whether
   * GitHub's revoke API happens to be reachable at that moment. Blocking
   * local disconnection on a flaky third-party API call would be worse
   * than the alternative: a warning logged, and the token still showing
   * in the user's GitHub "Authorized OAuth Apps" settings until it
   * naturally expires or they revoke it there directly - a minor UX
   * imperfection, not a security hole, since this app can no longer act
   * on a token it no longer has stored anywhere.
   */
  async disconnect(userId: string): Promise<void> {
    const startedAt = performance.now();

    const connection = await this.connectionRepo.findByUserId(userId);
    if (!connection) {
      throw new NotFoundError('No GitHub connection found for this user');
    }

    const plaintextToken = this.tokenEncryptor.decrypt({
      ciphertext: connection.encryptedToken,
      iv: connection.iv,
      authTag: connection.authTag,
      keyVersion: connection.keyVersion,
    });

    try {
      await this.oauthClient.revokeToken(plaintextToken);
    } catch (err) {
      logger.warn({ err, userId }, 'Failed to revoke GitHub token remotely - deleting local connection anyway');
    }

    await this.connectionRepo.deleteByUserId(userId);

    const durationMs = Math.round(performance.now() - startedAt);
    logger.info({ userId, durationMs }, 'GitHub OAuth disconnected');
  }

  /**
   * Why retry only the token exchange, and not the other GitHub calls
   * in this flow?
   *
   * This is the one synchronous, single-shot call with a human actually
   * waiting in a browser tab - if it fails outright with no retry, the
   * user has to redo GitHub's own authorize page from scratch. A brief
   * retry here is worth the complexity; the same isn't true for, say,
   * fetchAuthenticatedUser (immediately follows a just-succeeded
   * exchange, so a transient failure there is much less likely) or
   * revokeToken (already has its own explicit non-blocking failure
   * handling in disconnect()).
   */
  private async exchangeCodeWithRetry(code: string) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= TOKEN_EXCHANGE_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.oauthClient.exchangeCodeForToken(code);
      } catch (err) {
        lastError = err;
        if (attempt < TOKEN_EXCHANGE_MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, TOKEN_EXCHANGE_RETRY_DELAY_MS));
        }
      }
    }
    throw lastError;
  }
}
