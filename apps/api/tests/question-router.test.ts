import { QuestionRouter } from '../src/services/knowledge-graph/question-router';
import { ArchitectureIntelligenceEngine } from '../src/services/knowledge-graph/architecture-intelligence-engine';
import { CycleDetector } from '../src/services/knowledge-graph/algorithms/cycle-detector';
import { DependencyAnalyzer } from '../src/services/knowledge-graph/algorithms/dependency-analyzer';
import { NotImplementedError } from '../src/utils/errors';
import type { GraphEdge } from '../src/services/knowledge-graph/types';
import type { IRetrievalService } from '../src/services/retrieval.service';
import type { ChunkSearchResult } from '../src/repositories/chunk.repository';
import type { IChatCompletionProvider, StreamCompletionParams } from '../src/clients/chat-completion-provider';

function edge(source: string, target: string, type = 'imports'): GraphEdge {
  return {
    id: `edge:${source}->${type}->${target}`,
    source,
    target,
    type,
    metadata: {},
    provenance: { source: 'test', sourceVersion: '1', certainty: 'deterministic', verified: false },
  };
}

function buildEngine(): ArchitectureIntelligenceEngine {
  const engine = new ArchitectureIntelligenceEngine();
  engine.register(new CycleDetector());
  engine.register(new DependencyAnalyzer());
  return engine;
}

class FakeRetrievalService implements IRetrievalService {
  public lastCall: { repositoryId: string; query: string } | null = null;
  constructor(private readonly results: ChunkSearchResult[] = []) {}

  async retrieve(repositoryId: string, query: string): Promise<ChunkSearchResult[]> {
    this.lastCall = { repositoryId, query };
    return this.results;
  }
}

class FakeChatCompletionProvider implements IChatCompletionProvider {
  public lastParams: StreamCompletionParams | null = null;
  constructor(private readonly tokensToYield: string[] = []) {}

  async *streamCompletion(params: StreamCompletionParams): AsyncIterable<string> {
    this.lastParams = params;
    for (const token of this.tokensToYield) {
      yield token;
    }
  }
}

function buildRouter(
  retrievalService: IRetrievalService = new FakeRetrievalService(),
  llmProvider: IChatCompletionProvider = new FakeChatCompletionProvider(),
): QuestionRouter {
  return new QuestionRouter(buildEngine(), retrievalService, llmProvider);
}

describe('QuestionRouter - classification', () => {
  const router = buildRouter();

  it('classifies a cycle question as Intelligence, routed to cycle-detection', () => {
    const c = router.classify('are there any circular dependencies?');
    expect(c.category).toBe('intelligence');
    expect(c.algorithmName).toBe('cycle-detection');
  });

  it('classifies a dependency question as Pure Graph, routed to dependency-analysis', () => {
    const c = router.classify('what does this file depend on?');
    expect(c.category).toBe('pure_graph');
    expect(c.algorithmName).toBe('dependency-analysis');
  });

  it('detects outgoing direction from "what does X import" phrasing', () => {
    const c = router.classify('what does AuthService import?');
    expect(c.algorithmParams?.direction).toBe('outgoing');
  });

  it('detects incoming direction from "what imports X" phrasing', () => {
    const c = router.classify('what imports AuthService?');
    expect(c.algorithmParams?.direction).toBe('incoming');
  });

  it('defaults to no explicit direction (both) for ambiguous phrasing', () => {
    const c = router.classify('show me the dependencies here');
    expect(c.algorithmParams?.direction).toBeUndefined();
  });

  it('detects a transitive request from "all" / "transitively" / "indirect" phrasing', () => {
    expect(router.classify('what are all the transitive dependencies?').algorithmParams?.mode).toBe('transitive');
    expect(router.classify('show indirect dependencies').algorithmParams?.mode).toBe('transitive');
  });

  it('defaults to direct mode without transitive language', () => {
    const c = router.classify('what does this depend on?');
    expect(c.algorithmParams?.mode).toBe('direct');
  });

  it('classifies an explanatory "why" question as Hybrid', () => {
    expect(router.classify('why does this depend on Redis?').category).toBe('hybrid');
  });

  it('classifies a genuinely ambiguous question as Hybrid, the safe default', () => {
    expect(router.classify('tell me about this codebase').category).toBe('hybrid');
  });
});

describe('QuestionRouter - ask (Pure Graph / Intelligence dispatch)', () => {
  it('answers a cycle question with a real cycle-detection result, zero LLM involvement possible in this code path', async () => {
    const router = buildRouter();
    const edges = [edge('A', 'B'), edge('B', 'A')];

    const answer = await router.ask({ nodes: [], edges }, { question: 'are there any cycles?' });

    expect(answer.category).toBe('intelligence');
    expect(answer.algorithm).toBe('cycle-detection');
    expect((answer.result as { cycleCount: number }).cycleCount).toBe(1);
  });

  it('answers a dependency question scoped to a specific nodeId', async () => {
    const router = buildRouter();
    const edges = [edge('A', 'B'), edge('A', 'C')];

    const answer = await router.ask({ nodes: [], edges }, { question: 'what does this import?', nodeId: 'A' });

    expect(answer.category).toBe('pure_graph');
    expect((answer.result as { nodeIds: string[] }).nodeIds.sort()).toEqual(['B', 'C']);
  });

  it('answers a path question using nodeId/targetNodeId as from/to', async () => {
    const router = buildRouter();
    const edges = [edge('A', 'B'), edge('B', 'C')];

    const answer = await router.ask(
      { nodes: [], edges },
      { question: 'show the path from this to that', nodeId: 'A', targetNodeId: 'C' },
    );

    expect((answer.result as { path: string[] }).path).toEqual(['A', 'B', 'C']);
  });

  it('throws NotImplementedError, not a silent wrong answer or a crash, for a Hybrid-shaped question', async () => {
    const router = buildRouter();

    await expect(router.ask({ nodes: [], edges: [] }, { question: 'why does this depend on Redis?' })).rejects.toThrow(
      NotImplementedError,
    );
  });

  it('throws NotImplementedError for a genuinely ambiguous question too, not a wrong guess', async () => {
    const router = buildRouter();

    await expect(router.ask({ nodes: [], edges: [] }, { question: 'tell me about this' })).rejects.toThrow(
      NotImplementedError,
    );
  });
});

describe('QuestionRouter - streamAsk (Hybrid / Pure Semantic dispatch)', () => {
  it('streams tokens from the LLM provider, ending with a done event', async () => {
    const llmProvider = new FakeChatCompletionProvider(['Hello', ' ', 'world']);
    const router = buildRouter(new FakeRetrievalService(), llmProvider);

    const events = [];
    for await (const event of router.streamAsk('repo-1', { nodes: [], edges: [] }, 'pure_semantic', {
      question: 'explain this service',
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'token', text: 'Hello' },
      { type: 'token', text: ' ' },
      { type: 'token', text: 'world' },
      { type: 'done' },
    ]);
  });

  it('calls RetrievalService scoped to the given repositoryId with the question as the query', async () => {
    const retrievalService = new FakeRetrievalService();
    const router = buildRouter(retrievalService, new FakeChatCompletionProvider([]));

    for await (const _event of router.streamAsk('repo-42', { nodes: [], edges: [] }, 'pure_semantic', {
      question: 'explain this',
    })) {
      void _event;
    }

    expect(retrievalService.lastCall).toEqual({ repositoryId: 'repo-42', query: 'explain this' });
  });

  it('for a Hybrid question with a nodeId, gathers graph facts and includes them in the system prompt', async () => {
    const llmProvider = new FakeChatCompletionProvider([]);
    const engine = buildEngine();
    const router = new QuestionRouter(engine, new FakeRetrievalService(), llmProvider);
    const edges = [edge('A', 'B'), edge('A', 'C')];

    for await (const _event of router.streamAsk('repo-1', { nodes: [], edges }, 'hybrid', {
      question: 'why does A depend on these?',
      nodeId: 'A',
    })) {
      void _event;
    }

    expect(llmProvider.lastParams!.systemPrompt).toContain('Graph context');
    expect(llmProvider.lastParams!.systemPrompt).toContain('B');
    expect(llmProvider.lastParams!.systemPrompt).toContain('C');
  });

  it('for a Pure Semantic question (no graph facts requested), the prompt has no Graph context section', async () => {
    const llmProvider = new FakeChatCompletionProvider([]);
    const router = buildRouter(new FakeRetrievalService(), llmProvider);

    for await (const _event of router.streamAsk('repo-1', { nodes: [], edges: [] }, 'pure_semantic', {
      question: 'explain this service',
    })) {
      void _event;
    }

    expect(llmProvider.lastParams!.systemPrompt).not.toContain('Graph context');
  });

  it('proceeds without graph facts, not failing the whole question, when graph fact gathering throws', async () => {
    const llmProvider = new FakeChatCompletionProvider(['answer']);
    // An engine with NO algorithms registered - running dependency-analysis
    // will throw NotFoundError internally, exercising the try/catch.
    const emptyEngine = new ArchitectureIntelligenceEngine();
    const router = new QuestionRouter(emptyEngine, new FakeRetrievalService(), llmProvider);

    const events = [];
    for await (const event of router.streamAsk('repo-1', { nodes: [], edges: [] }, 'hybrid', {
      question: 'why does this depend on Redis?',
      nodeId: 'A',
    })) {
      events.push(event);
    }

    // The question still gets answered despite graph-fact gathering
    // failing entirely - the primary goal (a semantic explanation)
    // isn't blocked by the enrichment failing.
    expect(events.some((e) => e.type === 'token')).toBe(true);
    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });
});
