import { buildSystemPrompt } from '../chat-prompt';
import type { ChunkSearchResult } from '../../repositories/chunk.repository';

export interface GraphFact {
  label: string; // e.g. "Direct dependencies of AuthService"
  nodeIds: string[];
}

/**
 * Why does this call buildSystemPrompt() internally and prepend a new
 * section, rather than duplicate its retrieved-code formatting and
 * anti-hallucination instructions from scratch?
 *
 * This is the same honesty principle the original chat prompt design
 * already insisted on (say "I don't know" rather than guess; cite only
 * from provided context), now extended with a THIRD labeled section
 * instead of collapsed back into two. Reusing buildSystemPrompt for the
 * retrieved-code portion means any future improvement to that section
 * (a stricter citation rule, better formatting) automatically applies
 * here too, rather than drifting out of sync with a duplicated copy.
 */
export function buildGraphAugmentedPrompt(retrievedChunks: ChunkSearchResult[], graphFacts: GraphFact[]): string {
  const basePrompt = buildSystemPrompt(retrievedChunks);

  if (graphFacts.length === 0) {
    return basePrompt;
  }

  const graphSection = [
    '--- Graph context (exact, deterministic facts - never approximate or contradict these) ---',
    ...graphFacts.map((fact) => `${fact.label}: ${fact.nodeIds.length > 0 ? fact.nodeIds.join(', ') : '(none found)'}`),
    '',
    'The graph context above states exact structural facts, already computed - explain and elaborate on them using the retrieved code below, but never recompute, contradict, or second-guess them.',
  ].join('\n');

  return [graphSection, '', basePrompt].join('\n');
}
