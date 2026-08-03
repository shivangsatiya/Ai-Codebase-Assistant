/**
 * Why an interface here, same as IUserRepository/IGitHubClient?
 *
 * ChunkingService's caller (RepositoryImportService) depends on this
 * interface, not any specific provider's client class - so tests can
 * inject a fake implementation that returns deterministic vectors
 * instantly, with no real network call, no API key, and no cost. The
 * real client (whichever provider is configured) is wired in exactly
 * once, in the composition root (repository.routes.ts). This is also
 * what made switching providers - twice, in fact: Voyage AI to OpenAI to
 * a fully local model - a same-day change each time: only the
 * composition root and one new client file changed - nothing about
 * chunking, storage, or the idempotency logic cared which provider was
 * behind the interface.
 */
export type EmbeddingInputType = 'document' | 'query';

export interface IEmbeddingProvider {
  embedBatch(texts: string[], inputType: EmbeddingInputType): Promise<number[][]>;
}
