import { ChatOrchestrationService } from '../src/services/chat-orchestration.service';
import type { IChatRepository, IMessageRepository, CreateMessageInput } from '../src/repositories/chat.repository';
import type { IRetrievalService } from '../src/services/retrieval.service';
import type { IChatCompletionProvider, StreamCompletionParams } from '../src/clients/chat-completion-provider';
import type { ChatDocument } from '../src/models/chat.model';
import type { MessageDocument } from '../src/models/message.model';
import type { ChunkSearchResult } from '../src/repositories/chunk.repository';
import { NotFoundError } from '../src/utils/errors';
import { logger } from '../src/utils/logger';

function makeChatDoc(id: string, repositoryId: string, userId: string): ChatDocument {
  return {
    _id: { toString: () => id },
    repositoryId: { toString: () => repositoryId },
    userId: { toString: () => userId },
    createdAt: new Date(),
  } as unknown as ChatDocument;
}

class FakeChatRepository implements IChatRepository {
  private chats = new Map<string, ChatDocument>();
  private idCounter = 0;

  seed(chat: ChatDocument): void {
    this.chats.set(chat._id.toString(), chat);
  }

  async create(repositoryId: string, userId: string): Promise<ChatDocument> {
    const id = `chat-${++this.idCounter}`;
    const chat = makeChatDoc(id, repositoryId, userId);
    this.chats.set(id, chat);
    return chat;
  }

  async findById(id: string): Promise<ChatDocument | null> {
    return this.chats.get(id) ?? null;
  }
}

class FakeMessageRepository implements IMessageRepository {
  public messages: MessageDocument[] = [];
  private idCounter = 0;

  async create(input: CreateMessageInput): Promise<MessageDocument> {
    const id = `msg-${++this.idCounter}`;
    const message = {
      _id: { toString: () => id },
      chatId: input.chatId,
      role: input.role,
      content: input.content,
      citations: input.citations ?? [],
      createdAt: new Date(),
    } as unknown as MessageDocument;
    this.messages.push(message);
    return message;
  }

  async findByChatId(chatId: string): Promise<MessageDocument[]> {
    return this.messages.filter((m) => m.chatId.toString() === chatId);
  }
}

class FakeRetrievalService implements IRetrievalService {
  public lastCall: { repositoryId: string; query: string } | null = null;

  constructor(private readonly chunksToReturn: ChunkSearchResult[]) {}

  async retrieve(repositoryId: string, query: string): Promise<ChunkSearchResult[]> {
    this.lastCall = { repositoryId, query };
    return this.chunksToReturn;
  }
}

class FakeChatCompletionProvider implements IChatCompletionProvider {
  public lastParams: StreamCompletionParams | null = null;

  constructor(private readonly tokensToYield: string[]) {}

  async *streamCompletion(params: StreamCompletionParams): AsyncIterable<string> {
    this.lastParams = params;
    for (const token of this.tokensToYield) {
      yield token;
    }
  }
}

describe('ChatOrchestrationService', () => {
  it('startChat creates a chat and returns its id as a string', async () => {
    const chatRepo = new FakeChatRepository();
    const service = new ChatOrchestrationService(
      chatRepo,
      new FakeMessageRepository(),
      new FakeRetrievalService([]),
      new FakeChatCompletionProvider([]),
    );

    const chatId = await service.startChat('repo-1', 'user-1');

    expect(chatId).toBe('chat-1');
  });

  it('throws NotFoundError when streaming to a chat that does not exist', async () => {
    const service = new ChatOrchestrationService(
      new FakeChatRepository(),
      new FakeMessageRepository(),
      new FakeRetrievalService([]),
      new FakeChatCompletionProvider([]),
    );

    const generator = service.streamAnswer('nonexistent-chat', 'repo-1', 'a question');

    await expect(generator.next()).rejects.toThrow(NotFoundError);
  });

  it('saves the user message before retrieving context or calling the LLM', async () => {
    const chatRepo = new FakeChatRepository();
    chatRepo.seed(makeChatDoc('chat-1', 'repo-1', 'user-1'));
    const messageRepo = new FakeMessageRepository();
    const retrieval = new FakeRetrievalService([]);
    const llm = new FakeChatCompletionProvider(['answer']);

    const service = new ChatOrchestrationService(chatRepo, messageRepo, retrieval, llm);

    // Fully drain the generator to run the whole flow.
    for await (const _token of service.streamAnswer('chat-1', 'repo-1', 'where is auth?')) {
      void _token;
    }

    const userMessages = messageRepo.messages.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]!.content).toBe('where is auth?');
  });

  it('retrieves context scoped to the correct repository and question', async () => {
    const chatRepo = new FakeChatRepository();
    chatRepo.seed(makeChatDoc('chat-1', 'repo-42', 'user-1'));
    const retrieval = new FakeRetrievalService([]);

    const service = new ChatOrchestrationService(
      chatRepo,
      new FakeMessageRepository(),
      retrieval,
      new FakeChatCompletionProvider(['answer']),
    );

    for await (const _token of service.streamAnswer('chat-1', 'repo-42', 'a question')) {
      void _token;
    }

    expect(retrieval.lastCall).toEqual({ repositoryId: 'repo-42', query: 'a question' });
  });

  it('yields tokens from the LLM provider in order as they stream', async () => {
    const chatRepo = new FakeChatRepository();
    chatRepo.seed(makeChatDoc('chat-1', 'repo-1', 'user-1'));

    const service = new ChatOrchestrationService(
      chatRepo,
      new FakeMessageRepository(),
      new FakeRetrievalService([]),
      new FakeChatCompletionProvider(['Hello', ', ', 'world', '!']),
    );

    const tokens: string[] = [];
    for await (const token of service.streamAnswer('chat-1', 'repo-1', 'a question')) {
      tokens.push(token);
    }

    expect(tokens).toEqual(['Hello', ', ', 'world', '!']);
  });

  it('saves the assembled assistant message with extracted citations after streaming finishes', async () => {
    const chatRepo = new FakeChatRepository();
    chatRepo.seed(makeChatDoc('chat-1', 'repo-1', 'user-1'));
    const messageRepo = new FakeMessageRepository();

    const service = new ChatOrchestrationService(
      chatRepo,
      messageRepo,
      new FakeRetrievalService([]),
      new FakeChatCompletionProvider(['The login logic is in ', '[src/auth.ts:10-20]', '.']),
    );

    for await (const _token of service.streamAnswer('chat-1', 'repo-1', 'where is login?')) {
      void _token;
    }

    const assistantMessages = messageRepo.messages.filter((m) => m.role === 'assistant');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]!.content).toBe('The login logic is in [src/auth.ts:10-20].');
    expect(assistantMessages[0]!.citations).toEqual([{ filePath: 'src/auth.ts', startLine: 10, endLine: 20 }]);
  });

  it('passes conversation history (including the new user message) to the LLM provider', async () => {
    const chatRepo = new FakeChatRepository();
    chatRepo.seed(makeChatDoc('chat-1', 'repo-1', 'user-1'));
    const messageRepo = new FakeMessageRepository();
    const llm = new FakeChatCompletionProvider(['answer']);

    const service = new ChatOrchestrationService(chatRepo, messageRepo, new FakeRetrievalService([]), llm);

    // Pre-existing history from an earlier turn.
    await messageRepo.create({ chatId: 'chat-1', role: 'user', content: 'first question' });
    await messageRepo.create({ chatId: 'chat-1', role: 'assistant', content: 'first answer' });

    for await (const _token of service.streamAnswer('chat-1', 'repo-1', 'second question')) {
      void _token;
    }

    expect(llm.lastParams?.messages.map((m) => m.content)).toEqual([
      'first question',
      'first answer',
      'second question',
    ]);
  });
});

describe('ChatOrchestrationService — observability', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs "Chat response complete" with retrieved chunk count, citation count, and a stage timing breakdown', async () => {
    const infoSpy = jest.spyOn(logger, 'info');
    const chatRepo = new FakeChatRepository();
    chatRepo.seed(makeChatDoc('chat-1', 'repo-1', 'user-1'));

    const chunk: ChunkSearchResult = {
      filePath: 'a.ts',
      startLine: 1,
      endLine: 2,
      content: 'x',
      chunkType: 'function',
      language: 'TypeScript',
      score: 0.9,
    };

    const service = new ChatOrchestrationService(
      chatRepo,
      new FakeMessageRepository(),
      new FakeRetrievalService([chunk]),
      new FakeChatCompletionProvider(['Answer with a citation ', '[a.ts:1-2]', '.']),
    );

    for await (const _token of service.streamAnswer('chat-1', 'repo-1', 'a question')) {
      void _token;
    }

    const call = infoSpy.mock.calls.find((c) => c[1] === 'Chat response complete');
    expect(call).toBeDefined();
    const payload = call![0] as Record<string, unknown>;
    expect(payload.retrievedChunkCount).toBe(1);
    expect(payload.citationCount).toBe(1);
    expect(payload).toHaveProperty('durationMs');
    expect(payload.stages).toEqual(expect.objectContaining({ retrievalMs: expect.any(Number) }));
  });

  it('does not log "Chat response complete" when the chat is not found (fails before any timing would be meaningful)', async () => {
    const infoSpy = jest.spyOn(logger, 'info');
    const service = new ChatOrchestrationService(
      new FakeChatRepository(),
      new FakeMessageRepository(),
      new FakeRetrievalService([]),
      new FakeChatCompletionProvider([]),
    );

    const generator = service.streamAnswer('nonexistent-chat', 'repo-1', 'a question');
    await expect(generator.next()).rejects.toThrow();

    const call = infoSpy.mock.calls.find((c) => c[1] === 'Chat response complete');
    expect(call).toBeUndefined();
  });
});
