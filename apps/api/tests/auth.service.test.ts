import { AuthService } from '../src/services/auth.service';
import type { IUserRepository, CreateUserInput } from '../src/repositories/user.repository';
import type { IRefreshTokenRepository, CreateRefreshTokenInput } from '../src/repositories/refresh-token.repository';
import type { UserDocument } from '../src/models/user.model';
import type { RefreshTokenDocument } from '../src/models/refresh-token.model';
import { ConflictError, UnauthorizedError } from '../src/utils/errors';
import bcrypt from 'bcrypt';

/**
 * This is the payoff of the Repository Pattern described in
 * repositories/user.repository.ts: a fake, in-memory implementation of
 * IUserRepository, with no Mongoose and no database round-trip. These
 * tests run in milliseconds and never touch MongoMemoryServer at all.
 */
class FakeUserRepository implements IUserRepository {
  private users = new Map<string, UserDocument>();
  private idCounter = 0;

  async findByEmail(email: string): Promise<UserDocument | null> {
    for (const user of this.users.values()) {
      if (user.email === email.toLowerCase().trim()) return user;
    }
    return null;
  }

  async findById(id: string): Promise<UserDocument | null> {
    return this.users.get(id) ?? null;
  }

  async create(input: CreateUserInput): Promise<UserDocument> {
    const id = String(++this.idCounter);
    const user = {
      _id: { toString: () => id },
      email: input.email.toLowerCase().trim(),
      passwordHash: input.passwordHash,
      createdAt: new Date(),
    } as unknown as UserDocument;
    this.users.set(id, user);
    return user;
  }
}

/**
 * Same reasoning as FakeUserRepository - lets refresh-token rotation and
 * reuse-detection logic be tested against real service behavior, with
 * zero database involved.
 */
class FakeRefreshTokenRepository implements IRefreshTokenRepository {
  private tokens = new Map<string, { userId: string; expiresAt: Date; revokedAt?: Date }>();

  async create(input: CreateRefreshTokenInput): Promise<RefreshTokenDocument> {
    this.tokens.set(input.jti, { userId: input.userId, expiresAt: input.expiresAt, revokedAt: undefined });
    return this.toDocument(input.jti) as RefreshTokenDocument;
  }

  async findByJti(jti: string): Promise<RefreshTokenDocument | null> {
    return this.toDocument(jti);
  }

  async revoke(jti: string): Promise<void> {
    const record = this.tokens.get(jti);
    if (record) record.revokedAt = new Date();
  }

  async revokeAllForUser(userId: string): Promise<void> {
    for (const record of this.tokens.values()) {
      if (record.userId === userId && !record.revokedAt) {
        record.revokedAt = new Date();
      }
    }
  }

  /** Test-only helper: how many non-revoked tokens exist for a user. */
  activeCountForUser(userId: string): number {
    let count = 0;
    for (const record of this.tokens.values()) {
      if (record.userId === userId && !record.revokedAt) count++;
    }
    return count;
  }

  private toDocument(jti: string): RefreshTokenDocument | null {
    const record = this.tokens.get(jti);
    if (!record) return null;
    return {
      jti,
      userId: { toString: () => record.userId },
      expiresAt: record.expiresAt,
      revokedAt: record.revokedAt,
    } as unknown as RefreshTokenDocument;
  }
}

function createService(saltRounds = 4) {
  const userRepo = new FakeUserRepository();
  const refreshTokenRepo = new FakeRefreshTokenRepository();
  const service = new AuthService(userRepo, refreshTokenRepo, saltRounds);
  return { service, userRepo, refreshTokenRepo };
}

describe('AuthService — register/login', () => {
  it('registers a new user and returns tokens', async () => {
    const { service } = createService();

    const result = await service.register('test@example.com', 'Password123');

    expect(result.email).toBe('test@example.com');
    expect(result.tokens.accessToken).toEqual(expect.any(String));
    expect(result.tokens.refreshToken).toEqual(expect.any(String));
  });

  it('rejects registration with a duplicate email', async () => {
    const { service } = createService();

    await service.register('duplicate@example.com', 'Password123');

    await expect(service.register('duplicate@example.com', 'Password123')).rejects.toThrow(ConflictError);
  });

  it('hashes the password rather than storing it in plain text', async () => {
    const { service, userRepo } = createService();

    await service.register('hash-check@example.com', 'Password123');
    const stored = await userRepo.findByEmail('hash-check@example.com');

    expect(stored?.passwordHash).not.toBe('Password123');
    expect(await bcrypt.compare('Password123', stored!.passwordHash)).toBe(true);
  });

  it('logs in successfully with correct credentials', async () => {
    const { service } = createService();

    await service.register('login@example.com', 'Password123');
    const result = await service.login('login@example.com', 'Password123');

    expect(result.email).toBe('login@example.com');
  });

  it('rejects login with a wrong password', async () => {
    const { service } = createService();

    await service.register('wrongpass@example.com', 'Password123');

    await expect(service.login('wrongpass@example.com', 'WrongPassword1')).rejects.toThrow(UnauthorizedError);
  });

  it('rejects login for a non-existent email with the same error as a wrong password', async () => {
    const { service } = createService();

    await expect(service.login('nobody@example.com', 'Password123')).rejects.toThrow(UnauthorizedError);
  });
});

describe('AuthService — refresh (rotation)', () => {
  it('issues a new refresh token (with a new jti) on every refresh - this is what rotation actually guarantees', async () => {
    const { service } = createService();
    const registered = await service.register('rotate@example.com', 'Password123');

    const refreshed = await service.refresh(registered.tokens.refreshToken);

    // The refresh token's uniqueness is guaranteed by its jti claim, and
    // is the real security property rotation depends on. The access
    // token carries no per-issuance uniqueness by design (it's not
    // individually tracked or revoked the way refresh tokens are) - two
    // access tokens minted for the same user within the same
    // wall-clock second can legitimately be byte-for-byte identical,
    // since JWT's `iat` claim only has second-level granularity. That's
    // not a security gap; asserting the access token's string value
    // must differ would be testing an incidental implementation detail,
    // not a real guarantee this system makes.
    expect(refreshed.tokens.refreshToken).not.toBe(registered.tokens.refreshToken);
    expect(refreshed.tokens.accessToken).toEqual(expect.any(String));
    expect(refreshed.email).toBe('rotate@example.com');
  });

  it('rejects the OLD refresh token once it has been rotated out', async () => {
    const { service } = createService();
    const registered = await service.register('rotate2@example.com', 'Password123');

    await service.refresh(registered.tokens.refreshToken);

    // The original token was burned by the rotation above - presenting
    // it again must fail, not silently succeed a second time.
    await expect(service.refresh(registered.tokens.refreshToken)).rejects.toThrow(UnauthorizedError);
  });

  it('rejects a refresh token that was never issued (forged or garbage)', async () => {
    const { service } = createService();

    await expect(service.refresh('not-a-real-token')).rejects.toThrow(UnauthorizedError);
  });

  it('rejects an access token presented as a refresh token', async () => {
    const { service } = createService();
    const registered = await service.register('wrongtype@example.com', 'Password123');

    await expect(service.refresh(registered.tokens.accessToken)).rejects.toThrow(UnauthorizedError);
  });

  it('detects reuse of an already-rotated-out token and revokes every session for that user', async () => {
    const { service, refreshTokenRepo, userRepo } = createService();
    const registered = await service.register('reuse@example.com', 'Password123');
    const userId = (await userRepo.findByEmail('reuse@example.com'))!._id.toString();

    // Legitimate rotation - the original token is now burned.
    const firstRefresh = await service.refresh(registered.tokens.refreshToken);
    expect(refreshTokenRepo.activeCountForUser(userId)).toBe(1); // only the new one is active

    // An attacker (or a client bug) presents the ALREADY-USED original
    // token again - this is the specific signal of theft.
    await expect(service.refresh(registered.tokens.refreshToken)).rejects.toThrow(UnauthorizedError);

    // The entire family, including the token issued by the legitimate
    // rotation above, must now be revoked - not just the reused one.
    expect(refreshTokenRepo.activeCountForUser(userId)).toBe(0);
    await expect(service.refresh(firstRefresh.tokens.refreshToken)).rejects.toThrow(UnauthorizedError);
  });
});

describe('AuthService — logout', () => {
  it('revokes the given refresh token so it can no longer be used to refresh', async () => {
    const { service } = createService();
    const registered = await service.register('logout@example.com', 'Password123');

    await service.logout(registered.tokens.refreshToken);

    await expect(service.refresh(registered.tokens.refreshToken)).rejects.toThrow(UnauthorizedError);
  });

  it('does not throw when given an already-invalid or malformed token', async () => {
    const { service } = createService();

    await expect(service.logout('garbage-not-a-real-token')).resolves.not.toThrow();
  });
});
