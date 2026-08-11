import {
  buildConfusionMatrix,
  computePerCategoryAccuracy,
  computeEntityRecall,
  scoreEntities,
  buildReport,
  isValidCategory,
} from '../eval/scoring';
import type { QuestionResult } from '../eval/types';

function makeResult(overrides: Partial<QuestionResult> = {}): QuestionResult {
  return {
    questionId: 'Q1',
    repositoryName: 'test-repo',
    questionText: 'test question',
    expectedCategory: 'pure_graph',
    actualCategory: 'pure_graph',
    categoryCorrect: true,
    responseMode: 'json',
    entitiesFound: [],
    entitiesMissing: [],
    latencyMs: 100,
    ...overrides,
  };
}

describe('buildConfusionMatrix', () => {
  it('counts a correct classification on the diagonal', () => {
    const matrix = buildConfusionMatrix([makeResult({ expectedCategory: 'pure_graph', actualCategory: 'pure_graph' })]);
    expect(matrix.pure_graph!.pure_graph).toBe(1);
  });

  it('counts a real misclassification off the diagonal, distinctly from a correct one', () => {
    const matrix = buildConfusionMatrix([
      makeResult({ expectedCategory: 'pure_graph', actualCategory: 'hybrid', categoryCorrect: false }),
    ]);
    expect(matrix.pure_graph!.hybrid).toBe(1);
    expect(matrix.pure_graph!.pure_graph).toBeUndefined();
  });

  it('accumulates multiple results into the same cell correctly', () => {
    const matrix = buildConfusionMatrix([
      makeResult({ expectedCategory: 'hybrid', actualCategory: 'hybrid' }),
      makeResult({ expectedCategory: 'hybrid', actualCategory: 'hybrid' }),
      makeResult({ expectedCategory: 'hybrid', actualCategory: 'pure_graph', categoryCorrect: false }),
    ]);
    expect(matrix.hybrid!.hybrid).toBe(2);
    expect(matrix.hybrid!.pure_graph).toBe(1);
  });
});

describe('computePerCategoryAccuracy', () => {
  it('computes real, distinct accuracy per category, not one blended number', () => {
    const results = [
      makeResult({ expectedCategory: 'pure_graph', categoryCorrect: true }),
      makeResult({ expectedCategory: 'pure_graph', categoryCorrect: true }),
      makeResult({ expectedCategory: 'pure_graph', categoryCorrect: false }),
      makeResult({ expectedCategory: 'intelligence', categoryCorrect: true }),
    ];
    const accuracy = computePerCategoryAccuracy(results);

    expect(accuracy.pure_graph).toEqual({ correct: 2, total: 3, accuracy: 2 / 3 });
    expect(accuracy.intelligence).toEqual({ correct: 1, total: 1, accuracy: 1 });
  });
});

describe('scoreEntities', () => {
  it('finds a real, case-insensitive substring match', () => {
    const result = scoreEntities('This service uses a Redis Cache for sessions.', ['redis', 'Cache']);
    expect(result.found).toEqual(['redis', 'Cache']);
    expect(result.missing).toEqual([]);
  });

  it('correctly reports a genuinely missing entity, not a false positive', () => {
    const result = scoreEntities('This service handles user authentication.', ['redis']);
    expect(result.found).toEqual([]);
    expect(result.missing).toEqual(['redis']);
  });

  it('DOCUMENTS A REAL LIMITATION: plain substring matching has no stemming, so "caching" does not match "cache" - a genuinely relevant answer using a different word form is scored as missing that entity. Worth knowing when reading a real evaluation report, not a bug in this function.', () => {
    const result = scoreEntities('This service handles caching of session data.', ['cache']);
    expect(result.missing).toEqual(['cache']);
  });
});

describe('computeEntityRecall', () => {
  it('averages recall only across questions that actually specified expected entities', () => {
    const results = [
      makeResult({ entitiesFound: ['a', 'b'], entitiesMissing: [] }),
      makeResult({ entitiesFound: ['a'], entitiesMissing: ['b'] }),
      makeResult({ entitiesFound: [], entitiesMissing: [] }),
    ];
    const recall = computeEntityRecall(results);

    expect(recall.questionsWithEntities).toBe(2);
    expect(recall.averageRecall).toBeCloseTo(0.75);
  });

  it('reports zero questions with entities, not a misleading NaN or 0%, when none specified any', () => {
    const recall = computeEntityRecall([makeResult()]);
    expect(recall.questionsWithEntities).toBe(0);
    expect(recall.averageRecall).toBe(0);
  });
});

describe('buildReport', () => {
  it('produces a real, internally consistent report from real results, not fabricated numbers', () => {
    const results = [
      makeResult({ categoryCorrect: true }),
      makeResult({ categoryCorrect: true }),
      makeResult({ categoryCorrect: false, actualCategory: 'hybrid' }),
    ];
    const report = buildReport(results);

    expect(report.totalQuestions).toBe(3);
    expect(report.routingAccuracy).toBeCloseTo(2 / 3);
    expect(report.results).toBe(results);
  });

  it('handles the empty case honestly (0/0), never dividing by zero into NaN or a fabricated 100%', () => {
    const report = buildReport([]);
    expect(report.totalQuestions).toBe(0);
    expect(report.routingAccuracy).toBe(0);
  });
});

describe('isValidCategory', () => {
  it('accepts all four real category values', () => {
    expect(isValidCategory('pure_graph')).toBe(true);
    expect(isValidCategory('intelligence')).toBe(true);
    expect(isValidCategory('hybrid')).toBe(true);
    expect(isValidCategory('pure_semantic')).toBe(true);
  });

  it('rejects a real-world error value like "error" - a response that failed is not a fifth category', () => {
    expect(isValidCategory('error')).toBe(false);
    expect(isValidCategory('')).toBe(false);
  });
});
