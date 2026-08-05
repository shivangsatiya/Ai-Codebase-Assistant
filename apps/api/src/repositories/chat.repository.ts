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
  findByRepositoryId(repositoryId: string): Promise<ChatDocument[]>;
  deleteByRepositoryId(repositoryId: string): Promise<void>;
}

export interface IMessageRepository {
  create(input: CreateMessageInput): Promise<MessageDocument>;
  findByChatId(chatId: string): Promise<MessageDocument[]>;
  deleteByChatId(chatId: string): Promise<void>;
}

export class MongoChatRepository implements IChatRepository {
  async create(repositoryId: string, userId: string): Promise<ChatDocument> {
    return ChatModel.create({ repositoryId, userId });
  }

  async findById(id: string): Promise<ChatDocument | null> {
    return ChatModel.findById(id).exec();
  }

  async findByRepositoryId(repositoryId: string): Promise<ChatDocument[]> {
    return ChatModel.find({ repositoryId }).exec();
  }

  async deleteByRepositoryId(repositoryId: string): Promise<void> {
    await ChatModel.deleteMany({ repositoryId }).exec();
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

  async deleteByChatId(chatId: string): Promise<void> {
    await MessageModel.deleteMany({ chatId }).exec();
  }
}
