import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { UserModel } from '../src/models/user.model';
import { RepositoryModel } from '../src/models/repository.model';
import { JobModel } from '../src/models/job.model';
import { ChunkModel } from '../src/models/chunk.model';
import { ChatModel } from '../src/models/chat.model';
import { MessageModel } from '../src/models/message.model';
import { RefreshTokenModel } from '../src/models/refresh-token.model';
import { GitHubConnectionModel } from '../src/models/github-connection.model';
import { GitHubOAuthStateModel } from '../src/models/github-oauth-state.model';
import { RepositoryKnowledgeGraphModel } from '../src/models/repository-knowledge-graph.model';

let mongoServer: MongoMemoryServer;

/**
 * Exposed so tests that need to deliberately disconnect mongoose (e.g.
 * to prove a health-check endpoint correctly reports "not ready") can
 * reconnect afterward without needing to spin up a second in-memory
 * server or guess at a connection string.
 */
export function getTestMongoUri(): string {
  return mongoServer.getUri();
}

beforeAll(async () => {
  // An in-memory MongoDB instance, not a real Atlas connection — this is
  // what lets `npm test` run in CI with zero external dependencies and no
  // real database credentials, in a few seconds.
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  // Mongoose builds declared indexes (including unique ones) in the
  // background after connecting - without waiting for Model.init() here,
  // a test could insert data before a unique index actually exists to
  // enforce anything, exactly as happened with the chunk idempotency
  // test before this fix (see config/db.ts for the same fix in the real
  // app startup path). RefreshTokenModel, GitHubConnectionModel, and
  // GitHubOAuthStateModel each have a unique index - same risk shape.
  // ChatModel/MessageModel were missing here since Day 5 (their indexes
  // aren't unique, so the failure mode is milder, but every model with a
  // declared index belongs in this list) - this checklist item has been
  // missed once already, so every new indexed model gets checked against
  // it deliberately now.
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
});

afterEach(async () => {
  const collections = mongoose.connection.collections;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  await mongoServer?.stop();
});
