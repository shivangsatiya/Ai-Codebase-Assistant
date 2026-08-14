import { RepositoryIntelligencePipeline } from '../src/services/knowledge-graph/repository-intelligence-pipeline';
import type {
  IRepositoryKnowledgeGraphRepository,
  InsertGraphInput,
} from '../src/repositories/repository-knowledge-graph.repository';
import type { RepositoryKnowledgeGraphDocument, GraphStatus } from '../src/models/repository-knowledge-graph.model';
import type { CandidateNode, CandidateEdge } from '../src/services/knowledge-graph/types';

class FakeGraphRepository implements IRepositoryKnowledgeGraphRepository {
  public inserted: InsertGraphInput[] = [];
  private existing = new Map<string, InsertGraphInput>();

  seedExisting(repositoryId: string, commitSha: string): void {
    this.existing.set(`${repositoryId}:${commitSha}`, {
      repositoryId,
      commitSha,
      status: 'ready',
      nodes: [],
      edges: [],
      failureReasons: [],
    });
  }

  async insert(input: InsertGraphInput): Promise<RepositoryKnowledgeGraphDocument> {
    this.inserted.push(input);
    return { ...input, _id: { toString: () => 'fake-id' } } as unknown as RepositoryKnowledgeGraphDocument;
  }

  async findByCommitSha(repositoryId: string, commitSha: string): Promise<RepositoryKnowledgeGraphDocument | null> {
    const found = this.existing.get(`${repositoryId}:${commitSha}`);
    return found ? ({ ...found } as unknown as RepositoryKnowledgeGraphDocument) : null;
  }

  async findLatestByRepositoryId(_repositoryId: string): Promise<RepositoryKnowledgeGraphDocument | null> {
    return null;
  }

  async findAllVersionsByRepositoryId(
    _repositoryId: string,
  ): Promise<Array<{ commitSha: string; status: GraphStatus; createdAt: Date }>> {
    return [];
  }

  async deleteByRepositoryId(_repositoryId: string): Promise<void> {
    // no-op - not exercised by these tests
  }
}

function fileCandidate(path: string, overrides: Partial<CandidateNode> = {}): CandidateNode {
  return {
    type: 'file',
    idComponents: [path],
    label: path,
    filePath: path,
    metadata: {},
    source: 'DeterministicExtractor',
    sourceVersion: '1',
    certainty: 'deterministic',
    ...overrides,
  };
}

function importsEdge(from: string, to: string, overrides: Partial<CandidateEdge> = {}): CandidateEdge {
  return {
    type: 'imports',
    sourceType: 'file',
    sourceIdComponents: [from],
    targetType: 'file',
    targetIdComponents: [to],
    metadata: {},
    source: 'DeterministicExtractor',
    sourceVersion: '1',
    certainty: 'deterministic',
    ...overrides,
  };
}

/**
 * Connects a file node directly to the synthesized repository root - a
 * real extractor (Task 2) will need to produce edges like this for
 * every file/folder, or the "no orphan nodes" invariant correctly
 * rejects them. Discovered by running these tests for real, not
 * assumed: several tests below originally omitted this and were
 * unintentionally testing a rejection scenario instead of the success
 * scenario they meant to test.
 */
function containsEdge(filePath: string, overrides: Partial<CandidateEdge> = {}): CandidateEdge {
  return {
    type: 'contains',
    sourceType: 'repository',
    sourceIdComponents: ['repo-1'],
    targetType: 'file',
    targetIdComponents: [filePath],
    metadata: {},
    source: 'DeterministicExtractor',
    sourceVersion: '1',
    certainty: 'deterministic',
    ...overrides,
  };
}

describe('RepositoryIntelligencePipeline - idempotency', () => {
  it('returns already_exists and does not insert anything when a graph already exists for this commit', async () => {
    const repo = new FakeGraphRepository();
    repo.seedExisting('repo-1', 'commit-abc');
    const pipeline = new RepositoryIntelligencePipeline(repo);

    const result = await pipeline.process('repo-1', 'commit-abc', [], []);

    expect(result.status).toBe('already_exists');
    expect(repo.inserted).toHaveLength(0);
  });
});

describe('RepositoryIntelligencePipeline - root synthesis', () => {
  it('always includes exactly one repository root node, even with zero candidate nodes', async () => {
    const repo = new FakeGraphRepository();
    const pipeline = new RepositoryIntelligencePipeline(repo);

    const result = await pipeline.process('repo-1', 'commit-abc', [], []);

    expect(result.status).toBe('ready');
    const roots = result.nodes!.filter((n) => n.type === 'repository');
    expect(roots).toHaveLength(1);
    expect(roots[0]!.id).toBe('repository:repo-1');
  });
});

describe('RepositoryIntelligencePipeline - deduplication', () => {
  it('a deterministic candidate wins over an inferred candidate sharing the same node id', async () => {
    const repo = new FakeGraphRepository();
    const pipeline = new RepositoryIntelligencePipeline(repo);

    const deterministic = fileCandidate('src/a.ts', { source: 'DeterministicExtractor', certainty: 'deterministic', label: 'from-deterministic' });
    const inferred = fileCandidate('src/a.ts', { source: 'InferredAnnotationExtractor', certainty: 'inferred', label: 'from-inferred' });

    const result = await pipeline.process('repo-1', 'commit-abc', [deterministic, inferred], [containsEdge('src/a.ts')]);

    const node = result.nodes!.find((n) => n.id === 'file:src/a.ts');
    expect(node!.provenance.certainty).toBe('deterministic');
    expect(node!.label).toBe('from-deterministic');
  });

  it('marks a fact verified when multiple independent sources produced the identical id, regardless of which one wins', async () => {
    const repo = new FakeGraphRepository();
    const pipeline = new RepositoryIntelligencePipeline(repo);

    const deterministic = fileCandidate('src/a.ts', { source: 'DeterministicExtractor', certainty: 'deterministic' });
    const inferred = fileCandidate('src/a.ts', { source: 'InferredAnnotationExtractor', certainty: 'inferred' });

    const result = await pipeline.process('repo-1', 'commit-abc', [deterministic, inferred], [containsEdge('src/a.ts')]);

    const node = result.nodes!.find((n) => n.id === 'file:src/a.ts');
    expect(node!.provenance.verified).toBe(true);
  });

  it('marks a fact unverified when only one source ever produced it', async () => {
    const repo = new FakeGraphRepository();
    const pipeline = new RepositoryIntelligencePipeline(repo);

    const nodes = [fileCandidate('src/a.ts')];
    const edges = [containsEdge('src/a.ts')];
    const result = await pipeline.process('repo-1', 'commit-abc', nodes, edges);

    const node = result.nodes!.find((n) => n.id === 'file:src/a.ts');
    expect(node!.provenance.verified).toBe(false);
  });

  it('two path-separator variants of the same file collapse into one node, not two', async () => {
    const repo = new FakeGraphRepository();
    const pipeline = new RepositoryIntelligencePipeline(repo);

    const candidates = [fileCandidate('src\\a.ts'), fileCandidate('src/a.ts')];
    const edges = [containsEdge('src/a.ts')];
    const result = await pipeline.process('repo-1', 'commit-abc', candidates, edges);

    const matchingNodes = result.nodes!.filter((n) => n.id === 'file:src/a.ts');
    expect(matchingNodes).toHaveLength(1);
  });

  it('deduplicates edges the same way as nodes', async () => {
    const repo = new FakeGraphRepository();
    const pipeline = new RepositoryIntelligencePipeline(repo);

    const nodes = [fileCandidate('src/a.ts'), fileCandidate('src/b.ts')];
    const edges = [
      containsEdge('src/a.ts'),
      importsEdge('src/a.ts', 'src/b.ts', { source: 'DeterministicExtractor', certainty: 'deterministic' }),
      importsEdge('src/a.ts', 'src/b.ts', { source: 'InferredAnnotationExtractor', certainty: 'inferred' }),
    ];

    const result = await pipeline.process('repo-1', 'commit-abc', nodes, edges);

    const importEdges = result.edges!.filter((e) => e.type === 'imports');
    expect(importEdges).toHaveLength(1);
    expect(importEdges[0]!.provenance.certainty).toBe('deterministic');
    expect(importEdges[0]!.provenance.verified).toBe(true);
  });
});

describe('RepositoryIntelligencePipeline - approval and persistence', () => {
  it('persists a valid graph with status ready', async () => {
    const repo = new FakeGraphRepository();
    const pipeline = new RepositoryIntelligencePipeline(repo);

    await pipeline.process('repo-1', 'commit-abc', [fileCandidate('src/a.ts')], [containsEdge('src/a.ts')]);

    expect(repo.inserted).toHaveLength(1);
    expect(repo.inserted[0]!.status).toBe('ready');
  });

  it('a node produced by extraction but never connected to the root is rejected as an orphan', async () => {
    const repo = new FakeGraphRepository();
    const pipeline = new RepositoryIntelligencePipeline(repo);

    // A dangling edge referencing a node that was never actually
    // produced - exactly the kind of bug this whole layer exists to
    // catch before it reaches a user.
    const nodes = [fileCandidate('src/a.ts')];
    const edges = [importsEdge('src/a.ts', 'src/does-not-exist.ts')];

    const result = await pipeline.process('repo-1', 'commit-abc', nodes, edges);

    expect(result.status).toBe('failed');
    expect(result.failureReasons!.length).toBeGreaterThan(0);
  });

  it('a rejected graph is persisted with status failed and specific reasons, never with the malformed nodes/edges as if they were valid', async () => {
    const repo = new FakeGraphRepository();
    const pipeline = new RepositoryIntelligencePipeline(repo);

    const nodes = [fileCandidate('src/a.ts')];
    const edges = [importsEdge('src/a.ts', 'src/does-not-exist.ts')];

    await pipeline.process('repo-1', 'commit-abc', nodes, edges);

    expect(repo.inserted).toHaveLength(1);
    expect(repo.inserted[0]!.status).toBe('failed');
    expect(repo.inserted[0]!.nodes).toEqual([]);
    expect(repo.inserted[0]!.edges).toEqual([]);
    expect(repo.inserted[0]!.failureReasons.length).toBeGreaterThan(0);
  });
});
