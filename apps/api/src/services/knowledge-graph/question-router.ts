import type { ArchitectureIntelligenceEngine, GraphInput } from './architecture-intelligence-engine';
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
  constructor(private readonly aie: ArchitectureIntelligenceEngine) {}

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
   * Why does this throw NotImplementedError for Hybrid/Semantic instead
   * of silently falling back to something else?
   *
   * This task deliberately scopes to Pure Graph and Intelligence only -
   * Hybrid and Pure Semantic need RetrievalService and LLM streaming
   * integration, which is Task 6's job, sequenced alongside the
   * inferred extraction tier Hybrid questions benefit most from. A
   * clear 501 here is the honest signal that this category genuinely
   * isn't built yet, not a silent wrong answer or a crash.
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

    throw new NotImplementedError(
      `Questions requiring ${classification.category === 'hybrid' ? 'explanation combined with graph facts' : 'semantic search'} are not yet supported - only Pure Graph and Intelligence questions are answerable today.`,
    );
  }
}
