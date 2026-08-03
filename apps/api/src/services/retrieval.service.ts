import type { IEmbeddingProvider } from '../clients/embedding-provider';
import type { IChunkRepository, ChunkSearchResult } from '../repositories/chunk.repository';

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
   */
  async retrieve(repositoryId: string, query: string): Promise<ChunkSearchResult[]> {
    const [queryEmbedding] = await this.embeddingProvider.embedBatch([query], 'query');
    if (!queryEmbedding) return [];

    return this.chunkRepo.vectorSearch(repositoryId, queryEmbedding, this.topK);
  }
}
