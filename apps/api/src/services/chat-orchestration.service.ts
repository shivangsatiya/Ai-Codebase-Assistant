import type { IChatRepository, IMessageRepository } from '../repositories/chat.repository';
import type { IRetrievalService } from './retrieval.service';
import type { IChatCompletionProvider, ChatMessage } from '../clients/chat-completion-provider';
import { buildSystemPrompt, extractCitations } from './chat-prompt';
import { NotFoundError } from '../utils/errors';

export class ChatOrchestrationService {
  constructor(
    private readonly chatRepo: IChatRepository,
    private readonly messageRepo: IMessageRepository,
    private readonly retrievalService: IRetrievalService,
    private readonly llmProvider: IChatCompletionProvider,
  ) {}

  async startChat(repositoryId: string, userId: string): Promise<string> {
    const chat = await this.chatRepo.create(repositoryId, userId);
    return chat._id.toString();
  }

  /**
   * Why is this an async generator (yielding tokens) rather than a
   * method that returns the full answer?
   *
   * The route handler consuming this needs to forward each token to the
   * client via Server-Sent Events as it arrives - buffering the whole
   * response here and returning it at once would defeat the entire
   * point of streaming. The generator IS the streaming contract; the
   * route just needs to `for await` over it and write each chunk to the
   * response.
   */
  async *streamAnswer(chatId: string, repositoryId: string, question: string): AsyncGenerator<string, void, unknown> {
    const chat = await this.chatRepo.findById(chatId);
    if (!chat) {
      throw new NotFoundError('Chat not found');
    }

    await this.messageRepo.create({ chatId, role: 'user', content: question });

    const retrievedChunks = await this.retrievalService.retrieve(repositoryId, question);
    const systemPrompt = buildSystemPrompt(retrievedChunks);

    const history = await this.messageRepo.findByChatId(chatId);
    const llmMessages: ChatMessage[] = history.map((m) => ({ role: m.role, content: m.content }));

    let fullText = '';
    for await (const token of this.llmProvider.streamCompletion({ systemPrompt, messages: llmMessages })) {
      fullText += token;
      yield token;
    }

    const citations = extractCitations(fullText);
    await this.messageRepo.create({ chatId, role: 'assistant', content: fullText, citations });
  }
}
