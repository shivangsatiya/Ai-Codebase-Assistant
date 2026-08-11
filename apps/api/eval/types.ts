export type QuestionCategory = 'pure_graph' | 'intelligence' | 'hybrid' | 'pure_semantic';

export interface GoldenQuestion {
  id: string;
  text: string;
  /**
   * The category the REAL classify() implementation is expected to
   * produce, traced through the actual regex logic in
   * question-router.ts before being written here - not a guess at
   * what "should" happen conceptually. See the dataset file's own
   * comments for the specific trace on each question.
   */
  expectedCategory: QuestionCategory;
  /**
   * A label substring (e.g. "authRoutes.js") the runner resolves
   * against the real, already-fetched graph to find a real node ID -
   * never a hardcoded ID, since those are only stable in practice, not
   * guaranteed by any contract.
   */
  nodeLabelHint?: string;
  /**
   * For retrieval/answer evaluation: substrings a genuinely correct
   * answer should mention. Not an exact-match requirement - a
   * case-insensitive substring check, intentionally loose, since this
   * is checking for topical relevance, not phrasing.
   */
  expectedEntities?: string[];
  /**
   * Free-text criteria a human (or a careful re-read) checks the
   * answer against - used for cases substring-matching can't capture,
   * e.g. "the answer should NOT claim this repository uses a database."
   */
  criteria: string;
}

export interface GoldenRepository {
  name: string;
  githubUrl: string;
  /** Set once the repository is actually imported and ready - the runner fills this in, never assumed in advance. */
  repositoryId?: string;
  questions: GoldenQuestion[];
}

export interface GoldenDataset {
  repositories: GoldenRepository[];
}

export interface QuestionResult {
  questionId: string;
  repositoryName: string;
  questionText: string;
  expectedCategory: QuestionCategory;
  actualCategory: QuestionCategory | 'error';
  categoryCorrect: boolean;
  responseMode: 'json' | 'stream' | 'error';
  answerText?: string;
  entitiesFound: string[];
  entitiesMissing: string[];
  errorMessage?: string;
  latencyMs: number;
}

export interface EvaluationReport {
  runAt: string;
  totalQuestions: number;
  routingAccuracy: number;
  confusionMatrix: Record<string, Record<string, number>>;
  perCategoryAccuracy: Record<string, { correct: number; total: number; accuracy: number }>;
  entityRecall: { averageRecall: number; questionsWithEntities: number };
  results: QuestionResult[];
}
