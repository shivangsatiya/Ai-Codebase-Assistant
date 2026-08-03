import mongoose from 'mongoose';
import { MongoRefreshTokenRepository } from '../src/repositories/refresh-token.repository';

describe('MongoRefreshTokenRepository', () => {
  function futureDate(hoursFromNow = 24): Date {
    return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
  }

  it('creates a token record and finds it by jti', async () => {
    const repo = new MongoRefreshTokenRepository();
    const userId = new mongoose.Types.ObjectId().toString();
    const jti = 'test-jti-1';

    await repo.create({ jti, userId, expiresAt: futureDate() });
    const found = await repo.findByJti(jti);

    expect(found).not.toBeNull();
    expect(found!.userId.toString()).toBe(userId);
    expect(found!.revokedAt).toBeUndefined();
  });

  it('returns null for an unknown jti', async () => {
    const repo = new MongoRefreshTokenRepository();

    const found = await repo.findByJti('never-created');

    expect(found).toBeNull();
  });

  it('revoke() sets revokedAt on the specific token', async () => {
    const repo = new MongoRefreshTokenRepository();
    const userId = new mongoose.Types.ObjectId().toString();
    const jti = 'test-jti-revoke';

    await repo.create({ jti, userId, expiresAt: futureDate() });
    await repo.revoke(jti);

    const found = await repo.findByJti(jti);
    expect(found!.revokedAt).toBeDefined();
  });

  it('revokeAllForUser() revokes every active token for that user, and only that user', async () => {
    const repo = new MongoRefreshTokenRepository();
    const userA = new mongoose.Types.ObjectId().toString();
    const userB = new mongoose.Types.ObjectId().toString();

    await repo.create({ jti: 'a-1', userId: userA, expiresAt: futureDate() });
    await repo.create({ jti: 'a-2', userId: userA, expiresAt: futureDate() });
    await repo.create({ jti: 'b-1', userId: userB, expiresAt: futureDate() });

    await repo.revokeAllForUser(userA);

    const a1 = await repo.findByJti('a-1');
    const a2 = await repo.findByJti('a-2');
    const b1 = await repo.findByJti('b-1');

    expect(a1!.revokedAt).toBeDefined();
    expect(a2!.revokedAt).toBeDefined();
    // Confirms the query is actually scoped to userA - a bug here
    // (revoking every token regardless of owner) would silently log out
    // every user in the system whenever one person's tokens were
    // revoked, which is exactly the kind of mistake worth a dedicated
    // test for rather than trusting the query looks right on read.
    expect(b1!.revokedAt).toBeUndefined();
  });

  it('revokeAllForUser() does not re-touch tokens that were already revoked earlier', async () => {
    const repo = new MongoRefreshTokenRepository();
    const userId = new mongoose.Types.ObjectId().toString();

    await repo.create({ jti: 'already-revoked', userId, expiresAt: futureDate() });
    await repo.revoke('already-revoked');
    const revokedAtFirst = (await repo.findByJti('already-revoked'))!.revokedAt;

    await repo.revokeAllForUser(userId);
    const revokedAtAfter = (await repo.findByJti('already-revoked'))!.revokedAt;

    expect(revokedAtAfter?.getTime()).toBe(revokedAtFirst?.getTime());
  });
});
