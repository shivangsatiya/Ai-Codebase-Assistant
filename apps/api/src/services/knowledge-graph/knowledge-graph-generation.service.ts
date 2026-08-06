import { DeterministicExtractor, type ExtractorFileInput, type ExtractorSymbolInput } from './deterministic-extractor';
import { RepositoryIntelligencePipeline } from './repository-intelligence-pipeline';
import type { PipelineResult } from './types';

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
 * Deliberately thin - extraction and governance are each already
 * fully-owned, independently-tested responsibilities (Tasks 1 and 2).
 * This class's only job is calling one, then the other, with the right
 * data - it holds no logic of its own worth testing beyond "does it
 * call through correctly," which the tests below verify directly.
 */
export class KnowledgeGraphGenerationService implements IKnowledgeGraphGenerationService {
  constructor(
    private readonly extractor: DeterministicExtractor,
    private readonly pipeline: RepositoryIntelligencePipeline,
  ) {}

  async generateGraph(
    repositoryId: string,
    commitSha: string,
    files: ExtractorFileInput[],
    symbols: ExtractorSymbolInput[],
  ): Promise<PipelineResult> {
    const { nodes, edges } = await this.extractor.extract(repositoryId, files, symbols);
    return this.pipeline.process(repositoryId, commitSha, nodes, edges);
  }
}
