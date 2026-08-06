import type { IArchitectureAlgorithm, GraphInput } from '../architecture-intelligence-engine';
import type { GraphEdge } from '../types';
import { ValidationError } from '../../../utils/errors';

export type DependencyDirection = 'incoming' | 'outgoing' | 'both';
export type DependencyMode = 'direct' | 'transitive' | 'path';

export interface DependencyAnalysisParams {
  nodeId?: string;
  direction?: DependencyDirection;
  mode?: DependencyMode;
  from?: string;
  to?: string;
  edgeType?: string;
}

export interface DependencyAnalysisResult {
  mode: DependencyMode;
  nodeIds: string[];
  path?: string[] | null;
}

/**
 * One registered algorithm covering direct, transitive, and
 * path-between-two-nodes dependency queries - matching how the frozen
 * design describes DependencyAnalyzer as a single algorithm spanning
 * "incoming/outgoing edges directly, transitive closure via graph
 * traversal, dependency chains as paths," not three separate ones.
 */
export class DependencyAnalyzer implements IArchitectureAlgorithm<DependencyAnalysisResult> {
  readonly name = 'dependency-analysis';

  run(graph: GraphInput, rawParams: Record<string, unknown> = {}): DependencyAnalysisResult {
    const params = rawParams as DependencyAnalysisParams;
    const edges = params.edgeType ? graph.edges.filter((e) => e.type === params.edgeType) : graph.edges;
    const mode = params.mode ?? 'direct';

    if (mode === 'path') {
      if (!params.from || !params.to) {
        throw new ValidationError('dependency-analysis mode "path" requires both "from" and "to" params');
      }
      return { mode, nodeIds: [], path: this.findShortestPath(edges, params.from, params.to) };
    }

    if (!params.nodeId) {
      throw new ValidationError(`dependency-analysis mode "${mode}" requires a "nodeId" param`);
    }

    const direction = params.direction ?? 'both';

    if (mode === 'direct') {
      return { mode, nodeIds: this.directNeighbors(edges, params.nodeId, direction) };
    }

    return { mode, nodeIds: this.transitiveClosure(edges, params.nodeId, direction) };
  }

  private directNeighbors(edges: GraphEdge[], nodeId: string, direction: DependencyDirection): string[] {
    const result = new Set<string>();
    for (const edge of edges) {
      if ((direction === 'outgoing' || direction === 'both') && edge.source === nodeId) result.add(edge.target);
      if ((direction === 'incoming' || direction === 'both') && edge.target === nodeId) result.add(edge.source);
    }
    return Array.from(result);
  }

  private transitiveClosure(edges: GraphEdge[], nodeId: string, direction: DependencyDirection): string[] {
    const visited = new Set<string>([nodeId]);
    const queue = [nodeId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const neighbor of this.directNeighbors(edges, current, direction)) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    visited.delete(nodeId); // the starting node isn't its own dependent/dependency
    return Array.from(visited);
  }

  /** BFS shortest path, following edges strictly in their stored direction (source -> target). */
  private findShortestPath(edges: GraphEdge[], from: string, to: string): string[] | null {
    if (from === to) return [from];

    const adjacency = new Map<string, string[]>();
    for (const edge of edges) {
      if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
      adjacency.get(edge.source)!.push(edge.target);
    }

    const visited = new Set<string>([from]);
    const queue: string[][] = [[from]];

    while (queue.length > 0) {
      const path = queue.shift()!;
      const last = path[path.length - 1]!;

      for (const neighbor of adjacency.get(last) ?? []) {
        if (neighbor === to) return [...path, neighbor];
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push([...path, neighbor]);
        }
      }
    }

    return null;
  }
}
