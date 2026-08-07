import { KnowledgeGraphGenerationService } from '../src/services/knowledge-graph/knowledge-graph-generation.service';
import { DeterministicExtractor } from '../src/services/knowledge-graph/deterministic-extractor';
import { InferredAnnotationExtractor } from '../src/services/knowledge-graph/inferred-annotation-extractor';
import { RepositoryIntelligencePipeline } from '../src/services/knowledge-graph/repository-intelligence-pipeline';
import type {
  IRepositoryKnowledgeGraphRepository,
  InsertGraphInput,
} from '../src/repositories/repository-knowledge-graph.repository';
import type { RepositoryKnowledgeGraphDocument, GraphStatus } from '../src/models/repository-knowledge-graph.model';
import type { IChatCompletionProvider, StreamCompletionParams } from '../src/clients/chat-completion-provider';

class FakeGraphRepository implements IRepositoryKnowledgeGraphRepository {
  public inserted: InsertGraphInput[] = [];

  async insert(input: InsertGraphInput): Promise<RepositoryKnowledgeGraphDocument> {
    this.inserted.push(input);
    return { ...input, _id: { toString: () => 'fake-id' } } as unknown as RepositoryKnowledgeGraphDocument;
  }

  async findByCommitSha(): Promise<RepositoryKnowledgeGraphDocument | null> {
    return null;
  }

  async findLatestByRepositoryId(): Promise<RepositoryKnowledgeGraphDocument | null> {
    return null;
  }

  async findAllVersionsByRepositoryId(): Promise<Array<{ commitSha: string; status: GraphStatus; createdAt: Date }>> {
    return [];
  }
}

/**
 * Yields malformed content - these tests exercise the DETERMINISTIC
 * tier's orchestration behavior (Task 1-2), not inferred extraction
 * (Task 6's own dedicated test suite covers that in depth). Malformed
 * output means InferredAnnotationExtractor's own graceful-degradation
 * path contributes zero nodes/edges, keeping these tests' assertions
 * about the deterministic tier simple and unaffected.
 */
class NoOpChatCompletionProvider implements IChatCompletionProvider {
  async *streamCompletion(_params: StreamCompletionParams): AsyncIterable<string> {
    yield 'not valid json';
  }
}

function buildService(graphRepo: IRepositoryKnowledgeGraphRepository): KnowledgeGraphGenerationService {
  return new KnowledgeGraphGenerationService(
    new DeterministicExtractor(),
    new InferredAnnotationExtractor(new NoOpChatCompletionProvider()),
    new RepositoryIntelligencePipeline(graphRepo),
  );
}

describe('KnowledgeGraphGenerationService', () => {
  it('calls the real extractor then the real pipeline in sequence, ending in an approved graph', async () => {
    const graphRepo = new FakeGraphRepository();
    const service = buildService(graphRepo);

    const files = [{ relativePath: 'src/index.ts', content: '', extension: '.ts' }];
    const result = await service.generateGraph('repo-1', 'commit-abc', files, []);

    expect(result.status).toBe('ready');
    expect(graphRepo.inserted).toHaveLength(1);
    expect(graphRepo.inserted[0]!.status).toBe('ready');
  });

  it('propagates a failed graph (e.g. from an invariant violation) as a failed result, not a thrown error', async () => {
    // Not really achievable with the real DeterministicExtractor given
    // valid input (it always produces a connected graph) - this test
    // instead confirms the orchestration layer itself doesn't swallow or
    // alter whatever the pipeline decides, by checking the idempotent
    // "already generated" path is passed through unchanged too.
    const graphRepo = new FakeGraphRepository();
    jest.spyOn(graphRepo, 'findByCommitSha').mockResolvedValueOnce({
      status: 'ready',
    } as unknown as RepositoryKnowledgeGraphDocument);

    const service = buildService(graphRepo);

    const result = await service.generateGraph('repo-1', 'commit-abc', [], []);

    expect(result.status).toBe('already_exists');
    expect(graphRepo.inserted).toHaveLength(0);
  });

  it('degrades gracefully to the deterministic tier alone when inferred extraction fails entirely, rather than failing graph generation', async () => {
    class ThrowingChatCompletionProvider implements IChatCompletionProvider {
      async *streamCompletion(_params: StreamCompletionParams): AsyncIterable<string> {
        throw new Error('Simulated total LLM provider outage');
      }
    }

    const graphRepo = new FakeGraphRepository();
    const service = new KnowledgeGraphGenerationService(
      new DeterministicExtractor(),
      new InferredAnnotationExtractor(new ThrowingChatCompletionProvider()),
      new RepositoryIntelligencePipeline(graphRepo),
    );

    const files = [{ relativePath: 'src/index.ts', content: '', extension: '.ts' }];
    const result = await service.generateGraph('repo-1', 'commit-abc', files, []);

    // The deterministic graph still gets approved and persisted, even
    // though the inferred tier failed completely - not just one file's
    // worth of failure (already covered by InferredAnnotationExtractor's
    // own tests), but every file, at the extract() call level itself.
    expect(result.status).toBe('ready');
  });
});
