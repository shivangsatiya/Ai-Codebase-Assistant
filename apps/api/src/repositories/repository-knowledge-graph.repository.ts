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
 *
 * deleteByRepositoryId, added for Milestone 4 Task 4.5, is a different
 * kind of operation from the mutation this interface still refuses to
 * support: it removes whole documents outright, on the repository's
 * own deletion, rather than modifying the contents of a document that
 * continues to exist. The immutability guarantee this interface
 * enforces is specifically about a graph's own content never silently
 * changing while its repository is still alive - not a promise that a
 * graph outlives the repository it describes after that repository is
 * gone. Confirmed as a real, missing gap directly during Milestone 4's
 * design phase: repository deletion cascaded to chats, jobs, and
 * chunks, but never to this collection, leaving orphaned graph
 * documents behind indefinitely.
 */
export interface IRepositoryKnowledgeGraphRepository {
  insert(input: InsertGraphInput): Promise<RepositoryKnowledgeGraphDocument>;
  findByCommitSha(repositoryId: string, commitSha: string): Promise<RepositoryKnowledgeGraphDocument | null>;
  findLatestByRepositoryId(repositoryId: string): Promise<RepositoryKnowledgeGraphDocument | null>;
  findAllVersionsByRepositoryId(
    repositoryId: string,
  ): Promise<Array<{ commitSha: string; status: GraphStatus; createdAt: Date }>>;
  deleteByRepositoryId(repositoryId: string): Promise<void>;
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

  async deleteByRepositoryId(repositoryId: string): Promise<void> {
    // Every version of the graph this repository ever had, not just
    // the current 'ready' one - a repository can accumulate multiple
    // graph documents over its real history (one per commit ever
    // successfully processed, per this collection's own append-only
    // design), and all of them become meaningless once the repository
    // itself is gone.
    await RepositoryKnowledgeGraphModel.deleteMany({ repositoryId }).exec();
  }
}
