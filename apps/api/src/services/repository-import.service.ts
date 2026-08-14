import { readFile } from 'fs/promises';
import { extname } from 'path';
import { performance } from 'perf_hooks';
import type { IRepositoryRepository, IJobRepository } from '../repositories/repository.repository';
import type { IChunkRepository, ChunkToInsert } from '../repositories/chunk.repository';
import type { IChunkCheckpointRepository } from '../repositories/chunk-checkpoint.repository';
import type { IGitHubClient } from '../clients/github.client';
import type { IGitClonerClient, ClonedRepo } from '../clients/git-cloner.client';
import type { IEmbeddingProvider } from '../clients/embedding-provider';
import type { IChunkingService } from './chunking.service';
import type { IGitHubConnectionRepository } from '../repositories/github-connection.repository';
import type { ITokenEncryptor } from '../utils/token-encryptor';
import type { IKnowledgeGraphGenerationService } from './knowledge-graph/knowledge-graph-generation.service';
import { walkRepoFiles } from '../utils/repo-file-walker';
import { logger } from '../utils/logger';
import { classifyImportFailure } from '../utils/import-failure-classifier';
import type { RepositoryDocument } from '../models/repository.model';
import type { JobDocument } from '../models/job.model';

export interface ImportResult {
  repository: RepositoryDocument;
  job: JobDocument;
  /**
   * Whether this call actually started new processing work, or is
   * just returning an existing repository unchanged - the route
   * handler uses this to decide between 200 (nothing new started) and
   * 202 (new work genuinely accepted), rather than always claiming
   * 202 "Accepted" even when nothing was actually queued.
   */
  isNewWork: boolean;
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
    private readonly githubConnectionRepo: IGitHubConnectionRepository,
    private readonly tokenEncryptor: ITokenEncryptor,
    private readonly knowledgeGraphGenerationService: IKnowledgeGraphGenerationService,
    private readonly chunkCheckpointRepo: IChunkCheckpointRepository,
  ) {}

  /**
   * Why is the per-user GitHub token looked up here, via `ownerId`
   * (taken from the authenticated caller's own verified JWT, never from
   * anything client-supplied), rather than accepted as a parameter to
   * this method?
   *
   * This is the Milestone 2 design review's explicit identity-resolution
   * rule, actually implemented rather than just documented: which
   * token gets used for an import must be resolved from the
   * authenticated caller's own identity exclusively - never a
   * repository id, a request body field, or any other client-influenced
   * value. Resolving it here, from `ownerId` alone, makes that the only
   * possible code path, rather than something a caller could get wrong
   * by passing the wrong token in.
   */
  async startImport(ownerId: string, githubUrl: string): Promise<ImportResult> {
    // Duplicate-import protection (Final Decision 1) - checked BEFORE
    // any GitHub API call for the common case, since returning an
    // existing, already-processed repository needs no external call at
    // all. Confirmed directly (repository.schemas.ts) that no URL
    // normalization existed anywhere before this - the lookup itself
    // (findByOwnerIdAndGithubUrl) handles that, not this method.
    const existing = await this.repositoryRepo.findByOwnerIdAndGithubUrl(ownerId, githubUrl);

    if (existing && existing.status !== 'failed') {
      // Ready, or already in progress - explicitly not duplicating any
      // work, per the approved design. A future commit on GitHub is
      // deliberately not detected or re-indexed here - out of scope,
      // per the same explicit decision ("that is a future
      // re-index/versioning concern").
      const job = await this.jobRepo.findByRepositoryId(existing._id.toString());
      if (job) {
        return { repository: existing, job, isNewWork: false };
      }
      // A Repository with no Job at all would only happen from data
      // corrupted outside this service's own control - falls through
      // to the restart path below rather than returning a nonsensical
      // "existing repository, no job" result.
    }

    const userToken = await this.resolveUserToken(ownerId);
    const repoInfo = await this.githubClient.fetchRepoInfo(githubUrl, userToken);

    if (existing && existing.status === 'failed') {
      // A genuine restart, not a new repository - the user explicitly
      // re-submitted after a failure, and silently handing back the
      // same stale failure would be unhelpful. Reuses the existing
      // document's real _id rather than creating a second one, which
      // is the entire point of this protection existing at all.
      await this.repositoryRepo.updateStatus(existing._id.toString(), 'queued', {
        errorMessage: '',
        isPrivate: repoInfo.isPrivate,
      });
      const job = await this.jobRepo.createForRepository(existing._id.toString());

      this.runImportPipeline(
        existing._id.toString(),
        job._id.toString(),
        repoInfo.cloneUrl,
        repoInfo.defaultBranch,
        repoInfo.isPrivate,
        userToken,
      ).catch((err) => {
        logger.error({ err, repositoryId: existing._id.toString() }, 'Unhandled error in import pipeline');
      });

      return { repository: existing, job, isNewWork: true };
    }

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
      repoInfo.isPrivate,
      userToken,
    ).catch((err) => {
      logger.error({ err, repositoryId: repository._id.toString() }, 'Unhandled error in import pipeline');
    });

    return { repository, job, isNewWork: true };
  }

  /**
   * The entry point the stale-job recovery sweep (Task 4.4,
   * stale-job-recovery.service.ts) calls after claimStale() has
   * atomically claimed a genuinely stale, non-terminal job. Reuses the
   * SAME repositoryId and jobId as the original, interrupted attempt -
   * never creates a new Repository or Job document, which is exactly
   * what keeps the checkpoint cleanup (deleteByJobId) and the
   * checkpoint-reuse check (findByRepositoryAndCommit, above in
   * runImportPipeline) correctly aligned across attempts.
   *
   * Deliberately re-does the same setup steps startImport() does for a
   * fresh import (resolve token, fetch current repo info) rather than
   * trusting anything cached from the original attempt - the user's
   * GitHub connection, the repository's visibility, or its default
   * branch could genuinely have changed in the time since the original
   * attempt crashed.
   */
  async resumeImport(repositoryId: string, jobId: string): Promise<void> {
    const repository = await this.repositoryRepo.findById(repositoryId);
    if (!repository) {
      // The repository was deleted while its stale job was awaiting
      // recovery (a real, explicitly considered concurrency case) -
      // nothing left to resume; not an error, just nothing to do.
      logger.info({ repositoryId, jobId }, 'Skipped resuming a stale job - its repository no longer exists');
      return;
    }

    let userToken: string | undefined;
    try {
      userToken = await this.resolveUserToken(repository.ownerId.toString());
      const repoInfo = await this.githubClient.fetchRepoInfo(repository.githubUrl, userToken);

      await this.runImportPipeline(
        repositoryId,
        jobId,
        repoInfo.cloneUrl,
        repoInfo.defaultBranch,
        repoInfo.isPrivate,
        userToken,
      );
    } catch (err) {
      // fetchRepoInfo (or token resolution) can throw before
      // runImportPipeline's own internal try/catch even begins - still
      // routed through the same failImport() path, so this resume
      // attempt is recorded as a real, honest failure rather than an
      // unhandled rejection that would leave the job silently stuck
      // again, defeating the entire purpose of the sweep.
      await this.failImport(repositoryId, jobId, err, 'Resume failed before the pipeline could start');
    }
  }

  private async resolveUserToken(ownerId: string): Promise<string | undefined> {
    const connection = await this.githubConnectionRepo.findByUserId(ownerId);
    if (!connection) return undefined;

    return this.tokenEncryptor.decrypt({
      ciphertext: connection.encryptedToken,
      iv: connection.iv,
      authTag: connection.authTag,
      keyVersion: connection.keyVersion,
    });
  }

  private async runImportPipeline(
    repositoryId: string,
    jobId: string,
    cloneUrl: string,
    branch: string,
    isPrivate: boolean,
    userToken?: string,
  ): Promise<void> {
    const importStartedAt = performance.now();

    await this.repositoryRepo.updateStatus(repositoryId, 'cloning');
    await this.jobRepo.updateStage(jobId, 'cloning', 5);

    const cloneStartedAt = performance.now();
    let cloned: ClonedRepo;
    try {
      cloned = await this.gitCloner.clone(cloneUrl, branch, userToken);
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

      // Always checked, for both a fresh import AND a resumed one - a
      // fresh import's repositoryId+commitSha combination can never
      // already have a checkpoint (nothing wrote one yet), so this is a
      // harmless no-op there, not a behavior change. A resumed job
      // (Task 4.4 - repository-recovery.service.ts) reuses the SAME
      // repositoryId, and if the re-clone above landed on the same
      // commit as an earlier, interrupted attempt, its already-computed
      // chunks are reused directly - skipping a full re-walk and
      // re-chunk of every file, the entire point of the checkpoint from
      // Task 4.3 existing at all. If the commit differs (the repo
      // changed since the last attempt) or nothing was checkpointed
      // yet (crashed before chunking even finished), this falls through
      // to the normal, full walk+chunk below exactly as before.
      const existingCheckpoint = await this.chunkCheckpointRepo.findByRepositoryAndCommit(
        repositoryId,
        cloned.commitSha,
      );

      let files: Awaited<ReturnType<typeof walkRepoFiles>>;
      let allChunks: Array<{
        filePath: string;
        startLine: number;
        endLine: number;
        content: string;
        symbolName?: string;
        chunkType: string;
        language: string;
        contentHash: string;
      }>;
      let walkDurationMs: number;
      let chunkDurationMs: number;
      let resumedFromCheckpoint = false;

      if (existingCheckpoint.length > 0) {
        resumedFromCheckpoint = true;
        walkDurationMs = 0;
        chunkDurationMs = 0;
        allChunks = existingCheckpoint.map((c) => ({
          filePath: c.filePath,
          startLine: c.startLine,
          endLine: c.endLine,
          content: c.content,
          symbolName: c.symbolName,
          chunkType: c.chunkType,
          language: c.language,
          contentHash: c.contentHash,
        }));
        // Graph generation still needs the real files on disk (it reads
        // full file content, not chunks - see its own comment below),
        // so the file list is still walked here even when chunking
        // itself is skipped. Cheap relative to chunking/embedding.
        files = await walkRepoFiles(cloned.localPath, this.maxRepoFiles, this.maxFileSizeBytes * 1024);
        logger.info(
          { repositoryId, jobId, checkpointedChunkCount: allChunks.length },
          'Resumed from an existing chunk checkpoint - skipped re-walking and re-chunking',
        );
      } else {
        files = await walkRepoFiles(cloned.localPath, this.maxRepoFiles, this.maxFileSizeBytes * 1024);
        walkDurationMs = Math.round(performance.now() - walkStartedAt);
        logger.info({ repositoryId, fileCount: files.length, durationMs: walkDurationMs }, 'File walk complete');

        const chunkStartedAt = performance.now();
        allChunks = [];

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

        chunkDurationMs = Math.round(performance.now() - chunkStartedAt);
        logger.info(
          { repositoryId, chunkCount: allChunks.length, durationMs: chunkDurationMs },
          'Chunking complete',
        );

        // The real, new durable checkpoint this task exists to add -
        // written right after chunking finishes, BEFORE the slowest real
        // step in the whole pipeline (embedding - measured at 156s for a
        // real 56-file repository, Milestone 4 Task 1). Everything from
        // here through the real Chunk+embedding persistence below is
        // still in-memory (`allChunks`) - this checkpoint is what lets a
        // future resume answer "what chunking work was already done"
        // without needing to re-clone and re-chunk from scratch.
        // Best-effort: a checkpoint failure should never fail the actual
        // import, since the in-memory chunks still flow through to real
        // persistence normally either way. Skipped entirely when this
        // run itself resumed from an existing checkpoint above - no
        // need to immediately re-write the same rows back.
        try {
          await this.chunkCheckpointRepo.insertMany(
            allChunks.map((chunk) => ({
              repositoryId,
              jobId,
              commitSha: cloned.commitSha,
              filePath: chunk.filePath,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              content: chunk.content,
              contentHash: chunk.contentHash,
              chunkType: chunk.chunkType,
              symbolName: chunk.symbolName,
              language: chunk.language,
            })),
          );
        } catch (err) {
          logger.error({ err, repositoryId, jobId }, 'Failed to write chunk checkpoint (non-fatal, import continues)');
        }
      }

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

      // The real, embedded chunks are now safely persisted - the
      // checkpoint has served its entire purpose (letting a resume
      // avoid re-chunking) and is deleted, not left to accumulate
      // indefinitely. Best-effort: a cleanup failure here is a minor,
      // recoverable annoyance (an orphaned checkpoint, cleaned up later
      // by repository deletion or a future sweep), never a reason to
      // fail an otherwise-successful import.
      try {
        await this.chunkCheckpointRepo.deleteByJobId(jobId);
      } catch (err) {
        logger.error({ err, repositoryId, jobId }, 'Failed to clean up chunk checkpoint (non-fatal)');
      }

      /**
       * Why is this wrapped in its own try/catch, never allowed to call
       * failImport()?
       *
       * A graph-generation failure must not fail the whole import - the
       * user's primary goal (chat with their repo) already succeeded by
       * this point, and shouldn't be undone by a problem in a genuinely
       * separate, additive feature. Logged clearly either way, exactly
       * like every other stage, but never fatal to the import itself.
       *
       * Why read file content a second time here, rather than keep it
       * around from the chunking loop above?
       *
       * Keeping every file's full content in memory for the whole
       * pipeline's duration would meaningfully increase peak memory
       * usage - the exact category of problem the real OOM incident
       * (Milestone 1.5->1.75) was about. Re-reading is cheap at this
       * project's MAX_REPO_FILES=15 scale and keeps the existing,
       * already-tested chunking loop's memory profile completely
       * unchanged rather than restructuring it to hold onto content it
       * doesn't otherwise need.
       *
       * Why must this run here, before cleanup(), and not as a later,
       * separate job?
       *
       * DeterministicExtractor needs each file's FULL source to find
       * import statements - a chunk only ever contains one function's
       * or class's content, and cleanup() (in the finally block below)
       * deletes the cloned source directory the moment this whole try
       * block exits.
       */
      const graphStartedAt = performance.now();
      let graphDurationMs = 0;
      try {
        const extractorFiles = [];
        for (const file of files) {
          const content = await readFile(file.absolutePath, 'utf-8').catch(() => null);
          if (content === null) continue;
          extractorFiles.push({ relativePath: file.relativePath, content, extension: extname(file.relativePath) });
        }

        const extractorSymbols = allChunks.map((c) => ({
          filePath: c.filePath,
          chunkType: c.chunkType,
          symbolName: c.symbolName,
          language: c.language,
        }));

        const graphResult = await this.knowledgeGraphGenerationService.generateGraph(
          repositoryId,
          cloned.commitSha,
          extractorFiles,
          extractorSymbols,
        );
        graphDurationMs = Math.round(performance.now() - graphStartedAt);
        logger.info(
          { repositoryId, commitSha: cloned.commitSha, status: graphResult.status, durationMs: graphDurationMs },
          'Knowledge graph generation complete',
        );
      } catch (err) {
        graphDurationMs = Math.round(performance.now() - graphStartedAt);
        logger.error({ err, repositoryId, durationMs: graphDurationMs }, 'Knowledge graph generation failed');
      }

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
          isPrivate,
          resumedFromCheckpoint,
          durationMs: totalDurationMs,
          stages: {
            cloneMs: cloneDurationMs,
            walkMs: walkDurationMs,
            chunkMs: chunkDurationMs,
            embedMs: embedDurationMs,
            storeMs: storeDurationMs,
            graphMs: graphDurationMs,
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
    const failureCategory = classifyImportFailure(err);
    logger.error({ err, repositoryId, failureCategory }, context);
    await this.repositoryRepo.updateStatus(repositoryId, 'failed', { errorMessage: message });
    await this.jobRepo.updateStage(jobId, 'failed', 0, message, failureCategory);
  }
}
