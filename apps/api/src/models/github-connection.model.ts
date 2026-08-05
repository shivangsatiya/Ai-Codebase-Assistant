import { Schema, model, type Document, type Types } from 'mongoose';

export interface GitHubConnectionDocument extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  githubUserId: number;
  githubUsername: string;
  encryptedToken: string;
  iv: string;
  authTag: string;
  keyVersion: number;
  scopes: string[];
  connectedAt: Date;
}

const githubConnectionSchema = new Schema<GitHubConnectionDocument>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  // GitHub's numeric user id, not username - usernames can change, the
  // numeric id is the stable identifier. Indexed (not uniquely
  // constrained) so it's a natural lookup path later without committing
  // to a uniqueness rule that's a genuine product decision, not a
  // technical one - see the design doc's "deliberate non-decision" note
  // on whether one GitHub identity should be connectable to multiple
  // app accounts.
  githubUserId: { type: Number, required: true, index: true },
  githubUsername: { type: String, required: true },
  // Encrypted-value fields match TokenEncryptor's EncryptedValue shape
  // exactly (see src/utils/token-encryptor.ts) - no reshaping needed
  // between what the encryptor produces and what gets stored.
  encryptedToken: { type: String, required: true },
  iv: { type: String, required: true },
  authTag: { type: String, required: true },
  keyVersion: { type: Number, required: true },
  scopes: { type: [String], default: [] },
  connectedAt: { type: Date, default: () => new Date() },
});

export const GitHubConnectionModel = model<GitHubConnectionDocument>('GitHubConnection', githubConnectionSchema);
