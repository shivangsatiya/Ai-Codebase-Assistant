import type { IRepositoryKnowledgeGraphRepository } from '../../repositories/repository-knowledge-graph.repository';
import type { CandidateNode, CandidateEdge, GraphNode, GraphEdge, PipelineResult, Certainty } from './types';
import { buildNodeIdFromCandidate, buildEdgeIdFromCandidate, buildNodeId } from './node-identity';
import { validateGraphInvariants } from './graph-invariants';
import { logger } from '../../utils/logger';

const PIPELINE_SOURCE = 'RepositoryIntelligencePipeline';
const PIPELINE_VERSION = '1';

interface DedupedEntry<TCandidate> {
  candidate: TCandidate;
  sources: Set<string>;
}

/**
 * Extractors add facts. This is the only component permitted to
 * transform those facts into persisted knowledge - identity,
 * canonicalization, deduplication, provenance, certainty, validation,
 * version management, and approval, as one continuous transformation.
 * See milestone-3-design.md for the full architectural reasoning.
 */
export class RepositoryIntelligencePipeline {
  constructor(private readonly graphRepo: IRepositoryKnowledgeGraphRepository) {}

  async process(
    repositoryId: string,
    commitSha: string,
    candidateNodes: CandidateNode[],
    candidateEdges: CandidateEdge[],
  ): Promise<PipelineResult> {
    // Version Management - checked first, before any of the more
    // expensive work below, since there's no reason to re-derive
    // identity or re-validate for a commit already governed.
    const existing = await this.graphRepo.findByCommitSha(repositoryId, commitSha);
    if (existing) {
      return { status: 'already_exists', repositoryId, commitSha };
    }

    // The pipeline synthesizes the repository root itself rather than
    // relying on an extractor to remember to produce one - the root's
    // identity is always deterministically derivable from repositoryId
    // alone, so generating it here guarantees the single-root invariant
    // can never fail due to an extractor bug. This is the pipeline
    // ADDING information, not reinterpreting anything an extractor
    // reported - consistent with the additive-only principle.
    const rootCandidate: CandidateNode = {
      type: 'repository',
      idComponents: [repositoryId],
      label: 'Repository',
      filePath: null,
      metadata: {},
      source: PIPELINE_SOURCE,
      sourceVersion: PIPELINE_VERSION,
      certainty: 'deterministic',
    };

    // Identity Generation (canonicalization is inherent to this step -
    // see node-identity.ts) + Deduplication.
    const dedupedNodes = this.deduplicateNodes([rootCandidate, ...candidateNodes]);
    const dedupedEdges = this.deduplicateEdges(candidateEdges);

    // Provenance Tracking + Certainty Assignment - certainty and source
    // are already present on each candidate; this step adds the one
    // field that can only be known AFTER deduplication: `verified`,
    // whether multiple independent sources produced the identical id.
    const nodes: GraphNode[] = Array.from(dedupedNodes.entries()).map(([id, entry]) => ({
      id,
      type: entry.candidate.type,
      label: entry.candidate.label,
      filePath: entry.candidate.filePath,
      metadata: entry.candidate.metadata,
      provenance: {
        source: entry.candidate.source,
        sourceVersion: entry.candidate.sourceVersion,
        certainty: entry.candidate.certainty,
        verified: entry.sources.size > 1,
      },
    }));

    const edges: GraphEdge[] = Array.from(dedupedEdges.entries()).map(([id, entry]) => {
      const sourceId = buildNodeId(entry.candidate.sourceType, entry.candidate.sourceIdComponents);
      const targetId = buildNodeId(entry.candidate.targetType, entry.candidate.targetIdComponents);
      return {
        id,
        source: sourceId,
        target: targetId,
        type: entry.candidate.type,
        metadata: entry.candidate.metadata,
        provenance: {
          source: entry.candidate.source,
          sourceVersion: entry.candidate.sourceVersion,
          certainty: entry.candidate.certainty,
          verified: entry.sources.size > 1,
        },
      };
    });

    // Graph Validation.
    const failureReasons = validateGraphInvariants(commitSha, nodes, edges);

    if (failureReasons.length > 0) {
      // Persistence Approval, the rejection path: the malformed
      // candidate data is never persisted as valid. Only the failure
      // itself, and the specific reasons, are recorded - the same
      // "quarantine the bad state, log it plainly, never silently
      // pretend success" philosophy RepositoryImportService.failImport()
      // already established.
      logger.error(
        { repositoryId, commitSha, failureReasons },
        'Repository Intelligence Pipeline rejected candidate graph',
      );
      await this.graphRepo.insert({
        repositoryId,
        commitSha,
        status: 'failed',
        nodes: [],
        edges: [],
        failureReasons,
      });
      return { status: 'failed', repositoryId, commitSha, failureReasons };
    }

    // Persistence Approval, the success path - the only code path in
    // this system that can ever mark a graph 'ready'.
    await this.graphRepo.insert({
      repositoryId,
      commitSha,
      status: 'ready',
      nodes,
      edges,
      failureReasons: [],
    });

    logger.info(
      { repositoryId, commitSha, nodeCount: nodes.length, edgeCount: edges.length },
      'Repository Intelligence Pipeline approved and persisted graph',
    );

    return { status: 'ready', repositoryId, commitSha, nodes, edges };
  }

  /**
   * Deduplication rule, stated precisely: where certainty differs
   * across candidates sharing an id, deterministic wins and inferred
   * duplicates are discarded; where certainty is identical, the first
   * occurrence wins. `sources` tracks every distinct producer that
   * reported this id, regardless of which candidate ultimately became
   * authoritative - that's what lets `verified` reflect genuine
   * cross-mechanism corroboration rather than just "which one we kept."
   */
  private deduplicateNodes(candidates: CandidateNode[]): Map<string, DedupedEntry<CandidateNode>> {
    const groups = new Map<string, CandidateNode[]>();
    for (const candidate of candidates) {
      const id = buildNodeIdFromCandidate(candidate);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id)!.push(candidate);
    }

    const result = new Map<string, DedupedEntry<CandidateNode>>();
    for (const [id, group] of groups) {
      result.set(id, { candidate: this.pickWinner(group), sources: new Set(group.map((g) => g.source)) });
    }
    return result;
  }

  private deduplicateEdges(candidates: CandidateEdge[]): Map<string, DedupedEntry<CandidateEdge>> {
    const groups = new Map<string, CandidateEdge[]>();
    for (const candidate of candidates) {
      const id = buildEdgeIdFromCandidate(candidate);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id)!.push(candidate);
    }

    const result = new Map<string, DedupedEntry<CandidateEdge>>();
    for (const [id, group] of groups) {
      result.set(id, { candidate: this.pickWinner(group), sources: new Set(group.map((g) => g.source)) });
    }
    return result;
  }

  private pickWinner<T extends { certainty: Certainty }>(group: T[]): T {
    const deterministic = group.filter((c) => c.certainty === 'deterministic');
    return deterministic.length > 0 ? deterministic[0]! : group[0]!;
  }
}
