import { performance } from 'perf_hooks';
import type { IEmbeddingProvider } from '../clients/embedding-provider';
import type { IChunkRepository, ChunkSearchResult } from '../repositories/chunk.repository';
import { logger } from '../utils/logger';

export interface IRetrievalService {
  retrieve(repositoryId: string, query: string): Promise<ChunkSearchResult[]>;
}

export class RetrievalService implements IRetrievalService {
  constructor(
    private readonly embeddingProvider: IEmbeddingProvider,
    private readonly chunkRepo: IChunkRepository,
    private readonly topK: number,
  ) {}

  /**
   * Why embed the query with inputType 'query' specifically?
   *
   * Some embedding models (Voyage's code models, for instance) train
   * asymmetric embeddings differently for indexed content vs search
   * queries. LocalEmbeddingClient currently ignores this hint (see its
   * own doc comment), but keeping the distinction here means swapping in
   * a provider that DOES support it requires no change to this service.
   *
   * Why log embedMs and vectorSearchMs separately rather than one
   * combined duration?
   *
   * These are genuinely different kinds of work with different failure
   * modes - embedding a single short query is CPU-bound local inference
   * (fast, and the same code path as the much larger indexing-time
   * embedding calls), while vector search is a real database round-trip
   * to Atlas. If retrieval ever feels slow, this is what tells you
   * whether to look at the embedding model or the database/network,
   * rather than guessing from one combined number.
   */
  async retrieve(repositoryId: string, query: string): Promise<ChunkSearchResult[]> {
    const embedStartedAt = performance.now();
    const [queryEmbedding] = await this.embeddingProvider.embedBatch([query], 'query');
    const embedDurationMs = Math.round(performance.now() - embedStartedAt);

    if (!queryEmbedding) {
      logger.info(
        { repositoryId, chunksRetrieved: 0, durationMs: embedDurationMs, stages: { embedMs: embedDurationMs } },
        'Retrieval complete',
      );
      return [];
    }

    const searchStartedAt = performance.now();
    const results = await this.chunkRepo.vectorSearch(repositoryId, queryEmbedding, this.topK);
    const vectorSearchMs = Math.round(performance.now() - searchStartedAt);

    // The highest similarity score among retrieved chunks - a cheap,
    // useful signal of retrieval confidence at a glance in the logs: a
    // low top score across many questions for a given repo suggests the
    // embedding model or chunking strategy isn't capturing that repo's
    // content well, without needing a full evaluation harness to notice.
    const topScore = results.length > 0 ? Math.max(...results.map((r) => r.score)) : null;

    logger.info(
      {
        repositoryId,
        chunksRetrieved: results.length,
        topScore,
        durationMs: embedDurationMs + vectorSearchMs,
        stages: { embedMs: embedDurationMs, vectorSearchMs },
      },
      'Retrieval complete',
    );

    return results;
  }
}
