import { performance } from 'perf_hooks';
import type { IRepositoryRepository, IJobRepository } from '../repositories/repository.repository';
import type { IChunkRepository } from '../repositories/chunk.repository';
import type { IChunkCheckpointRepository } from '../repositories/chunk-checkpoint.repository';
import type { IRepositoryKnowledgeGraphRepository } from '../repositories/repository-knowledge-graph.repository';
import type { IChatRepository, IMessageRepository } from '../repositories/chat.repository';
import type { RepositoryDocument } from '../models/repository.model';
import { NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * Deliberately separate from RepositoryImportService - that class owns
 * "how a repository gets imported" (the clone/parse/embed pipeline);
 * this one owns "how a repository gets listed and removed," a genuinely
 * different concern with no shared state, matching this project's
 * established single-responsibility pattern rather than growing one
 * class to cover every repository-related operation.
 */
export class RepositoryManagementService {
  constructor(
    private readonly repositoryRepo: IRepositoryRepository,
    private readonly jobRepo: IJobRepository,
    private readonly chunkRepo: IChunkRepository,
    private readonly chatRepo: IChatRepository,
    private readonly messageRepo: IMessageRepository,
    private readonly chunkCheckpointRepo: IChunkCheckpointRepository,
    private readonly knowledgeGraphRepo: IRepositoryKnowledgeGraphRepository,
  ) {}

  async listForUser(userId: string): Promise<RepositoryDocument[]> {
    return this.repositoryRepo.findByOwnerId(userId);
  }

  /**
   * Why does deletion cascade to Chats and Messages, when the design
   * review only explicitly named Chunks as needing cascade-delete?
   *
   * The same correctness requirement applies to every collection that
   * references repositoryId, not just chunks - Job, Chat, Message, and
   * (per Milestone 4 Task 4.5) RepositoryKnowledgeGraph documents would
   * all become orphaned, invisible garbage the same way un-deleted
   * chunks would. This is a deliberate extension of the design's
   * literal scope, not a silent one: chunks were the example given, not
   * an exhaustive list of what actually needs cleanup. The knowledge
   * graph gap specifically was found and explicitly deferred during
   * Milestone 4's design phase, then closed here once its own dedicated
   * substep came up.
   *
   * Why deletes in this specific order (messages -> chats -> jobs ->
   * chunks -> chunk checkpoints -> knowledge graphs -> the repository
   * document itself), without wrapping it in a database transaction?
   *
   * MongoDB Atlas does support multi-document transactions, and a real,
   * larger-scale system handling many concurrent deletions might
   * reasonably want one here. For a portfolio-scale project, the
   * pragmatic choice is deleting dependent data first and the parent
   * document last: if this process crashes partway through, the worst
   * case is some orphaned dependent records with no parent repository
   * left pointing at them - annoying, cleanable later, but not a
   * correctness catastrophe the way deleting the repository FIRST and
   * then crashing (leaving orphaned data with no way to discover it
   * belonged to a since-vanished repository) would be. Ordering the
   * deletes this way costs nothing extra and meaningfully narrows the
   * failure mode, without taking on the real complexity of introducing
   * this project's first database transaction for it.
   */
  async deleteRepository(repositoryId: string, userId: string): Promise<void> {
    const startedAt = performance.now();

    const repository = await this.repositoryRepo.findById(repositoryId);
    if (!repository || repository.ownerId.toString() !== userId) {
      // 404, not 403 - same reasoning as every other ownership check in
      // this project: confirming a repository id exists at all leaks
      // information to a user who doesn't own it.
      throw new NotFoundError('Repository not found');
    }

    const chats = await this.chatRepo.findByRepositoryId(repositoryId);
    for (const chat of chats) {
      await this.messageRepo.deleteByChatId(chat._id.toString());
    }
    await this.chatRepo.deleteByRepositoryId(repositoryId);
    await this.jobRepo.deleteByRepositoryId(repositoryId);
    await this.chunkRepo.deleteByRepository(repositoryId);
    await this.chunkCheckpointRepo.deleteByRepositoryId(repositoryId);
    await this.knowledgeGraphRepo.deleteByRepositoryId(repositoryId);
    await this.repositoryRepo.deleteById(repositoryId);

    const durationMs = Math.round(performance.now() - startedAt);
    logger.info({ repositoryId, userId, chatsDeleted: chats.length, durationMs }, 'Repository deleted');
  }
}
