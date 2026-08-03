import { env } from './env';
import { GitHubClient } from '../clients/github.client';
import { GitClonerClient } from '../clients/git-cloner.client';
import { LocalEmbeddingClient } from '../clients/local-embedding.client';
import { GroqChatClient } from '../clients/groq-chat.client';
import { ChunkingService } from '../services/chunking.service';
import { RetrievalService } from '../services/retrieval.service';
import { ChatOrchestrationService } from '../services/chat-orchestration.service';
import { RepositoryImportService } from '../services/repository-import.service';
import { MongoRepositoryRepository, MongoJobRepository } from '../repositories/repository.repository';
import { MongoChunkRepository } from '../repositories/chunk.repository';
import { MongoChatRepository, MongoMessageRepository } from '../repositories/chat.repository';

/**
 * Why one composition root instead of each route file constructing its
 * own dependencies (which is what repository.routes.ts originally did)?
 *
 * LocalEmbeddingClient lazily loads a ~90MB ONNX model on first use and
 * caches it in memory. If RepositoryImportService (indexing) and
 * RetrievalService (chat) each constructed their own instance, the model
 * would load twice - doubling memory use and the one-time load latency
 * for no reason. Building every shared dependency exactly once here, and
 * having every route file import from this module instead of
 * constructing its own copies, is what guarantees that.
 */
export const repositoryRepo = new MongoRepositoryRepository();
export const jobRepo = new MongoJobRepository();
export const chunkRepo = new MongoChunkRepository();
export const chatRepo = new MongoChatRepository();
export const messageRepo = new MongoMessageRepository();

export const githubClient = new GitHubClient(env.GITHUB_TOKEN);
export const gitCloner = new GitClonerClient();
export const chunkingService = new ChunkingService();
export const embeddingProvider = new LocalEmbeddingClient(env.LOCAL_EMBEDDING_MODEL);
export const chatCompletionProvider = new GroqChatClient(env.GROQ_API_KEY, env.GROQ_MODEL, env.GROQ_MAX_TOKENS);

export const repositoryImportService = new RepositoryImportService(
  repositoryRepo,
  jobRepo,
  githubClient,
  gitCloner,
  chunkingService,
  embeddingProvider,
  chunkRepo,
  env.MAX_REPO_FILES,
  env.MAX_FILE_SIZE_KB,
);

export const retrievalService = new RetrievalService(embeddingProvider, chunkRepo, env.CHAT_RETRIEVAL_TOP_K);

export const chatOrchestrationService = new ChatOrchestrationService(
  chatRepo,
  messageRepo,
  retrievalService,
  chatCompletionProvider,
);
