import { Schema, model, type Document, type Types } from 'mongoose';

export interface RefreshTokenDocument extends Document {
  _id: Types.ObjectId;
  jti: string;
  userId: Types.ObjectId;
  expiresAt: Date;
  revokedAt?: Date;
  createdAt: Date;
}

const refreshTokenSchema = new Schema<RefreshTokenDocument>({
  jti: { type: String, required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, required: false },
  createdAt: { type: Date, default: () => new Date() },
});

// Supports "revoke every refresh token for this user" (used on reuse
// detection, and would back a future "log out of all devices" feature).
refreshTokenSchema.index({ userId: 1 });

// Lets MongoDB automatically delete expired records instead of them
// accumulating forever - a TTL index, not an application-level cleanup
// job. `expiresAt` is when the JWT itself expires, so once that passes
// the record has no further purpose regardless of revocation status.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshTokenModel = model<RefreshTokenDocument>('RefreshToken', refreshTokenSchema);
