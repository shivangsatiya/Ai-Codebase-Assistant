import { Schema, model, type Document, type Types } from 'mongoose';

export interface ChatDocument extends Document {
  _id: Types.ObjectId;
  repositoryId: Types.ObjectId;
  userId: Types.ObjectId;
  title?: string;
  createdAt: Date;
}

const chatSchema = new Schema<ChatDocument>({
  repositoryId: { type: Schema.Types.ObjectId, ref: 'Repository', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: false },
  createdAt: { type: Date, default: () => new Date() },
});

chatSchema.index({ repositoryId: 1, userId: 1, createdAt: -1 });

export const ChatModel = model<ChatDocument>('Chat', chatSchema);
