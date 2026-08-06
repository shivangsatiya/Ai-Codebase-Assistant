import type { GraphNode, GraphEdge } from './types';
import { NotFoundError } from '../../utils/errors';

export interface GraphInput {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * The interface every current and future algorithm implements
 * identically. Adding a future algorithm (dead code detection, security
 * review, god-object detection, and the rest of the frozen design's
 * "Future Intelligence" list) means writing one new class implementing
 * this interface and registering it - no graph model change required
 * for any of these.
 */
export interface IArchitectureAlgorithm<TResult> {
  readonly name: string;
  run(graph: GraphInput, params?: Record<string, unknown>): TResult;
}

/**
 * Every algorithm registered here treats the graph as immutable,
 * trusted input - it performs zero integrity checks of its own, per the
 * frozen design's explicit trust boundary with the Repository
 * Intelligence Pipeline. Nothing in this class enforces that on its
 * own; it's a property of how each algorithm is written, verified by
 * each algorithm's own tests never needing to defend against malformed
 * graph data.
 */
export class ArchitectureIntelligenceEngine {
  private readonly algorithms = new Map<string, IArchitectureAlgorithm<unknown>>();

  register(algorithm: IArchitectureAlgorithm<unknown>): void {
    this.algorithms.set(algorithm.name, algorithm);
  }

  run(name: string, graph: GraphInput, params?: Record<string, unknown>): unknown {
    const algorithm = this.algorithms.get(name);
    if (!algorithm) {
      throw new NotFoundError(
        `No algorithm registered with name "${name}". Available: ${this.listAlgorithmNames().join(', ')}`,
      );
    }
    return algorithm.run(graph, params);
  }

  listAlgorithmNames(): string[] {
    return Array.from(this.algorithms.keys());
  }
}
