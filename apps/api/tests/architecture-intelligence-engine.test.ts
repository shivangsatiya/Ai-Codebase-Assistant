import { ArchitectureIntelligenceEngine } from '../src/services/knowledge-graph/architecture-intelligence-engine';
import type { IArchitectureAlgorithm, GraphInput } from '../src/services/knowledge-graph/architecture-intelligence-engine';
import { NotFoundError } from '../src/utils/errors';

class FakeAlgorithm implements IArchitectureAlgorithm<{ received: unknown }> {
  readonly name = 'fake-algorithm';
  run(_graph: GraphInput, params?: Record<string, unknown>): { received: unknown } {
    return { received: params };
  }
}

describe('ArchitectureIntelligenceEngine', () => {
  it('dispatches to a registered algorithm by name', () => {
    const engine = new ArchitectureIntelligenceEngine();
    engine.register(new FakeAlgorithm());

    const result = engine.run('fake-algorithm', { nodes: [], edges: [] }, { foo: 'bar' });

    expect(result).toEqual({ received: { foo: 'bar' } });
  });

  it('throws NotFoundError for an unregistered algorithm name, listing what IS available', () => {
    const engine = new ArchitectureIntelligenceEngine();
    engine.register(new FakeAlgorithm());

    expect(() => engine.run('nonexistent-algorithm', { nodes: [], edges: [] })).toThrow(NotFoundError);
    expect(() => engine.run('nonexistent-algorithm', { nodes: [], edges: [] })).toThrow(/fake-algorithm/);
  });

  it('listAlgorithmNames reflects every registered algorithm - the extensibility contract made concrete', () => {
    const engine = new ArchitectureIntelligenceEngine();
    engine.register(new FakeAlgorithm());

    expect(engine.listAlgorithmNames()).toEqual(['fake-algorithm']);
  });
});
