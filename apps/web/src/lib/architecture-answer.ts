import type { QuestionCategory, RouterAnswer } from './ask-api';
import type { CycleDetectionResult, DependencyAnalysisResult } from './graph-api';

/**
 * The ViewModel the Inspector/AI panel consumes - components never
 * touch RouterAnswer, SseEvent, or any raw backend shape directly.
 * `structuredSummary` (Pure Graph/Intelligence, computed, no AI) and
 * `streamedText` (Hybrid/Semantic, AI-generated) are deliberately
 * separate fields, never merged into one generic "answer" string -
 * conflating them would be exactly the epistemic dishonesty section 8
 * and 9 exist to prevent. `graphFacts` (when present) is always a
 * locally-computed, honestly-labeled supplement to an AI answer, never
 * a claim about what the LLM itself was given.
 */
export interface ArchitectureAnswer {
  id: string;
  question: string;
  nodeId: string;
  status: 'loading' | 'streaming' | 'complete' | 'error';
  category?: QuestionCategory;
  structuredSummary?: string;
  streamedText?: string;
  wasInterrupted?: boolean;
  graphFacts?: { incomingCount: number; outgoingCount: number };
  errorMessage?: string;
}

export function isAiGenerated(category: QuestionCategory | undefined): boolean {
  return category === 'hybrid' || category === 'pure_semantic';
}

/**
 * Formats a real RouterAnswer (Pure Graph/Intelligence) into readable
 * text, resolving node IDs to their real labels from the already-
 * fetched graph - never inventing a label for an ID that isn't found,
 * falling back to the raw ID instead so nothing is silently wrong.
 */
export function formatStructuredResult(answer: RouterAnswer, labelById: Map<string, string>): string {
  const resolve = (id: string) => labelById.get(id) ?? id;

  if (answer.algorithm === 'dependency-analysis') {
    const result = answer.result as DependencyAnalysisResult;

    if (result.mode === 'path') {
      if (!result.path || result.path.length === 0) {
        return 'No path exists between these components.';
      }
      return result.path.map(resolve).join(' → ');
    }

    if (result.nodeIds.length === 0) {
      return 'None found.';
    }
    return result.nodeIds.map(resolve).join(', ');
  }

  if (answer.algorithm === 'cycle-detection') {
    const result = answer.result as CycleDetectionResult;

    if (result.cycleCount === 0) {
      return 'No circular dependencies found in this repository.';
    }
    const cycleLines = result.cycles.map((cycle) => cycle.map(resolve).join(' → '));
    return `${result.cycleCount} circular dependenc${result.cycleCount === 1 ? 'y' : 'ies'} found:\n${cycleLines.join('\n')}`;
  }

  return JSON.stringify(answer.result);
}
