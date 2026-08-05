import { GitHubOAuthStateModel, type GitHubOAuthStateDocument } from '../models/github-oauth-state.model';

export interface IGitHubOAuthStateRepository {
  create(state: string, userId: string, expiresAt: Date): Promise<GitHubOAuthStateDocument>;
  consumeByState(state: string): Promise<GitHubOAuthStateDocument | null>;
}

export class MongoGitHubOAuthStateRepository implements IGitHubOAuthStateRepository {
  async create(state: string, userId: string, expiresAt: Date): Promise<GitHubOAuthStateDocument> {
    return GitHubOAuthStateModel.create({ state, userId, expiresAt });
  }

  /**
   * Why one atomic findOneAndDelete instead of a find() followed by a
   * separate delete()?
   *
   * This is the specific concurrency bug the design review found in the
   * original design: written as two steps, two concurrent requests
   * carrying the same `state` (a replayed or duplicated OAuth callback)
   * could both pass the lookup before either completed the delete, both
   * proceeding to complete the flow. A single atomic operation makes
   * "single-use" actually true under concurrency, not just true in the
   * common case - structurally the same class of bug as the Day 3-4
   * Mongoose index-timing race: a check and an action separated in
   * time, racing against a concurrent duplicate of itself. The method
   * name deliberately says "consume," not "find," so a future caller
   * can't accidentally split this back into two steps without the name
   * itself looking wrong.
   */
  async consumeByState(state: string): Promise<GitHubOAuthStateDocument | null> {
    return GitHubOAuthStateModel.findOneAndDelete({ state }).exec();
  }
}
