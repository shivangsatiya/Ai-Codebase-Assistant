import { env } from './env';
import { GitHubClient } from '../clients/github.client';
import { GitClonerClient } from '../clients/git-cloner.client';
import { LocalEmbeddingClient } from '../clients/local-embedding.client';
import { GroqChatClient } from '../clients/groq-chat.client';
import { GitHubOAuthClient } from '../clients/github-oauth.client';
import { ChunkingService } from '../services/chunking.service';
import { RetrievalService } from '../services/retrieval.service';
import { ChatOrchestrationService } from '../services/chat-orchestration.service';
import { RepositoryImportService } from '../services/repository-import.service';
import { GitHubOAuthService } from '../services/github-oauth.service';
import { MongoRepositoryRepository, MongoJobRepository } from '../repositories/repository.repository';
import { MongoChunkRepository } from '../repositories/chunk.repository';
import { MongoChatRepository, MongoMessageRepository } from '../repositories/chat.repository';
import { MongoGitHubConnectionRepository } from '../repositories/github-connection.repository';
import { MongoGitHubOAuthStateRepository } from '../repositories/github-oauth-state.repository';
import { TokenEncryptor } from '../utils/token-encryptor';

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
export const githubConnectionRepo = new MongoGitHubConnectionRepository();
export const githubOAuthStateRepo = new MongoGitHubOAuthStateRepository();

export const githubClient = new GitHubClient(env.GITHUB_TOKEN);
export const gitCloner = new GitClonerClient();
export const chunkingService = new ChunkingService();
export const embeddingProvider = new LocalEmbeddingClient(env.LOCAL_EMBEDDING_MODEL);
export const chatCompletionProvider = new GroqChatClient(env.GROQ_API_KEY, env.GROQ_MODEL, env.GROQ_MAX_TOKENS);
export const githubOAuthClient = new GitHubOAuthClient(
  env.GITHUB_OAUTH_CLIENT_ID,
  env.GITHUB_OAUTH_CLIENT_SECRET,
  env.GITHUB_OAUTH_REDIRECT_URI,
);

/**
 * Key version is a plain constant, not an env var - it identifies which
 * TOKEN_ENCRYPTION_KEY encrypted a given value (see TokenEncryptor's own
 * doc comment), and only needs to change the day a real key rotation
 * happens, at which point it becomes a deliberate code change, not a
 * runtime configuration value someone could accidentally desync from
 * the actual key in use.
 */
const CURRENT_TOKEN_ENCRYPTION_KEY_VERSION = 1;
export const tokenEncryptor = new TokenEncryptor(env.TOKEN_ENCRYPTION_KEY, CURRENT_TOKEN_ENCRYPTION_KEY_VERSION);

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
  githubConnectionRepo,
  tokenEncryptor,
);

export const retrievalService = new RetrievalService(embeddingProvider, chunkRepo, env.CHAT_RETRIEVAL_TOP_K);

export const chatOrchestrationService = new ChatOrchestrationService(
  chatRepo,
  messageRepo,
  retrievalService,
  chatCompletionProvider,
);

export const githubOAuthService = new GitHubOAuthService(
  githubOAuthClient,
  githubConnectionRepo,
  githubOAuthStateRepo,
  tokenEncryptor,
);
