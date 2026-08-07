import type { ArchitectureIntelligenceEngine, GraphInput } from './architecture-intelligence-engine';
import type { IRetrievalService } from '../retrieval.service';
import type { IChatCompletionProvider } from '../../clients/chat-completion-provider';
import { buildGraphAugmentedPrompt, type GraphFact } from './graph-prompt';
import { NotImplementedError } from '../../utils/errors';

export type QuestionCategory = 'pure_graph' | 'intelligence' | 'hybrid' | 'pure_semantic';

export interface RouterAskParams {
  question: string;
  nodeId?: string;
  targetNodeId?: string; // for path-mode questions - "path from X to Y"
  direction?: 'incoming' | 'outgoing' | 'both';
}

export interface RouterAnswer {
  category: QuestionCategory;
  algorithm?: string;
  result?: unknown;
}

export type RouterStreamEvent = { type: 'token'; text: string } | { type: 'done' };

interface Classification {
  category: QuestionCategory;
  algorithmName?: string;
  algorithmParams?: Record<string, unknown>;
}

/**
 * Why a lightweight keyword/pattern classifier, not a heavyweight ML
 * model or an LLM-based classification call?
 *
 * Consistent with this project's "avoid unnecessary complexity"
 * discipline (the same reasoning that rejected a dedicated metrics
 * backend in Milestone 1.75): question shapes like "cycle," "depends
 * on," "imports" map cleanly to a category the large majority of the
 * time. Using the LLM to classify would also be a genuine category
 * error - Pure Graph and Intelligence questions exist specifically so
 * the LLM is NEVER involved in answering them; routing them through an
 * LLM call just to decide that would quietly reintroduce the exact
 * thing this design exists to avoid.
 *
 * Why does direction detection use only a few precise, high-confidence
 * phrase patterns, defaulting to 'both' otherwise, rather than a
 * broader heuristic trying to cover every phrasing?
 *
 * English word order genuinely doesn't map onto a simple keyword rule
 * reliably ("what does X depend on" is outgoing; "what depends on X" is
 * incoming - the words are nearly identical, the meaning is reversed).
 * Guessing wrong here would silently give a factually backwards answer,
 * not just an unhelpful one - the same "don't guess wrong, prefer an
 * honest default" discipline this project applies to LLM inference,
 * applied here to natural-language parsing instead. A caller (the
 * eventual Milestone 3b frontend) can always supply `direction`
 * explicitly to override the default, exactly the same pattern already
 * established for `nodeId` in the frozen design's interaction model.
 */
export class QuestionRouter {
  constructor(
    private readonly aie: ArchitectureIntelligenceEngine,
    private readonly retrievalService: IRetrievalService,
    private readonly llmProvider: IChatCompletionProvider,
  ) {}

  classify(question: string): Classification {
    const q = question.toLowerCase();

    // Checked FIRST, deliberately - a real bug found by running these
    // tests, not assumed correct on paper: "why does this depend on
    // Redis" contains the word "depend," which the dependency-keyword
    // check below would otherwise catch first, misclassifying an
    // explanatory question as Pure Graph. Explanatory intent ("why,"
    // "explain," "how does") takes priority over a keyword that merely
    // appears somewhere inside an explanatory question.
    if (/\b(why|explain|how does)\b/.test(q)) {
      return { category: 'hybrid' };
    }

    if (/\b(cycle|cycles|circular|cyclic)\b/.test(q)) {
      return { category: 'intelligence', algorithmName: 'cycle-detection' };
    }

    if (/\bpath\b.*\bfrom\b|\bfrom\b.*\bto\b.*\bpath\b/.test(q)) {
      return { category: 'pure_graph', algorithmName: 'dependency-analysis', algorithmParams: { mode: 'path' } };
    }

    if (/\b(depend(s|ency|encies)?|imports?)\b/.test(q)) {
      const transitive = /\b(transitive(ly)?|all|indirect(ly)?|everything|entire)\b/.test(q);

      // Another real bug found by running these tests: the original
      // outgoing pattern ("what" ... "import") was broad enough to ALSO
      // match "what imports X" (which should be incoming), since it
      // never checked whether "does" appeared between "what" and the
      // verb. Outgoing phrasing always has "does X" between "what" and
      // the verb ("what does X import"); incoming phrasing has the verb
      // immediately after "what," with the subject as its direct object
      // ("what imports X"). Checking the more specific "does"-containing
      // pattern first, before the bare verb-after-"what" pattern, is
      // what actually disambiguates the two correctly.
      let direction: 'incoming' | 'outgoing' | undefined;
      if (/what does .+ (imports?|depends? on)/.test(q)) {
        direction = 'outgoing';
      } else if (/what (imports?|depends? on)/.test(q) || /who (imports?|depends? on)/.test(q)) {
        direction = 'incoming';
      }

      return {
        category: 'pure_graph',
        algorithmName: 'dependency-analysis',
        algorithmParams: { mode: transitive ? 'transitive' : 'direct', ...(direction ? { direction } : {}) },
      };
    }

    // Genuinely ambiguous questions fall through to Hybrid by default -
    // the safest default per the frozen design, since Hybrid is a
    // strict superset of what Pure Graph or Intelligence alone provide.
    return { category: 'hybrid' };
  }

  /**
   * Scoped to Pure Graph and Intelligence only - both complete
   * synchronously with no LLM involvement, matching the frozen design's
   * interaction model ("Pure Graph and Intelligence answers return
   * instantly as structured data... no streaming affordance needed").
   * Hybrid and Pure Semantic questions are handled by streamAsk()
   * instead, not by this method with a fallback - the caller (the route
   * handler) classifies the question first to decide which method to
   * call and, just as importantly, which HTTP response shape to send
   * (plain JSON here, an SSE stream there) before either method runs.
   */
  async ask(graph: GraphInput, params: RouterAskParams): Promise<RouterAnswer> {
    const classification = this.classify(params.question);

    if (classification.category === 'pure_graph' || classification.category === 'intelligence') {
      const algorithmParams: Record<string, unknown> = {
        ...classification.algorithmParams,
        ...(params.nodeId ? { nodeId: params.nodeId } : {}),
        ...(params.direction ? { direction: params.direction } : {}),
      };

      // Path mode needs "from"/"to", not "nodeId" - map the router's
      // own nodeId/targetNodeId params onto the algorithm's expected
      // shape for this one mode specifically.
      if (classification.algorithmParams?.mode === 'path') {
        delete algorithmParams.nodeId;
        if (params.nodeId) algorithmParams.from = params.nodeId;
        if (params.targetNodeId) algorithmParams.to = params.targetNodeId;
      }

      const result = this.aie.run(classification.algorithmName!, graph, algorithmParams);
      return { category: classification.category, algorithm: classification.algorithmName, result };
    }

    // Defensive - the route is expected to classify first and call
    // streamAsk() for these categories instead, but a direct or
    // misrouted call to ask() for a Hybrid/Semantic question fails
    // loudly and specifically here, rather than silently returning
    // something misleading.
    throw new NotImplementedError(
      `Questions classified as "${classification.category}" are answered by streamAsk(), not ask() - this method is scoped to Pure Graph and Intelligence questions only.`,
    );
  }

  /**
   * Handles Hybrid and Pure Semantic questions - the two categories
   * that genuinely need the LLM. Yields a discriminated union of
   * events so a caller can distinguish "here's a token to append" from
   * "the stream is finished" without needing a separate sentinel value.
   *
   * Why does this accept `repositoryId` when `ask()` doesn't need it?
   *
   * RetrievalService's real semantic search is scoped to a specific
   * repository's chunks - Pure Graph/Intelligence never touch
   * RetrievalService at all, so `ask()` never needed this.
   *
   * Why is graph-fact gathering for Hybrid questions wrapped in its own
   * try/catch, silently proceeding without those facts on failure,
   * rather than failing the whole question?
   *
   * Graph facts are a genuine enrichment for a Hybrid answer, but the
   * semantic explanation is still meaningful without them - the same
   * "a separate, additive feature failing shouldn't take down the
   * primary goal" philosophy already established for graph generation
   * itself (Task 3) and the inferred extraction tier (this task, Part
   * A), applied here at query time instead of generation time.
   */
  async *streamAsk(
    repositoryId: string,
    graph: GraphInput,
    category: 'hybrid' | 'pure_semantic',
    params: RouterAskParams,
  ): AsyncGenerator<RouterStreamEvent, void, unknown> {
    const graphFacts: GraphFact[] = [];

    if (category === 'hybrid' && params.nodeId) {
      try {
        const direct = this.aie.run('dependency-analysis', graph, {
          nodeId: params.nodeId,
          direction: 'both',
          mode: 'direct',
        }) as { nodeIds: string[] };
        graphFacts.push({ label: `Direct dependencies/dependents of ${params.nodeId}`, nodeIds: direct.nodeIds });

        if (params.targetNodeId) {
          const path = this.aie.run('dependency-analysis', graph, {
            mode: 'path',
            from: params.nodeId,
            to: params.targetNodeId,
          }) as { path: string[] | null };
          graphFacts.push({
            label: `Dependency path from ${params.nodeId} to ${params.targetNodeId}`,
            nodeIds: path.path ?? [],
          });
        }
      } catch {
        // Best-effort enrichment - proceed without graph facts rather
        // than fail the whole question over them.
      }
    }

    const retrievedChunks = await this.retrievalService.retrieve(repositoryId, params.question);
    const systemPrompt = buildGraphAugmentedPrompt(retrievedChunks, graphFacts);

    for await (const token of this.llmProvider.streamCompletion({
      systemPrompt,
      messages: [{ role: 'user', content: params.question }],
    })) {
      yield { type: 'token', text: token };
    }

    yield { type: 'done' };
  }
}
