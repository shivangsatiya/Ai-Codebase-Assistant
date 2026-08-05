import { readFile } from 'fs/promises';
import { extname } from 'path';
import { performance } from 'perf_hooks';
import type { IRepositoryRepository, IJobRepository } from '../repositories/repository.repository';
import type { IChunkRepository, ChunkToInsert } from '../repositories/chunk.repository';
import type { IGitHubClient } from '../clients/github.client';
import type { IGitClonerClient, ClonedRepo } from '../clients/git-cloner.client';
import type { IEmbeddingProvider } from '../clients/embedding-provider';
import type { IChunkingService } from './chunking.service';
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
    private readonly githubClient: IGitHubClient,
    private readonly gitCloner: IGitClonerClient,
    private readonly chunkingService: IChunkingService,
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
    const importStartedAt = performance.now();

    await this.repositoryRepo.updateStatus(repositoryId, 'cloning');
    await this.jobRepo.updateStage(jobId, 'cloning', 5);

    const cloneStartedAt = performance.now();
    let cloned: ClonedRepo;
    try {
      cloned = await this.gitCloner.clone(cloneUrl, branch);
    } catch (err) {
      await this.failImport(repositoryId, jobId, err, 'Clone failed');
      return;
    }
    const cloneDurationMs = Math.round(performance.now() - cloneStartedAt);
    logger.info({ repositoryId, durationMs: cloneDurationMs }, 'Clone complete');

    try {
      await this.repositoryRepo.updateStatus(repositoryId, 'parsing', {
        defaultBranch: branch,
        commitSha: cloned.commitSha,
      });
      await this.jobRepo.updateStage(jobId, 'parsing', 20);

      const walkStartedAt = performance.now();
      const files = await walkRepoFiles(cloned.localPath, this.maxRepoFiles, this.maxFileSizeBytes * 1024);
      const walkDurationMs = Math.round(performance.now() - walkStartedAt);
      logger.info({ repositoryId, fileCount: files.length, durationMs: walkDurationMs }, 'File walk complete');

      const chunkStartedAt = performance.now();
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

      const chunkDurationMs = Math.round(performance.now() - chunkStartedAt);
      logger.info(
        { repositoryId, chunkCount: allChunks.length, durationMs: chunkDurationMs },
        'Chunking complete',
      );

      await this.repositoryRepo.updateStatus(repositoryId, 'embedding');
      await this.jobRepo.updateStage(jobId, 'embedding', 60);

      const embedStartedAt = performance.now();
      const embeddings =
        allChunks.length > 0
          ? await this.embeddingProvider.embedBatch(
              allChunks.map((c) => c.content),
              'document',
            )
          : [];
      const embedDurationMs = Math.round(performance.now() - embedStartedAt);
      logger.info(
        { repositoryId, embeddingCount: embeddings.length, durationMs: embedDurationMs },
        'Embedding complete',
      );

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

      const storeStartedAt = performance.now();
      const insertResult = await this.chunkRepo.insertManyIdempotent(chunksToInsert);
      const storeDurationMs = Math.round(performance.now() - storeStartedAt);
      logger.info({ repositoryId, ...insertResult, durationMs: storeDurationMs }, 'Chunks stored');

      await this.repositoryRepo.updateStatus(repositoryId, 'ready', { fileCount: files.length });
      await this.jobRepo.updateStage(jobId, 'complete', 100);

      /**
       * Why a single summary line with every stage's duration, in
       * addition to each stage already logging its own duration
       * individually above?
       *
       * Each stage's own log line answers "how long did THIS step
       * take," useful when reading logs live as an import runs. This
       * summary line is what actually answers the roadmap's stated
       * goal directly - "how long does indexing take, which stage is
       * the bottleneck" - in one place, without needing to manually
       * find and add up five separate log lines scattered through the
       * output. Both are genuinely useful for different reading
       * patterns, not redundant with each other.
       */
      const totalDurationMs = Math.round(performance.now() - importStartedAt);
      logger.info(
        {
          repositoryId,
          fileCount: files.length,
          chunkCount: allChunks.length,
          durationMs: totalDurationMs,
          stages: {
            cloneMs: cloneDurationMs,
            walkMs: walkDurationMs,
            chunkMs: chunkDurationMs,
            embedMs: embedDurationMs,
            storeMs: storeDurationMs,
          },
        },
        'Import complete',
      );
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
