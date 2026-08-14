import { MongoRepositoryKnowledgeGraphRepository } from '../src/repositories/repository-knowledge-graph.repository';
import { RepositoryKnowledgeGraphModel } from '../src/models/repository-knowledge-graph.model';
import { Types } from 'mongoose';

describe('MongoRepositoryKnowledgeGraphRepository.deleteByRepositoryId (Milestone 4 Task 4.5)', () => {
  const graphRepo = new MongoRepositoryKnowledgeGraphRepository();

  async function makeGraph(repositoryId: string, commitSha: string) {
    return RepositoryKnowledgeGraphModel.create({
      repositoryId,
      commitSha,
      status: 'ready',
      nodes: [],
      edges: [],
      failureReasons: [],
    });
  }

  it('deletes every graph document for the given repository', async () => {
    const repositoryId = new Types.ObjectId().toString();
    await makeGraph(repositoryId, 'commit-a');
    await makeGraph(repositoryId, 'commit-b');

    await graphRepo.deleteByRepositoryId(repositoryId);

    const remaining = await RepositoryKnowledgeGraphModel.find({ repositoryId }).exec();
    expect(remaining).toHaveLength(0);
  });

  it(
    'REGRESSION: does NOT delete a different repository\'s graph documents - the real cross-repository ' +
      'isolation guarantee this specific test exists to prove, since a service-level fake cannot ' +
      'meaningfully verify a real MongoDB query filter',
    async () => {
      const repositoryIdA = new Types.ObjectId().toString();
      const repositoryIdB = new Types.ObjectId().toString();
      await makeGraph(repositoryIdA, 'commit-a');
      const graphB = await makeGraph(repositoryIdB, 'commit-b');

      await graphRepo.deleteByRepositoryId(repositoryIdA);

      const stillThere = await RepositoryKnowledgeGraphModel.findById(graphB._id).exec();
      expect(stillThere).not.toBeNull();
      expect(stillThere?.repositoryId.toString()).toBe(repositoryIdB);
    },
  );

  it('deletes every status of graph document, not just ready ones (e.g. a failed candidate graph too)', async () => {
    const repositoryId = new Types.ObjectId().toString();
    await RepositoryKnowledgeGraphModel.create({
      repositoryId,
      commitSha: 'commit-failed',
      status: 'failed',
      nodes: [],
      edges: [],
      failureReasons: ['some validation failure'],
    });

    await graphRepo.deleteByRepositoryId(repositoryId);

    const remaining = await RepositoryKnowledgeGraphModel.find({ repositoryId }).exec();
    expect(remaining).toHaveLength(0);
  });

  it('deleting a repository with no graph documents at all does not throw', async () => {
    const repositoryId = new Types.ObjectId().toString();

    await expect(graphRepo.deleteByRepositoryId(repositoryId)).resolves.toBeUndefined();
  });
});
