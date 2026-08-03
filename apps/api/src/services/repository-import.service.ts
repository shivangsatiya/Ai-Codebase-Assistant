import { readFile } from 'fs/promises';
import { extname } from 'path';
import type { IRepositoryRepository, IJobRepository } from '../repositories/repository.repository';
import type { IChunkRepository, ChunkToInsert } from '../repositories/chunk.repository';
import type { GitHubClient } from '../clients/github.client';
import type { GitClonerClient } from '../clients/git-cloner.client';
import type { IEmbeddingProvider } from '../clients/embedding-provider';
import type { ChunkingService } from './chunking.service';
import { walkRepoFiles } from '../utils/repo-file-walker';
import { logger } from '../utils/logger';
import type { RepositoryDocument } from '../models/repository.model';
import type { JobDocument } from '../models/job.model';

export interface ImportResult {
  repository: RepositoryDocument;
  job: JobDocument;
}

/**
 * Why does this service kick off cloning "fire and forget" (not awaited
 * by the request handler) instead of blocking the HTTP response until
 * the clone finishes?
 *
 * Cloning can take anywhere from 1 second to a couple of minutes
 * depending on repo size — an HTTP request should not hang open that
 * long. The route returns 202 Accepted with a job id immediately; the
 * client polls GET /repositories/:id for status. This is also exactly the
 * shape Milestone 2+ needs: swapping this in-process async call for a
 * real job queue (BullMQ) later only changes *how* the background work is
 * dispatched, not the request/response contract the frontend depends on.
 */
export class RepositoryImportService {
  constructor(
    private readonly repositoryRepo: IRepositoryRepository,
    private readonly jobRepo: IJobRepository,
    private readonly githubClient: GitHubClient,
    private readonly gitCloner: GitClonerClient,
    private readonly chunkingService: ChunkingService,
    private readonly embeddingProvider: IEmbeddingProvider,
    private readonly chunkRepo: IChunkRepository,
    private readonly maxRepoFiles: number,
    private readonly maxFileSizeBytes: number,
  ) {}

  async startImport(ownerId: string, githubUrl: string): Promise<ImportResult> {
    // Validates the URL shape AND confirms via the GitHub API that the
    // repo exists and is public — throws ValidationError/NotFoundError/
    // ForbiddenError before any DB record is created, so we never store a
    // Repository doc for a request that was never going to succeed.
    const repoInfo = await this.githubClient.fetchRepoInfo(githubUrl);

    const repository = await this.repositoryRepo.create({
      ownerId,
      githubUrl,
      isPrivate: repoInfo.isPrivate,
    });

    const job = await this.jobRepo.createForRepository(repository._id.toString());

    // Deliberately not awaited — see class-level comment.
    this.runImportPipeline(
      repository._id.toString(),
      job._id.toString(),
      repoInfo.cloneUrl,
      repoInfo.defaultBranch,
    ).catch((err) => {
      logger.error({ err, repositoryId: repository._id.toString() }, 'Unhandled error in import pipeline');
    });

    return { repository, job };
  }

  private async runImportPipeline(
    repositoryId: string,
    jobId: string,
    cloneUrl: string,
    branch: string,
  ): Promise<void> {
    await this.repositoryRepo.updateStatus(repositoryId, 'cloning');
    await this.jobRepo.updateStage(jobId, 'cloning', 5);

    let cloned: Awaited<ReturnType<GitClonerClient['clone']>>;
    try {
      cloned = await this.gitCloner.clone(cloneUrl, branch);
    } catch (err) {
      await this.failImport(repositoryId, jobId, err, 'Clone failed');
      return;
    }

    try {
      await this.repositoryRepo.updateStatus(repositoryId, 'parsing', {
        defaultBranch: branch,
        commitSha: cloned.commitSha,
      });
      await this.jobRepo.updateStage(jobId, 'parsing', 20);

      const files = await walkRepoFiles(cloned.localPath, this.maxRepoFiles, this.maxFileSizeBytes * 1024);
      logger.info({ repositoryId, fileCount: files.length }, 'File walk complete');

      const allChunks: Array<{
        filePath: string;
        startLine: number;
        endLine: number;
        content: string;
        symbolName?: string;
        chunkType: string;
        language: string;
        contentHash: string;
      }> = [];

      for (const file of files) {
        const content = await readFile(file.absolutePath, 'utf-8').catch(() => null);
        // Skip unreadable files (binary content that slipped past the
        // extension filter, permission issues, etc.) rather than failing
        // the whole import over one bad file.
        if (content === null) continue;

        const enriched = await this.chunkingService.chunkFile(
          file.relativePath,
          content,
          extname(file.relativePath),
        );
        allChunks.push(...enriched);
      }

      logger.info({ repositoryId, chunkCount: allChunks.length }, 'Chunking complete');

      await this.repositoryRepo.updateStatus(repositoryId, 'embedding');
      await this.jobRepo.updateStage(jobId, 'embedding', 60);

      const embeddings =
        allChunks.length > 0
          ? await this.embeddingProvider.embedBatch(
              allChunks.map((c) => c.content),
              'document',
            )
          : [];

      const chunksToInsert: ChunkToInsert[] = allChunks.map((chunk, i) => ({
        repositoryId,
        commitSha: cloned.commitSha,
        filePath: chunk.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
        embedding: embeddings[i] ?? [],
        language: chunk.language,
        symbolName: chunk.symbolName,
        chunkType: chunk.chunkType,
        contentHash: chunk.contentHash,
      }));

      const insertResult = await this.chunkRepo.insertManyIdempotent(chunksToInsert);
      logger.info({ repositoryId, ...insertResult }, 'Chunks stored');

      await this.repositoryRepo.updateStatus(repositoryId, 'ready', { fileCount: files.length });
      await this.jobRepo.updateStage(jobId, 'complete', 100);
    } catch (err) {
      await this.failImport(repositoryId, jobId, err, 'Parsing/embedding failed');
    } finally {
      await cloned.cleanup();
    }
  }

  private async failImport(
    repositoryId: string,
    jobId: string,
    err: unknown,
    context: string,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : context;
    logger.error({ err, repositoryId }, context);
    await this.repositoryRepo.updateStatus(repositoryId, 'failed', { errorMessage: message });
    await this.jobRepo.updateStage(jobId, 'failed', 0, message);
  }
}
