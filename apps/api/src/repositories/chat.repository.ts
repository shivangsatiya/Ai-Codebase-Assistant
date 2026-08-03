import { ChatModel, type ChatDocument } from '../models/chat.model';
import { MessageModel, type MessageDocument, type MessageRole, type Citation } from '../models/message.model';

export interface CreateMessageInput {
  chatId: string;
  role: MessageRole;
  content: string;
  citations?: Citation[];
}

export interface IChatRepository {
  create(repositoryId: string, userId: string): Promise<ChatDocument>;
  findById(id: string): Promise<ChatDocument | null>;
}

export interface IMessageRepository {
  create(input: CreateMessageInput): Promise<MessageDocument>;
  findByChatId(chatId: string): Promise<MessageDocument[]>;
}

export class MongoChatRepository implements IChatRepository {
  async create(repositoryId: string, userId: string): Promise<ChatDocument> {
    return ChatModel.create({ repositoryId, userId });
  }

  async findById(id: string): Promise<ChatDocument | null> {
    return ChatModel.findById(id).exec();
  }
}

export class MongoMessageRepository implements IMessageRepository {
  async create(input: CreateMessageInput): Promise<MessageDocument> {
    return MessageModel.create({
      chatId: input.chatId,
      role: input.role,
      content: input.content,
      citations: input.citations ?? [],
    });
  }

  async findByChatId(chatId: string): Promise<MessageDocument[]> {
    return MessageModel.find({ chatId }).sort({ createdAt: 1 }).exec();
  }
}
