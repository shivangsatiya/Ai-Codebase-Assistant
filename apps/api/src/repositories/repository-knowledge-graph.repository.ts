import {
  RepositoryKnowledgeGraphModel,
  type RepositoryKnowledgeGraphDocument,
  type GraphStatus,
  type GraphNodeSubdoc,
  type GraphEdgeSubdoc,
} from '../models/repository-knowledge-graph.model';

export interface InsertGraphInput {
  repositoryId: string;
  commitSha: string;
  status: GraphStatus;
  nodes: GraphNodeSubdoc[];
  edges: GraphEdgeSubdoc[];
  failureReasons: string[];
}

/**
 * Deliberately no update() or updateStatus() method anywhere on this
 * interface. This is the concrete enforcement of "graph documents are
 * immutable once ready" - not a convention someone has to remember, but
 * a capability that simply isn't exposed. A new commit produces a new
 * document via insert(); nothing in this codebase can mutate an
 * existing one, because there's no method to call to do it.
 */
export interface IRepositoryKnowledgeGraphRepository {
  insert(input: InsertGraphInput): Promise<RepositoryKnowledgeGraphDocument>;
  findByCommitSha(repositoryId: string, commitSha: string): Promise<RepositoryKnowledgeGraphDocument | null>;
  findLatestByRepositoryId(repositoryId: string): Promise<RepositoryKnowledgeGraphDocument | null>;
  findAllVersionsByRepositoryId(
    repositoryId: string,
  ): Promise<Array<{ commitSha: string; status: GraphStatus; createdAt: Date }>>;
}

export class MongoRepositoryKnowledgeGraphRepository implements IRepositoryKnowledgeGraphRepository {
  async insert(input: InsertGraphInput): Promise<RepositoryKnowledgeGraphDocument> {
    return RepositoryKnowledgeGraphModel.create({
      repositoryId: input.repositoryId,
      commitSha: input.commitSha,
      status: input.status,
      nodes: input.nodes,
      edges: input.edges,
      failureReasons: input.failureReasons,
    });
  }

  async findByCommitSha(repositoryId: string, commitSha: string): Promise<RepositoryKnowledgeGraphDocument | null> {
    return RepositoryKnowledgeGraphModel.findOne({ repositoryId, commitSha }).exec();
  }

  async findLatestByRepositoryId(repositoryId: string): Promise<RepositoryKnowledgeGraphDocument | null> {
    return RepositoryKnowledgeGraphModel.findOne({ repositoryId, status: 'ready' })
      .sort({ createdAt: -1 })
      .exec();
  }

  async findAllVersionsByRepositoryId(
    repositoryId: string,
  ): Promise<Array<{ commitSha: string; status: GraphStatus; createdAt: Date }>> {
    const docs = await RepositoryKnowledgeGraphModel.find({ repositoryId })
      .select('commitSha status createdAt')
      .sort({ createdAt: -1 })
      .exec();
    return docs.map((d) => ({ commitSha: d.commitSha, status: d.status, createdAt: d.createdAt }));
  }
}
