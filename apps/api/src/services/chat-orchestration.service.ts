import { performance } from 'perf_hooks';
import type { IChatRepository, IMessageRepository } from '../repositories/chat.repository';
import type { IRetrievalService } from './retrieval.service';
import type { IChatCompletionProvider, ChatMessage } from '../clients/chat-completion-provider';
import { buildSystemPrompt, extractCitations } from './chat-prompt';
import { NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';

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
   *
   * Why one more summary log line here, when RetrievalService and
   * GroqChatClient already each log their own timing?
   *
   * Each of those answers "how long did THIS piece take" in isolation -
   * useful on its own, but neither one alone answers "how long did this
   * whole chat turn take, end to end, and how much of that was retrieval
   * versus generation." This line is what actually answers that,
   * matching the same pattern established for the import pipeline in
   * Task 1: individual stage logs for reading live, one summary line for
   * answering the roadmap's stated question directly.
   */
  async *streamAnswer(chatId: string, repositoryId: string, question: string): AsyncGenerator<string, void, unknown> {
    const startedAt = performance.now();

    const chat = await this.chatRepo.findById(chatId);
    if (!chat) {
      throw new NotFoundError('Chat not found');
    }

    await this.messageRepo.create({ chatId, role: 'user', content: question });

    const retrievalStartedAt = performance.now();
    const retrievedChunks = await this.retrievalService.retrieve(repositoryId, question);
    const retrievalMs = Math.round(performance.now() - retrievalStartedAt);

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

    const durationMs = Math.round(performance.now() - startedAt);
    logger.info(
      {
        chatId,
        repositoryId,
        retrievedChunkCount: retrievedChunks.length,
        citationCount: citations.length,
        durationMs,
        stages: { retrievalMs },
      },
      'Chat response complete',
    );
  }
}
