import { RetrievalService } from '../src/services/retrieval.service';
import type { IEmbeddingProvider, EmbeddingInputType } from '../src/clients/embedding-provider';
import type { IChunkRepository, ChunkToInsert, InsertResult, ChunkSearchResult } from '../src/repositories/chunk.repository';
import { logger } from '../src/utils/logger';

class FakeEmbeddingProvider implements IEmbeddingProvider {
  public lastInputType: EmbeddingInputType | null = null;
  public lastTexts: string[] | null = null;

  constructor(private readonly vectorToReturn: number[][] | null) {}

  async embedBatch(texts: string[], inputType: EmbeddingInputType): Promise<number[][]> {
    this.lastTexts = texts;
    this.lastInputType = inputType;
    return this.vectorToReturn ?? [];
  }
}

class FakeChunkRepository implements IChunkRepository {
  public lastCall: { repositoryId: string; queryVector: number[]; limit: number } | null = null;

  constructor(private readonly resultsToReturn: ChunkSearchResult[]) {}

  async insertManyIdempotent(_chunks: ChunkToInsert[]): Promise<InsertResult> {
    return { inserted: 0, skippedDuplicates: 0 };
  }

  async countByRepository(_repositoryId: string): Promise<number> {
    return 0;
  }

  async vectorSearch(repositoryId: string, queryVector: number[], limit: number): Promise<ChunkSearchResult[]> {
    this.lastCall = { repositoryId, queryVector, limit };
    return this.resultsToReturn;
  }
}

describe('RetrievalService', () => {
  it('embeds the query with inputType "query", not "document"', async () => {
    const embeddingProvider = new FakeEmbeddingProvider([[0.1, 0.2, 0.3]]);
    const chunkRepo = new FakeChunkRepository([]);
    const service = new RetrievalService(embeddingProvider, chunkRepo, 8);

    await service.retrieve('repo-1', 'where is auth implemented?');

    expect(embeddingProvider.lastInputType).toBe('query');
    expect(embeddingProvider.lastTexts).toEqual(['where is auth implemented?']);
  });

  it('passes the resulting embedding, repositoryId, and topK through to vectorSearch', async () => {
    const vector = [0.1, 0.2, 0.3];
    const embeddingProvider = new FakeEmbeddingProvider([vector]);
    const chunkRepo = new FakeChunkRepository([]);
    const service = new RetrievalService(embeddingProvider, chunkRepo, 5);

    await service.retrieve('repo-42', 'a question');

    expect(chunkRepo.lastCall).toEqual({
      repositoryId: 'repo-42',
      queryVector: vector,
      limit: 5,
    });
  });

  it('returns the chunks from vectorSearch unmodified', async () => {
    const chunk: ChunkSearchResult = {
      filePath: 'src/x.ts',
      startLine: 1,
      endLine: 5,
      content: 'code',
      chunkType: 'function',
      language: 'TypeScript',
      score: 0.95,
    };
    const embeddingProvider = new FakeEmbeddingProvider([[0.1]]);
    const chunkRepo = new FakeChunkRepository([chunk]);
    const service = new RetrievalService(embeddingProvider, chunkRepo, 8);

    const result = await service.retrieve('repo-1', 'a question');

    expect(result).toEqual([chunk]);
  });

  it('returns an empty array without calling vectorSearch if embedding fails to produce a vector', async () => {
    const embeddingProvider = new FakeEmbeddingProvider(null); // simulates embedBatch returning []
    const chunkRepo = new FakeChunkRepository([{ filePath: 'x', startLine: 1, endLine: 1, content: 'x', chunkType: 'function', language: 'x', score: 1 }]);
    const service = new RetrievalService(embeddingProvider, chunkRepo, 8);

    const result = await service.retrieve('repo-1', 'a question');

    expect(result).toEqual([]);
    expect(chunkRepo.lastCall).toBeNull();
  });
});

describe('RetrievalService — observability', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs "Retrieval complete" with chunk count, top score, and a stage timing breakdown', async () => {
    const infoSpy = jest.spyOn(logger, 'info');
    const chunks: ChunkSearchResult[] = [
      { filePath: 'a.ts', startLine: 1, endLine: 2, content: 'x', chunkType: 'function', language: 'TypeScript', score: 0.72 },
      { filePath: 'b.ts', startLine: 1, endLine: 2, content: 'y', chunkType: 'function', language: 'TypeScript', score: 0.91 },
    ];
    const service = new RetrievalService(new FakeEmbeddingProvider([[0.1, 0.2]]), new FakeChunkRepository(chunks), 8);

    await service.retrieve('repo-1', 'a question');

    const call = infoSpy.mock.calls.find((c) => c[1] === 'Retrieval complete');
    expect(call).toBeDefined();
    const payload = call![0] as Record<string, unknown>;
    expect(payload.chunksRetrieved).toBe(2);
    // The highest of the two scores above (0.91), not the first/last -
    // this is what would catch a bug like accidentally using
    // results[0].score instead of an actual max.
    expect(payload.topScore).toBe(0.91);
    expect(payload).toHaveProperty('durationMs');
    expect(payload.stages).toEqual(
      expect.objectContaining({ embedMs: expect.any(Number), vectorSearchMs: expect.any(Number) }),
    );
  });

  it('logs chunksRetrieved: 0 and a null-safe result when no query embedding is produced', async () => {
    const infoSpy = jest.spyOn(logger, 'info');
    const service = new RetrievalService(new FakeEmbeddingProvider(null), new FakeChunkRepository([]), 8);

    await service.retrieve('repo-1', 'a question');

    const call = infoSpy.mock.calls.find((c) => c[1] === 'Retrieval complete');
    expect(call).toBeDefined();
    const payload = call![0] as Record<string, unknown>;
    expect(payload.chunksRetrieved).toBe(0);
  });

  it('logs topScore: null when no chunks are retrieved (not -Infinity, which is what Math.max() with no arguments silently returns)', async () => {
    const infoSpy = jest.spyOn(logger, 'info');
    const service = new RetrievalService(new FakeEmbeddingProvider([[0.1]]), new FakeChunkRepository([]), 8);

    await service.retrieve('repo-1', 'a question');

    const call = infoSpy.mock.calls.find((c) => c[1] === 'Retrieval complete');
    const payload = call![0] as Record<string, unknown>;
    expect(payload.topScore).toBeNull();
  });
});
