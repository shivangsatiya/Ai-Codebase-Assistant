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
import { StaleJobRecoveryService } from '../services/stale-job-recovery.service';
import { RepositoryManagementService } from '../services/repository-management.service';
import { GitHubOAuthService } from '../services/github-oauth.service';
import { MongoRepositoryRepository, MongoJobRepository } from '../repositories/repository.repository';
import { MongoChunkRepository } from '../repositories/chunk.repository';
import { MongoChunkCheckpointRepository } from '../repositories/chunk-checkpoint.repository';
import { MongoChatRepository, MongoMessageRepository } from '../repositories/chat.repository';
import { MongoGitHubConnectionRepository } from '../repositories/github-connection.repository';
import { MongoGitHubOAuthStateRepository } from '../repositories/github-oauth-state.repository';
import { MongoRepositoryKnowledgeGraphRepository } from '../repositories/repository-knowledge-graph.repository';
import { TokenEncryptor } from '../utils/token-encryptor';
import { DeterministicExtractor } from '../services/knowledge-graph/deterministic-extractor';
import { InferredAnnotationExtractor } from '../services/knowledge-graph/inferred-annotation-extractor';
import { RepositoryIntelligencePipeline } from '../services/knowledge-graph/repository-intelligence-pipeline';
import { KnowledgeGraphGenerationService } from '../services/knowledge-graph/knowledge-graph-generation.service';
import { ArchitectureIntelligenceEngine } from '../services/knowledge-graph/architecture-intelligence-engine';
import { CycleDetector } from '../services/knowledge-graph/algorithms/cycle-detector';
import { DependencyAnalyzer } from '../services/knowledge-graph/algorithms/dependency-analyzer';
import { QuestionRouter } from '../services/knowledge-graph/question-router';

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
export const chunkCheckpointRepo = new MongoChunkCheckpointRepository();
export const chatRepo = new MongoChatRepository();
export const messageRepo = new MongoMessageRepository();
export const githubConnectionRepo = new MongoGitHubConnectionRepository();
export const githubOAuthStateRepo = new MongoGitHubOAuthStateRepository();
export const knowledgeGraphRepo = new MongoRepositoryKnowledgeGraphRepository();

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

export const deterministicExtractor = new DeterministicExtractor();
export const inferredAnnotationExtractor = new InferredAnnotationExtractor(chatCompletionProvider);
export const repositoryIntelligencePipeline = new RepositoryIntelligencePipeline(knowledgeGraphRepo);
export const knowledgeGraphGenerationService = new KnowledgeGraphGenerationService(
  deterministicExtractor,
  inferredAnnotationExtractor,
  repositoryIntelligencePipeline,
);

export const architectureIntelligenceEngine = new ArchitectureIntelligenceEngine();
architectureIntelligenceEngine.register(new CycleDetector());
architectureIntelligenceEngine.register(new DependencyAnalyzer());

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
  knowledgeGraphGenerationService,
  chunkCheckpointRepo,
);

export const staleJobRecoveryService = new StaleJobRecoveryService(
  jobRepo,
  repositoryImportService,
  env.STALE_JOB_THRESHOLD_MS,
);

export const retrievalService = new RetrievalService(embeddingProvider, chunkRepo, env.CHAT_RETRIEVAL_TOP_K);

// Declared here, after retrievalService and chatCompletionProvider both
// already exist - a real ordering bug was caught here during this
// task's own type-check/review (retrievalService didn't exist yet at
// the point questionRouter was originally declared, which would have
// thrown a ReferenceError at server startup), fixed by moving this
// declaration to after both its real dependencies.
export const questionRouter = new QuestionRouter(architectureIntelligenceEngine, retrievalService, chatCompletionProvider);

export const repositoryManagementService = new RepositoryManagementService(
  repositoryRepo,
  jobRepo,
  chunkRepo,
  chatRepo,
  messageRepo,
  chunkCheckpointRepo,
  knowledgeGraphRepo,
);

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
