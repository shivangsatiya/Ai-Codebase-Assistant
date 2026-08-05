import { RepositoryManagementService } from '../src/services/repository-management.service';
import type { IRepositoryRepository, IJobRepository, CreateRepositoryInput } from '../src/repositories/repository.repository';
import type { IChunkRepository, ChunkToInsert, InsertResult, ChunkSearchResult } from '../src/repositories/chunk.repository';
import type { IChatRepository, IMessageRepository, CreateMessageInput } from '../src/repositories/chat.repository';
import type { RepositoryDocument, RepositoryStatus } from '../src/models/repository.model';
import type { JobDocument, JobStage } from '../src/models/job.model';
import type { ChatDocument } from '../src/models/chat.model';
import type { MessageDocument } from '../src/models/message.model';
import { NotFoundError } from '../src/utils/errors';

function makeRepoDoc(id: string, ownerId: string): RepositoryDocument {
  return {
    _id: { toString: () => id },
    ownerId: { toString: () => ownerId },
  } as unknown as RepositoryDocument;
}

function makeChatDoc(id: string): ChatDocument {
  return { _id: { toString: () => id } } as unknown as ChatDocument;
}

class FakeRepositoryRepository implements IRepositoryRepository {
  private repos = new Map<string, RepositoryDocument>();
  public deletedIds: string[] = [];

  seed(doc: RepositoryDocument): void {
    this.repos.set(doc._id.toString(), doc);
  }

  async create(_input: CreateRepositoryInput): Promise<RepositoryDocument> {
    throw new Error('Not used by these tests');
  }

  async findById(id: string): Promise<RepositoryDocument | null> {
    return this.repos.get(id) ?? null;
  }

  async findByOwnerId(ownerId: string): Promise<RepositoryDocument[]> {
    return Array.from(this.repos.values()).filter((r) => r.ownerId.toString() === ownerId);
  }

  async updateStatus(
    _id: string,
    _status: RepositoryStatus,
    _extra?: Partial<Pick<RepositoryDocument, 'fileCount' | 'defaultBranch' | 'commitSha' | 'errorMessage'>>,
  ): Promise<void> {
    // no-op - not exercised by these tests
  }

  async deleteById(id: string): Promise<void> {
    this.deletedIds.push(id);
    this.repos.delete(id);
  }
}

class FakeJobRepository implements IJobRepository {
  public deletedForRepositoryIds: string[] = [];

  async createForRepository(_repositoryId: string): Promise<JobDocument> {
    throw new Error('Not used by these tests');
  }

  async findByRepositoryId(_repositoryId: string): Promise<JobDocument | null> {
    return null;
  }

  async updateStage(_id: string, _stage: JobStage, _progress: number): Promise<void> {
    // no-op
  }

  async deleteByRepositoryId(repositoryId: string): Promise<void> {
    this.deletedForRepositoryIds.push(repositoryId);
  }
}

class FakeChunkRepository implements IChunkRepository {
  public deletedForRepositoryIds: string[] = [];

  async insertManyIdempotent(_chunks: ChunkToInsert[]): Promise<InsertResult> {
    return { inserted: 0, skippedDuplicates: 0 };
  }

  async countByRepository(_repositoryId: string): Promise<number> {
    return 0;
  }

  async vectorSearch(_repositoryId: string, _queryVector: number[], _limit: number): Promise<ChunkSearchResult[]> {
    return [];
  }

  async deleteByRepository(repositoryId: string): Promise<void> {
    this.deletedForRepositoryIds.push(repositoryId);
  }
}

class FakeChatRepository implements IChatRepository {
  public deletedForRepositoryIds: string[] = [];
  private chatsByRepo = new Map<string, ChatDocument[]>();

  seedChatsForRepository(repositoryId: string, chats: ChatDocument[]): void {
    this.chatsByRepo.set(repositoryId, chats);
  }

  async create(_repositoryId: string, _userId: string): Promise<ChatDocument> {
    throw new Error('Not used by these tests');
  }

  async findById(_id: string): Promise<ChatDocument | null> {
    return null;
  }

  async findByRepositoryId(repositoryId: string): Promise<ChatDocument[]> {
    return this.chatsByRepo.get(repositoryId) ?? [];
  }

  async deleteByRepositoryId(repositoryId: string): Promise<void> {
    this.deletedForRepositoryIds.push(repositoryId);
  }
}

class FakeMessageRepository implements IMessageRepository {
  public deletedForChatIds: string[] = [];

  async create(_input: CreateMessageInput): Promise<MessageDocument> {
    throw new Error('Not used by these tests');
  }

  async findByChatId(_chatId: string): Promise<MessageDocument[]> {
    return [];
  }

  async deleteByChatId(chatId: string): Promise<void> {
    this.deletedForChatIds.push(chatId);
  }
}

function buildService() {
  const repositoryRepo = new FakeRepositoryRepository();
  const jobRepo = new FakeJobRepository();
  const chunkRepo = new FakeChunkRepository();
  const chatRepo = new FakeChatRepository();
  const messageRepo = new FakeMessageRepository();
  const service = new RepositoryManagementService(repositoryRepo, jobRepo, chunkRepo, chatRepo, messageRepo);
  return { service, repositoryRepo, jobRepo, chunkRepo, chatRepo, messageRepo };
}

describe('RepositoryManagementService - listForUser', () => {
  it('returns only repositories owned by the given user', async () => {
    const { service, repositoryRepo } = buildService();
    repositoryRepo.seed(makeRepoDoc('repo-1', 'user-a'));
    repositoryRepo.seed(makeRepoDoc('repo-2', 'user-b'));
    repositoryRepo.seed(makeRepoDoc('repo-3', 'user-a'));

    const result = await service.listForUser('user-a');

    expect(result.map((r) => r._id.toString()).sort()).toEqual(['repo-1', 'repo-3']);
  });

  it('returns an empty array for a user with no repositories', async () => {
    const { service } = buildService();

    expect(await service.listForUser('user-with-nothing')).toEqual([]);
  });
});

describe('RepositoryManagementService - deleteRepository', () => {
  it('throws NotFoundError if the repository does not exist', async () => {
    const { service } = buildService();

    await expect(service.deleteRepository('nonexistent', 'user-a')).rejects.toThrow(NotFoundError);
  });

  it('throws NotFoundError (not a different error) if the repository exists but belongs to another user - the 404-not-403 pattern used throughout this project', async () => {
    const { service, repositoryRepo } = buildService();
    repositoryRepo.seed(makeRepoDoc('repo-1', 'user-a'));

    await expect(service.deleteRepository('repo-1', 'user-b')).rejects.toThrow(NotFoundError);
  });

  it('cascades deletion to chunks, jobs, chats, and messages, then the repository itself', async () => {
    const { service, repositoryRepo, jobRepo, chunkRepo, chatRepo, messageRepo } = buildService();
    repositoryRepo.seed(makeRepoDoc('repo-1', 'user-a'));
    chatRepo.seedChatsForRepository('repo-1', [makeChatDoc('chat-1'), makeChatDoc('chat-2')]);

    await service.deleteRepository('repo-1', 'user-a');

    expect(messageRepo.deletedForChatIds.sort()).toEqual(['chat-1', 'chat-2']);
    expect(chatRepo.deletedForRepositoryIds).toEqual(['repo-1']);
    expect(jobRepo.deletedForRepositoryIds).toEqual(['repo-1']);
    expect(chunkRepo.deletedForRepositoryIds).toEqual(['repo-1']);
    expect(repositoryRepo.deletedIds).toEqual(['repo-1']);
  });

  it('does not fail when a repository has no associated chats at all', async () => {
    const { service, repositoryRepo, messageRepo } = buildService();
    repositoryRepo.seed(makeRepoDoc('repo-1', 'user-a'));
    // No chats seeded for this repository.

    await expect(service.deleteRepository('repo-1', 'user-a')).resolves.not.toThrow();
    expect(messageRepo.deletedForChatIds).toEqual([]);
  });

  it('deleting one repository does not affect another repository or its data', async () => {
    const { service, repositoryRepo, chunkRepo } = buildService();
    repositoryRepo.seed(makeRepoDoc('repo-1', 'user-a'));
    repositoryRepo.seed(makeRepoDoc('repo-2', 'user-a'));

    await service.deleteRepository('repo-1', 'user-a');

    expect(chunkRepo.deletedForRepositoryIds).toEqual(['repo-1']);
    expect(await repositoryRepo.findById('repo-2')).not.toBeNull();
  });
});
