import { describe, it, expect } from 'vitest';
import { formatStructuredResult } from '../architecture-answer';
import type { RouterAnswer } from '../ask-api';

const labelById = new Map([
  ['file:a.ts', 'a.ts'],
  ['file:b.ts', 'b.ts'],
  ['file:c.ts', 'c.ts'],
]);

describe('formatStructuredResult - dependency-analysis', () => {
  it('resolves node IDs to real labels for a direct/transitive result', () => {
    const answer: RouterAnswer = {
      category: 'pure_graph',
      algorithm: 'dependency-analysis',
      result: { mode: 'direct', nodeIds: ['file:a.ts', 'file:b.ts'] },
    };
    expect(formatStructuredResult(answer, labelById)).toBe('a.ts, b.ts');
  });

  it('falls back to the raw ID, never a fabricated label, when a node is not found in the graph', () => {
    const answer: RouterAnswer = {
      category: 'pure_graph',
      algorithm: 'dependency-analysis',
      result: { mode: 'direct', nodeIds: ['file:unknown.ts'] },
    };
    expect(formatStructuredResult(answer, labelById)).toBe('file:unknown.ts');
  });

  it('reports honestly when nothing is found, not an empty string', () => {
    const answer: RouterAnswer = {
      category: 'pure_graph',
      algorithm: 'dependency-analysis',
      result: { mode: 'direct', nodeIds: [] },
    };
    expect(formatStructuredResult(answer, labelById)).toBe('None found.');
  });

  it('formats a path result as a real arrow-chain of labels', () => {
    const answer: RouterAnswer = {
      category: 'pure_graph',
      algorithm: 'dependency-analysis',
      result: { mode: 'path', nodeIds: [], path: ['file:a.ts', 'file:b.ts', 'file:c.ts'] },
    };
    expect(formatStructuredResult(answer, labelById)).toBe('a.ts → b.ts → c.ts');
  });

  it('reports honestly when no path exists, rather than an empty string', () => {
    const answer: RouterAnswer = {
      category: 'pure_graph',
      algorithm: 'dependency-analysis',
      result: { mode: 'path', nodeIds: [], path: null },
    };
    expect(formatStructuredResult(answer, labelById)).toBe('No path exists between these components.');
  });
});

describe('formatStructuredResult - cycle-detection', () => {
  it('reports no cycles honestly, not a blank result', () => {
    const answer: RouterAnswer = {
      category: 'intelligence',
      algorithm: 'cycle-detection',
      result: { cycles: [], cycleCount: 0 },
    };
    expect(formatStructuredResult(answer, labelById)).toBe('No circular dependencies found in this repository.');
  });

  it('formats real cycles with resolved labels and correct singular/plural', () => {
    const answer: RouterAnswer = {
      category: 'intelligence',
      algorithm: 'cycle-detection',
      result: { cycles: [['file:a.ts', 'file:b.ts', 'file:a.ts']], cycleCount: 1 },
    };
    const result = formatStructuredResult(answer, labelById);
    expect(result).toContain('1 circular dependency found');
    expect(result).toContain('a.ts → b.ts → a.ts');
  });
});

describe('formatStructuredResult - unrecognized algorithm', () => {
  it('shows the raw result honestly rather than crashing or hiding it', () => {
    const answer: RouterAnswer = { category: 'intelligence', algorithm: 'some-future-algorithm', result: { foo: 'bar' } };
    expect(formatStructuredResult(answer, labelById)).toBe('{"foo":"bar"}');
  });
});
