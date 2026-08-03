import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import type { IUserRepository } from '../repositories/user.repository';
import type { IRefreshTokenRepository } from '../repositories/refresh-token.repository';
import { ConflictError, UnauthorizedError } from '../utils/errors';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult {
  userId: string;
  email: string;
  tokens: AuthTokens;
}

interface TokenPayload {
  sub: string;
  type: 'access' | 'refresh';
  jti?: string;
}

/**
 * Why does AuthService take its dependencies (repositories, bcrypt salt
 * rounds) via constructor injection instead of importing them at the top
 * of the file?
 *
 * This is what actually makes "clean architecture" real rather than a
 * folder-naming exercise. Because AuthService depends on interfaces, not
 * concrete Mongo-backed classes, a unit test can inject fake repositories
 * and test password-hashing edge cases, duplicate-email handling, JWT
 * payload shape, and refresh-token rotation — none of which require a
 * running MongoDB instance. The wiring that decides "use the real Mongo
 * repositories" happens once, in the composition root, at startup.
 */
export class AuthService {
  constructor(
    private readonly userRepository: IUserRepository,
    private readonly refreshTokenRepository: IRefreshTokenRepository,
    private readonly saltRounds: number = env.BCRYPT_SALT_ROUNDS,
  ) {}

  async register(email: string, password: string): Promise<AuthResult> {
    const existing = await this.userRepository.findByEmail(email);
    if (existing) {
      throw new ConflictError('An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(password, this.saltRounds);
    const user = await this.userRepository.create({ email, passwordHash });

    return {
      userId: user._id.toString(),
      email: user.email,
      tokens: await this.issueTokens(user._id.toString()),
    };
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.userRepository.findByEmail(email);
    if (!user) {
      // Intentionally the same error/message as a wrong password below.
      // Distinguishing "no such user" from "wrong password" in the
      // response lets an attacker enumerate valid emails. Same error,
      // same status code, every time.
      throw new UnauthorizedError();
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedError();
    }

    return {
      userId: user._id.toString(),
      email: user.email,
      tokens: await this.issueTokens(user._id.toString()),
    };
  }

  /**
   * Rotation with reuse detection: every successful refresh burns the
   * presented token and issues a brand new pair, including a new refresh
   * token with a new jti. If a refresh token is EVER presented twice
   * (its jti is found but already revoked), that's the specific signal
   * of theft — a legitimate client always uses the newest token it was
   * issued and would never present an already-rotated-out one. The
   * response is to revoke every refresh token for that user, not just
   * the reused one, since an attacker holding one stolen token from a
   * session may already hold a more recent one too.
   */
  async refresh(refreshToken: string): Promise<AuthResult> {
    const payload = this.verifyToken(refreshToken, 'refresh');

    const stored = await this.refreshTokenRepository.findByJti(payload.jti as string);
    if (!stored) {
      // Unknown jti — either forged, or its record was already cleaned
      // up by the TTL index after naturally expiring. Either way, not a
      // valid refresh attempt.
      throw new UnauthorizedError('Invalid or expired refresh token');
    }

    if (stored.revokedAt) {
      const userId = stored.userId.toString();
      await this.refreshTokenRepository.revokeAllForUser(userId);
      logger.warn({ userId }, 'Refresh token reuse detected — all sessions revoked');
      throw new UnauthorizedError('Invalid or expired refresh token');
    }

    await this.refreshTokenRepository.revoke(payload.jti as string);

    const user = await this.userRepository.findById(stored.userId.toString());
    if (!user) {
      throw new UnauthorizedError('Invalid or expired refresh token');
    }

    return {
      userId: user._id.toString(),
      email: user.email,
      tokens: await this.issueTokens(user._id.toString()),
    };
  }

  /**
   * Why not throw if the token is already invalid/expired/malformed?
   *
   * The end state of "log out with a bad token" and "log out with a
   * good token" is identical from the client's perspective: no valid
   * session afterward. Treating an already-broken token as a hard error
   * on logout specifically would be surprising — the user is trying to
   * end a session, not authenticate one.
   */
  async logout(refreshToken: string): Promise<void> {
    try {
      const payload = this.verifyToken(refreshToken, 'refresh');
      await this.refreshTokenRepository.revoke(payload.jti as string);
    } catch {
      // Already invalid — nothing to revoke, and that's fine here.
    }
  }

  private verifyToken(token: string, expectedType: 'access' | 'refresh'): TokenPayload {
    let payload: TokenPayload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET) as TokenPayload;
    } catch {
      throw new UnauthorizedError('Invalid or expired refresh token');
    }

    if (payload.type !== expectedType || (expectedType === 'refresh' && !payload.jti)) {
      throw new UnauthorizedError('Invalid or expired refresh token');
    }

    return payload;
  }

  private async issueTokens(userId: string): Promise<AuthTokens> {
    // The installed @types/jsonwebtoken types `expiresIn` as a branded
    // `StringValue` (e.g. a template-literal type like `${number}${'s'|'m'|'h'|'d'}`),
    // not a plain `string`. Our env values are validated at startup by
    // envSchema (config/env.ts) to be non-empty strings, but that
    // validation isn't visible to the type system here, so we assert the
    // narrower type at the one call site rather than loosening it
    // everywhere env.JWT_ACCESS_TOKEN_TTL is used.
    const accessToken = jwt.sign({ sub: userId, type: 'access' }, env.JWT_SECRET, {
      expiresIn: env.JWT_ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
    });

    const jti = randomUUID();
    const refreshToken = jwt.sign({ sub: userId, type: 'refresh', jti }, env.JWT_SECRET, {
      expiresIn: env.JWT_REFRESH_TOKEN_TTL as jwt.SignOptions['expiresIn'],
    });

    // Decoding the just-signed token to read its own `exp` claim avoids
    // needing a separate library to parse a TTL string like "7d" into a
    // Date by hand — jsonwebtoken already did that math once when
    // signing; asking it again via decode() is simpler than duplicating
    // that parsing logic ourselves.
    const decoded = jwt.decode(refreshToken) as { exp: number };
    const expiresAt = new Date(decoded.exp * 1000);

    await this.refreshTokenRepository.create({ jti, userId, expiresAt });

    return { accessToken, refreshToken };
  }
}
