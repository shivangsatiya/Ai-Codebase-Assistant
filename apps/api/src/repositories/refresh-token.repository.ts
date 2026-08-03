import { RefreshTokenModel, type RefreshTokenDocument } from '../models/refresh-token.model';

export interface CreateRefreshTokenInput {
  jti: string;
  userId: string;
  expiresAt: Date;
}

export interface IRefreshTokenRepository {
  create(input: CreateRefreshTokenInput): Promise<RefreshTokenDocument>;
  findByJti(jti: string): Promise<RefreshTokenDocument | null>;
  revoke(jti: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<void>;
}

export class MongoRefreshTokenRepository implements IRefreshTokenRepository {
  async create(input: CreateRefreshTokenInput): Promise<RefreshTokenDocument> {
    return RefreshTokenModel.create(input);
  }

  async findByJti(jti: string): Promise<RefreshTokenDocument | null> {
    return RefreshTokenModel.findOne({ jti }).exec();
  }

  async revoke(jti: string): Promise<void> {
    await RefreshTokenModel.updateOne({ jti }, { revokedAt: new Date() }).exec();
  }

  /**
   * Why "revoke every token for this user" rather than just the one
   * that was reused?
   *
   * A refresh token being presented a second time after it was already
   * rotated out is the specific signal of theft: it means someone other
   * than the legitimate rotation flow has a copy of a token that should
   * no longer exist. At that point, the ENTIRE chain of tokens derived
   * from that original login (the "family") is suspect, not just the
   * one that got reused - the attacker may already be holding a more
   * recent one from the same family. Revoking everything for the user
   * forces a fresh login, which is the safe response to "we don't know
   * how much of this session is compromised."
   */
  async revokeAllForUser(userId: string): Promise<void> {
    await RefreshTokenModel.updateMany({ userId, revokedAt: { $exists: false } }, { revokedAt: new Date() }).exec();
  }
}
