import type { ChunkSearchResult } from '../repositories/chunk.repository';
import type { Citation } from '../models/message.model';

/**
 * Why instruct the model to explicitly say when it doesn't know, and
 * only cite from the provided context?
 *
 * This is the design doc's core non-functional requirement: "wrong
 * answers with confident citations are worse than 'I couldn't find
 * that'." An LLM given a vague question and no strong match in its
 * retrieved context will, left to its own devices, still generate a
 * plausible-sounding answer from general programming knowledge - which
 * is exactly the failure mode a codebase assistant can't afford, since
 * a wrong answer about someone's own code is worse than no answer.
 */
export function buildSystemPrompt(retrievedChunks: ChunkSearchResult[]): string {
  if (retrievedChunks.length === 0) {
    return [
      'You are a codebase assistant. No relevant code was found for this question.',
      'Tell the user you could not find relevant code for their question, and suggest they rephrase it.',
      'Do not answer from general programming knowledge - only from retrieved code context.',
    ].join(' ');
  }

  const contextBlocks = retrievedChunks
    .map((chunk, i) => {
      const location = `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`;
      const label = chunk.symbolName ? `${chunk.symbolName} (${chunk.chunkType})` : chunk.chunkType;
      return [`--- Context ${i + 1}: ${location} - ${label} ---`, chunk.content].join('\n');
    })
    .join('\n\n');

  return [
    'You are a codebase assistant answering questions about a specific repository.',
    'Answer ONLY using the code context provided below - never from general programming knowledge.',
    'If the provided context does not contain enough information to answer, say so explicitly rather than guessing.',
    'For every factual claim about the code, cite its source inline using the exact format [filepath:startLine-endLine], using the ACTUAL file path and line numbers shown in the context blocks below.',
    'Never invent a citation, even as a placeholder or example - if you are unsure of the exact path or line numbers for a claim, omit the citation for that claim rather than guessing or fabricating one.',
    'Use the exact file paths and line numbers shown in each context block below - do not invent or approximate them.',
    '',
    contextBlocks,
  ].join('\n');
}

const CITATION_PATTERN = /\[([^\]:]+):(\d+)-(\d+)\]/g;

/**
 * Why parse citations out of the model's own generated text instead of,
 * say, having the model return structured JSON?
 *
 * Streaming plain text token-by-token is what makes the "feels
 * responsive" requirement work - the UI renders words as they arrive.
 * Structured JSON output can't be meaningfully streamed the same way
 * (a user doesn't want to watch `{"citations": [{"file` render token by
 * token). Extracting the [filepath:startLine-endLine] pattern from the
 * completed text after streaming finishes gets structured citations for
 * storage without sacrificing streaming UX during generation.
 */
export function extractCitations(text: string): Citation[] {
  const citations: Citation[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(CITATION_PATTERN)) {
    const [, filePath, startLineStr, endLineStr] = match;
    if (!filePath || !startLineStr || !endLineStr) continue;

    const key = `${filePath}:${startLineStr}-${endLineStr}`;
    if (seen.has(key)) continue;
    seen.add(key);

    citations.push({
      filePath,
      startLine: Number(startLineStr),
      endLine: Number(endLineStr),
    });
  }

  return citations;
}
