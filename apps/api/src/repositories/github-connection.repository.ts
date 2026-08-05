import { GitHubConnectionModel, type GitHubConnectionDocument } from '../models/github-connection.model';
import type { EncryptedValue } from '../utils/token-encryptor';

export interface UpsertConnectionInput {
  userId: string;
  githubUserId: number;
  githubUsername: string;
  encryptedToken: EncryptedValue;
  scopes: string[];
}

export interface IGitHubConnectionRepository {
  upsert(input: UpsertConnectionInput): Promise<GitHubConnectionDocument>;
  findByUserId(userId: string): Promise<GitHubConnectionDocument | null>;
  deleteByUserId(userId: string): Promise<void>;
}

export class MongoGitHubConnectionRepository implements IGitHubConnectionRepository {
  /**
   * Why upsert, not create?
   *
   * A user reconnecting (after revoking access on GitHub's side,
   * re-granting after a scope change, or simply clicking "Connect
   * GitHub" again) must not hit a duplicate-key error against the
   * unique index on userId - a real gap the design review found in the
   * original design, which only specified the index and never specified
   * insert-vs-upsert behavior for the second connection attempt.
   */
  async upsert(input: UpsertConnectionInput): Promise<GitHubConnectionDocument> {
    const updated = await GitHubConnectionModel.findOneAndUpdate(
      { userId: input.userId },
      {
        // Explicit $set rather than a plain object - MongoDB's
        // findOneAndUpdate treats an update document with no operators
        // as ambiguous/version-dependent territory best avoided
        // entirely, not relied on implicitly, even though every field
        // happens to be set here anyway (making replacement and $set
        // semantics equivalent in this specific case).
        $set: {
          userId: input.userId,
          githubUserId: input.githubUserId,
          githubUsername: input.githubUsername,
          encryptedToken: input.encryptedToken.ciphertext,
          iv: input.encryptedToken.iv,
          authTag: input.encryptedToken.authTag,
          keyVersion: input.encryptedToken.keyVersion,
          scopes: input.scopes,
          connectedAt: new Date(),
        },
      },
      { upsert: true, new: true },
    ).exec();

    // findOneAndUpdate with upsert:true and new:true always returns the
    // resulting document - this null check exists only to satisfy
    // TypeScript's return type, not because this path is reachable.
    if (!updated) {
      throw new Error('Unexpected: upsert did not return a document');
    }

    return updated;
  }

  async findByUserId(userId: string): Promise<GitHubConnectionDocument | null> {
    return GitHubConnectionModel.findOne({ userId }).exec();
  }

  async deleteByUserId(userId: string): Promise<void> {
    await GitHubConnectionModel.deleteOne({ userId }).exec();
  }
}
