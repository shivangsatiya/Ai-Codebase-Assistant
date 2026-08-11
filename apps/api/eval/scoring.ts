import type { QuestionResult, EvaluationReport, QuestionCategory } from './types';

/**
 * Pure, deterministic, and separated from run-evaluation.ts on
 * purpose: the actual scoring logic (accuracy calculation, confusion
 * matrix construction, entity-recall averaging) can be fully unit
 * tested without a live backend, a live LLM, or a real imported
 * repository - only the orchestration in run-evaluation.ts needs those.
 */
export function buildConfusionMatrix(results: QuestionResult[]): Record<string, Record<string, number>> {
  const matrix: Record<string, Record<string, number>> = {};

  for (const result of results) {
    const expected = result.expectedCategory;
    const actual = result.actualCategory;
    if (!matrix[expected]) matrix[expected] = {};
    matrix[expected][actual] = (matrix[expected][actual] ?? 0) + 1;
  }

  return matrix;
}

export function computePerCategoryAccuracy(
  results: QuestionResult[],
): Record<string, { correct: number; total: number; accuracy: number }> {
  const byCategory: Record<string, { correct: number; total: number }> = {};

  for (const result of results) {
    const key = result.expectedCategory;
    if (!byCategory[key]) byCategory[key] = { correct: 0, total: 0 };
    byCategory[key].total++;
    if (result.categoryCorrect) byCategory[key].correct++;
  }

  const withAccuracy: Record<string, { correct: number; total: number; accuracy: number }> = {};
  for (const [category, counts] of Object.entries(byCategory)) {
    withAccuracy[category] = { ...counts, accuracy: counts.total === 0 ? 0 : counts.correct / counts.total };
  }
  return withAccuracy;
}

export function computeEntityRecall(
  results: QuestionResult[],
): { averageRecall: number; questionsWithEntities: number } {
  const withEntities = results.filter((r) => r.entitiesFound.length + r.entitiesMissing.length > 0);

  if (withEntities.length === 0) {
    return { averageRecall: 0, questionsWithEntities: 0 };
  }

  const totalRecall = withEntities.reduce((sum, r) => {
    const total = r.entitiesFound.length + r.entitiesMissing.length;
    return sum + (total === 0 ? 0 : r.entitiesFound.length / total);
  }, 0);

  return { averageRecall: totalRecall / withEntities.length, questionsWithEntities: withEntities.length };
}

/**
 * Substring matching, case-insensitive, deliberately loose - this is
 * checking topical relevance in a real answer, not exact phrasing. A
 * genuinely irrelevant answer won't contain the substring at all; a
 * genuinely relevant one almost always will, in some form.
 */
export function scoreEntities(answerText: string, expectedEntities: string[]): { found: string[]; missing: string[] } {
  const lowerAnswer = answerText.toLowerCase();
  const found: string[] = [];
  const missing: string[] = [];

  for (const entity of expectedEntities) {
    if (lowerAnswer.includes(entity.toLowerCase())) {
      found.push(entity);
    } else {
      missing.push(entity);
    }
  }

  return { found, missing };
}

export function buildReport(results: QuestionResult[]): EvaluationReport {
  const correctCount = results.filter((r) => r.categoryCorrect).length;

  return {
    runAt: new Date().toISOString(),
    totalQuestions: results.length,
    routingAccuracy: results.length === 0 ? 0 : correctCount / results.length,
    confusionMatrix: buildConfusionMatrix(results),
    perCategoryAccuracy: computePerCategoryAccuracy(results),
    entityRecall: computeEntityRecall(results),
    results,
  };
}

export function isValidCategory(value: string): value is QuestionCategory {
  return value === 'pure_graph' || value === 'intelligence' || value === 'hybrid' || value === 'pure_semantic';
}
