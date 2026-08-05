import { Schema, model, type Document, type Types } from 'mongoose';

export interface GitHubOAuthStateDocument extends Document {
  _id: Types.ObjectId;
  state: string;
  userId: Types.ObjectId;
  expiresAt: Date;
}

const githubOAuthStateSchema = new Schema<GitHubOAuthStateDocument>({
  state: { type: String, required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  expiresAt: { type: Date, required: true },
});

/**
 * Why does this record even need to exist, when GitHub's `state`
 * parameter is normally just CSRF protection?
 *
 * This project's entire auth model is stateless JWT Bearer tokens - no
 * session cookie exists for GitHub's callback redirect to carry back to
 * us. The `state` value does double duty here: GitHub's own documented
 * CSRF purpose, AND resolving "which of our users does this anonymous
 * browser redirect belong to," since there's no other way to know. See
 * milestone-2-design.md §2.3 for the full reasoning.
 *
 * Same TTL pattern as RefreshTokenModel (Milestone 1.5) - MongoDB
 * garbage-collects expired records on its own, no cleanup job needed.
 * 10 minutes matches GitHub's own authorization code expiry window, so
 * a state record never meaningfully outlives the code it's paired with.
 */
githubOAuthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const GitHubOAuthStateModel = model<GitHubOAuthStateDocument>('GitHubOAuthState', githubOAuthStateSchema);
