import mongoose from 'mongoose';
import { env } from './env';
import { logger } from '../utils/logger';
import { UserModel } from '../models/user.model';
import { RepositoryModel } from '../models/repository.model';
import { JobModel } from '../models/job.model';
import { ChunkModel } from '../models/chunk.model';
import { ChatModel } from '../models/chat.model';
import { MessageModel } from '../models/message.model';
import { RefreshTokenModel } from '../models/refresh-token.model';
import { GitHubConnectionModel } from '../models/github-connection.model';
import { GitHubOAuthStateModel } from '../models/github-oauth-state.model';
import { RepositoryKnowledgeGraphModel } from '../models/repository-knowledge-graph.model';

export async function connectDB(): Promise<void> {
  mongoose.set('strictQuery', true);

  mongoose.connection.on('error', (err) => {
    logger.error({ err }, 'MongoDB connection error');
  });

  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
  });

  await mongoose.connect(env.MONGODB_URI);
  logger.info('MongoDB connected');

  await ensureIndexesReady();
}

/**
 * Why explicitly wait for indexes here instead of trusting Mongoose's
 * default autoIndex behavior?
 *
 * Mongoose builds declared indexes (including unique ones) in the
 * background after a connection is established - it does NOT block until
 * they exist. That means there's a real window, right after startup,
 * where a request could insert data before a unique index is actually
 * enforcing anything. This bit us concretely: the chunk idempotency
 * guarantee (unique on repositoryId+commitSha+contentHash) silently
 * didn't apply yet during that window, letting a "duplicate" insert
 * succeed. Model.init() resolves only once a model's indexes are
 * confirmed built, so awaiting it before the server starts accepting
 * traffic closes that window entirely.
 *
 * RefreshTokenModel has a unique index on `jti` - the exact same risk
 * shape as the chunk bug above, so it's included here for the same
 * reason. ChatModel and MessageModel's indexes aren't unique (so the
 * failure mode is a slower query during the startup window, not a
 * correctness bug), but they were missing from this list since Day 5
 * and are added here for consistency - every model with a declared
 * index belongs in this list, not just the ones that would break loudly
 * if skipped.
 *
 * GitHubConnectionModel (unique on userId) and GitHubOAuthStateModel
 * (unique on state) are both the same risk shape as RefreshTokenModel -
 * this checklist item has been missed once already (Milestone 1.5, Task
 * 3, for ChatModel/MessageModel), so every new indexed model added to
 * this project gets checked against this list deliberately now, not by
 * memory.
 */
async function ensureIndexesReady(): Promise<void> {
  await Promise.all([
    UserModel.init(),
    RepositoryModel.init(),
    JobModel.init(),
    ChunkModel.init(),
    ChatModel.init(),
    MessageModel.init(),
    RefreshTokenModel.init(),
    GitHubConnectionModel.init(),
    GitHubOAuthStateModel.init(),
    RepositoryKnowledgeGraphModel.init(),
  ]);
  logger.info('MongoDB indexes confirmed built');
}

export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect();
}
