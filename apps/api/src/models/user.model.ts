import { Schema, model, type Document, type Types } from 'mongoose';

export interface UserDocument extends Document {
  _id: Types.ObjectId;
  email: string;
  passwordHash: string;
  githubId?: string;
  encryptedGithubToken?: string;
  createdAt: Date;
}

const userSchema = new Schema<UserDocument>({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  githubId: { type: String, required: false },
  encryptedGithubToken: { type: String, required: false },
  createdAt: { type: Date, default: () => new Date() },
});

// Note: `unique: true` on the field above already creates this index.
// A race between two simultaneous registrations with the same email
// still fails safely at the DB level — the second insert throws a
// duplicate-key error rather than producing two user documents.

export const UserModel = model<UserDocument>('User', userSchema);
