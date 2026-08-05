import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { RepositoryImportService } from '../src/services/repository-import.service';
import type { IRepositoryRepository, IJobRepository, CreateRepositoryInput } from '../src/repositories/repository.repository';
import type { IChunkRepository, ChunkToInsert, InsertResult, ChunkSearchResult } from '../src/repositories/chunk.repository';
import type { IGitHubClient, GitHubRepoInfo } from '../src/clients/github.client';
import type { IGitClonerClient, ClonedRepo } from '../src/clients/git-cloner.client';
import type { IEmbeddingProvider, EmbeddingInputType } from '../src/clients/embedding-provider';
import type { IChunkingService, EnrichedChunk } from '../src/services/chunking.service';
import type { RepositoryDocument, RepositoryStatus } from '../src/models/repository.model';
import type { JobDocument, JobStage } from '../src/models/job.model';
import { logger } from '../src/utils/logger';

function makeRepoDoc(id: string): RepositoryDocument {
  return { _id: { toString: () => id } } as unknown as RepositoryDocument;
}

function makeJobDoc(id: string): JobDocument {
  return { _id: { toString: () => id } } as unknown as JobDocument;
}

class FakeRepositoryRepository implements IRepositoryRepository {
  public statusUpdates: Array<{ id: string; status: RepositoryStatus }> = [];

  async create(_input: CreateRepositoryInput): Promise<RepositoryDocument> {
    return makeRepoDoc('repo-1');
  }

  async findById(_id: string): Promise<RepositoryDocument | null> {
    return makeRepoDoc('repo-1');
  }

  async updateStatus(id: string, status: RepositoryStatus): Promise<void> {
    this.statusUpdates.push({ id, status });
  }
}

class FakeJobRepository implements IJobRepository {
  public stageUpdates: Array<{ stage: JobStage; progress: number }> = [];

  async createForRepository(_repositoryId: string): Promise<JobDocument> {
    return makeJobDoc('job-1');
  }

  async findByRepositoryId(_repositoryId: string): Promise<JobDocument | null> {
    return makeJobDoc('job-1');
  }

  async updateStage(_id: string, stage: JobStage, progress: number): Promise<void> {
    this.stageUpdates.push({ stage, progress });
  }
}

class FakeGitHubClient implements IGitHubClient {
  parseRepoUrl(_url: string): { owner: string; repo: string } {
    return { owner: 'test-owner', repo: 'test-repo' };
  }

  async fetchRepoInfo(_url: string): Promise<GitHubRepoInfo> {
    return {
      fullName: 'test-owner/test-repo',
      defaultBranch: 'main',
      isPrivate: false,
      cloneUrl: 'https://github.com/test-owner/test-repo.git',
    };
  }
}

class FakeGitClonerClient implements IGitClonerClient {
  public cleanupCalled = false;
  private tempDir: string | null = null;

  constructor(
    private readonly delayMs: number = 5,
    private readonly shouldFail: boolean = false,
  ) {}

  async clone(_cloneUrl: string, _branch: string): Promise<ClonedRepo> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.shouldFail) {
      throw new Error('Simulated clone failure');
    }

    // walkRepoFiles() is called directly by RepositoryImportService (not
    // dependency-injected), so it operates on the REAL filesystem - a
    // fake, non-existent path here would throw ENOENT. A real temp
    // directory with one small real file is what lets the rest of the
    // pipeline (walk -> chunk -> embed) run genuinely, through fakes
    // only from the chunking/embedding stage onward.
    this.tempDir = await mkdtemp(join(tmpdir(), 'import-test-'));
    await writeFile(join(this.tempDir, 'index.ts'), 'export const x = 1;');

    const localPath = this.tempDir;
    return {
      localPath,
      commitSha: 'abc123',
      cleanup: async () => {
        this.cleanupCalled = true;
        if (this.tempDir) await rm(this.tempDir, { recursive: true, force: true });
      },
    };
  }
}

class FakeChunkingService implements IChunkingService {
  constructor(private readonly delayMs: number = 5) {}

  async chunkFile(filePath: string, content: string, _extension: string): Promise<EnrichedChunk[]> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return [
      {
        filePath,
        startLine: 1,
        endLine: content.split('\n').length,
        content,
        chunkType: 'function',
        source: 'line-window',
        language: 'TypeScript',
        contentHash: 'hash-' + filePath,
      },
    ];
  }
}

class FakeEmbeddingProvider implements IEmbeddingProvider {
  constructor(private readonly delayMs: number = 5) {}

  async embedBatch(texts: string[], _inputType: EmbeddingInputType): Promise<number[][]> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return texts.map(() => [0.1, 0.2, 0.3]);
  }
}

class FakeChunkRepository implements IChunkRepository {
  public inserted: ChunkToInsert[] = [];

  async insertManyIdempotent(chunks: ChunkToInsert[]): Promise<InsertResult> {
    this.inserted.push(...chunks);
    return { inserted: chunks.length, skippedDuplicates: 0 };
  }

  async countByRepository(_repositoryId: string): Promise<number> {
    return this.inserted.length;
  }

  async vectorSearch(_repositoryId: string, _queryVector: number[], _limit: number): Promise<ChunkSearchResult[]> {
    return [];
  }
}

/**
 * jest.spyOn types mock.calls arguments as unknown[] - this is just a
 * typed accessor for the structured log payload (the first argument to
 * every logger.info() call in this codebase), to avoid `as any` sprinkled
 * through every assertion below.
 */
function logPayload(call: unknown[] | undefined): Record<string, any> {
  if (!call) throw new Error('Expected a matching log call but found none');
  return call[0] as Record<string, any>;
}

/**
 * Waits for the "Import complete" summary log line to be emitted -
 * since startImport() deliberately doesn't await the background
 * pipeline (see the class's own doc comment), tests need to poll for
 * the pipeline's actual completion rather than assuming it's done the
 * instant startImport() resolves.
 */
async function waitForImportComplete(infoSpy: jest.SpyInstance, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = infoSpy.mock.calls.some((call) => call[1] === 'Import complete');
    if (found) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for "Import complete" log line');
}

describe('RepositoryImportService - pipeline timing (observability)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs a "Clone complete" line with a positive durationMs', async () => {
    const infoSpy = jest.spyOn(logger, 'info');
    const service = new RepositoryImportService(
      new FakeRepositoryRepository(),
      new FakeJobRepository(),
      new FakeGitHubClient(),
      new FakeGitClonerClient(20),
      new FakeChunkingService(0),
      new FakeEmbeddingProvider(0),
      new FakeChunkRepository(),
      100,
      500,
    );

    await service.startImport('user-1', 'https://github.com/test-owner/test-repo');
    await waitForImportComplete(infoSpy);

    const cloneLog = infoSpy.mock.calls.find((call) => call[1] === 'Clone complete');
    expect(cloneLog).toBeDefined();
    expect(logPayload(cloneLog).durationMs).toBeGreaterThanOrEqual(15); // allow small scheduling variance below the 20ms delay
  });

  it('logs "File walk complete" and "Chunking complete" each with their own durationMs', async () => {
    const infoSpy = jest.spyOn(logger, 'info');
    const service = new RepositoryImportService(
      new FakeRepositoryRepository(),
      new FakeJobRepository(),
      new FakeGitHubClient(),
      new FakeGitClonerClient(0),
      new FakeChunkingService(0),
      new FakeEmbeddingProvider(0),
      new FakeChunkRepository(),
      100,
      500,
    );

    await service.startImport('user-1', 'https://github.com/test-owner/test-repo');
    await waitForImportComplete(infoSpy);

    const walkLog = infoSpy.mock.calls.find((call) => call[1] === 'File walk complete');
    const chunkLog = infoSpy.mock.calls.find((call) => call[1] === 'Chunking complete');
    expect(logPayload(walkLog)).toHaveProperty('durationMs');
    expect(logPayload(chunkLog)).toHaveProperty('durationMs');
    expect(typeof logPayload(walkLog).durationMs).toBe('number');
    expect(typeof logPayload(chunkLog).durationMs).toBe('number');
  });

  it('logs "Embedding complete" with durationMs and the embedding count, separately from "Chunks stored"', async () => {
    const infoSpy = jest.spyOn(logger, 'info');
    const service = new RepositoryImportService(
      new FakeRepositoryRepository(),
      new FakeJobRepository(),
      new FakeGitHubClient(),
      new FakeGitClonerClient(0),
      new FakeChunkingService(0),
      new FakeEmbeddingProvider(15),
      new FakeChunkRepository(),
      100,
      500,
    );

    await service.startImport('user-1', 'https://github.com/test-owner/test-repo');
    await waitForImportComplete(infoSpy);

    const embedLog = infoSpy.mock.calls.find((call) => call[1] === 'Embedding complete');
    expect(embedLog).toBeDefined();
    expect(logPayload(embedLog).durationMs).toBeGreaterThanOrEqual(10);
    expect(logPayload(embedLog)).toHaveProperty('embeddingCount');
  });

  it('logs a single "Import complete" summary with total duration and a per-stage breakdown', async () => {
    const infoSpy = jest.spyOn(logger, 'info');
    const service = new RepositoryImportService(
      new FakeRepositoryRepository(),
      new FakeJobRepository(),
      new FakeGitHubClient(),
      new FakeGitClonerClient(10),
      new FakeChunkingService(10),
      new FakeEmbeddingProvider(10),
      new FakeChunkRepository(),
      100,
      500,
    );

    await service.startImport('user-1', 'https://github.com/test-owner/test-repo');
    await waitForImportComplete(infoSpy);

    const summaryLog = infoSpy.mock.calls.find((call) => call[1] === 'Import complete');
    expect(summaryLog).toBeDefined();

    const payload = logPayload(summaryLog);
    expect(payload).toHaveProperty('durationMs');
    expect(payload).toHaveProperty('fileCount');
    expect(payload).toHaveProperty('chunkCount');
    expect(payload.stages).toEqual(
      expect.objectContaining({
        cloneMs: expect.any(Number),
        walkMs: expect.any(Number),
        chunkMs: expect.any(Number),
        embedMs: expect.any(Number),
        storeMs: expect.any(Number),
      }),
    );

    // The total should be at least the sum of the individually-delayed
    // stages (clone + chunking + embedding each had a real delay above)
    // - a sanity check that the summary reflects genuinely elapsed time,
    // not a placeholder or a miscomputed value.
    expect(payload.durationMs).toBeGreaterThanOrEqual(25);
  });

  it('does not log "Import complete" if the clone step fails', async () => {
    const infoSpy = jest.spyOn(logger, 'info');
    jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const service = new RepositoryImportService(
      new FakeRepositoryRepository(),
      new FakeJobRepository(),
      new FakeGitHubClient(),
      new FakeGitClonerClient(0, true), // shouldFail = true
      new FakeChunkingService(0),
      new FakeEmbeddingProvider(0),
      new FakeChunkRepository(),
      100,
      500,
    );

    await service.startImport('user-1', 'https://github.com/test-owner/test-repo');
    // Give the background pipeline a moment to run and fail.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const summaryLog = infoSpy.mock.calls.find((call) => call[1] === 'Import complete');
    expect(summaryLog).toBeUndefined();
  });
});
