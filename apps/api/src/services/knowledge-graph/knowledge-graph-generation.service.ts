import { DeterministicExtractor, type ExtractorFileInput, type ExtractorSymbolInput } from './deterministic-extractor';
import { InferredAnnotationExtractor } from './inferred-annotation-extractor';
import { RepositoryIntelligencePipeline } from './repository-intelligence-pipeline';
import type { PipelineResult } from './types';
import { logger } from '../../utils/logger';

/**
 * Extracted for the same reason IGitHubClient/IGitClonerClient/
 * IChunkingService were (Milestone 1.75): lets RepositoryImportService
 * be tested against a fake that never touches real extraction or a real
 * pipeline, without which its own test suite would have needed to
 * construct real DeterministicExtractor/RepositoryIntelligencePipeline
 * instances (and a real graph repository) just to test unrelated import
 * pipeline behavior.
 */
export interface IKnowledgeGraphGenerationService {
  generateGraph(
    repositoryId: string,
    commitSha: string,
    files: ExtractorFileInput[],
    symbols: ExtractorSymbolInput[],
  ): Promise<PipelineResult>;
}

/**
 * Deliberately thin for the deterministic tier - extraction and
 * governance are each already fully-owned, independently-tested
 * responsibilities (Tasks 1 and 2). Now also runs the inferred (Tier 3)
 * extractor and merges its candidates in before handing everything to
 * the pipeline together, so deduplication (a deterministic import edge
 * and an inferred "defines" edge covering related facts) and
 * cross-tier `verified` computation happen the way the frozen design
 * describes - once, over the full candidate set, not tier by tier.
 *
 * Why is a Tier 3 (LLM) failure non-fatal to graph generation overall,
 * the same way graph generation itself is non-fatal to the whole
 * import (Task 3)?
 *
 * The deterministic tier alone already produces a genuinely useful,
 * fully governed graph - if the LLM-assisted tier fails entirely (a
 * provider outage, for instance), degrading to "graph generation
 * succeeded, just without the inferred layer this time" is a better
 * outcome than losing the deterministic graph too. InferredAnnotationExtractor
 * already degrades per-file internally; this is the same philosophy
 * applied one level up, for the tier as a whole.
 */
export class KnowledgeGraphGenerationService implements IKnowledgeGraphGenerationService {
  constructor(
    private readonly extractor: DeterministicExtractor,
    private readonly inferredExtractor: InferredAnnotationExtractor,
    private readonly pipeline: RepositoryIntelligencePipeline,
  ) {}

  async generateGraph(
    repositoryId: string,
    commitSha: string,
    files: ExtractorFileInput[],
    symbols: ExtractorSymbolInput[],
  ): Promise<PipelineResult> {
    const deterministic = await this.extractor.extract(repositoryId, files, symbols);

    let inferredNodes: typeof deterministic.nodes = [];
    let inferredEdges: typeof deterministic.edges = [];
    try {
      const inferred = await this.inferredExtractor.extract(files);
      inferredNodes = inferred.nodes;
      inferredEdges = inferred.edges;
    } catch (err) {
      logger.warn({ err, repositoryId }, 'Inferred annotation extraction failed entirely - proceeding with deterministic tier only');
    }

    return this.pipeline.process(
      repositoryId,
      commitSha,
      [...deterministic.nodes, ...inferredNodes],
      [...deterministic.edges, ...inferredEdges],
    );
  }
}
