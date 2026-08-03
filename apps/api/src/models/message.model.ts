import { Schema, model, type Document, type Types } from 'mongoose';

export interface Citation {
  filePath: string;
  startLine: number;
  endLine: number;
}

export type MessageRole = 'user' | 'assistant';

export interface MessageDocument extends Document {
  _id: Types.ObjectId;
  chatId: Types.ObjectId;
  role: MessageRole;
  content: string;
  citations: Citation[];
  createdAt: Date;
}

const citationSchema = new Schema<Citation>(
  {
    filePath: { type: String, required: true },
    startLine: { type: Number, required: true },
    endLine: { type: Number, required: true },
  },
  { _id: false },
);

const messageSchema = new Schema<MessageDocument>({
  chatId: { type: Schema.Types.ObjectId, ref: 'Chat', required: true },
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true },
  citations: { type: [citationSchema], default: [] },
  createdAt: { type: Date, default: () => new Date() },
});

messageSchema.index({ chatId: 1, createdAt: 1 });

export const MessageModel = model<MessageDocument>('Message', messageSchema);
