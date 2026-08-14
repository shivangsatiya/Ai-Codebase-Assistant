import type { RawChunk } from './types';

export const DEFAULT_WINDOW_SIZE = 40;
export const DEFAULT_OVERLAP = 5;

/**
 * Why overlap between windows for the standalone fallback, but zero
 * overlap when filling gaps between AST chunks (see ast-chunker.ts)?
 *
 * Overlap exists so a concept split across a window boundary (e.g. a
 * multi-line comment explaining the code just below it) isn't silently
 * cut in half with neither window containing the whole thought. Gaps
 * between AST-extracted functions are usually short (imports, a few
 * top-level constants) - there's no boundary-splitting risk worth paying
 * duplicate-embedding cost for.
 */
export function chunkLinesAsWindows(
  lines: string[],
  startLineNumber: number,
  windowSize: number = DEFAULT_WINDOW_SIZE,
  overlap: number = DEFAULT_OVERLAP,
): RawChunk[] {
  if (lines.length === 0) return [];

  const chunks: RawChunk[] = [];
  const step = Math.max(windowSize - overlap, 1);

  for (let offset = 0; offset < lines.length; offset += step) {
    const windowLines = lines.slice(offset, offset + windowSize);
    if (windowLines.length === 0) break;

    const startLine = startLineNumber + offset;
    const endLine = startLine + windowLines.length - 1;

    chunks.push({
      startLine,
      endLine,
      content: windowLines.join('\n'),
      chunkType: 'line-window',
      source: 'line-window',
    });

    if (offset + windowSize >= lines.length) break;
  }

  return chunks;
}

/** Whole-file fallback for languages with no tree-sitter grammar configured, or files whose AST parse failed. */
export function lineWindowChunkFile(
  fileContent: string,
  windowSize: number = DEFAULT_WINDOW_SIZE,
  overlap: number = DEFAULT_OVERLAP,
): RawChunk[] {
  // A real, confirmed bug found during Milestone 4 Task 5's benchmark
  // work: "".split('\n') returns [''] (a one-element array containing
  // an empty string), not [] - so a genuinely empty file's content
  // never actually hit the existing `if (lines.length === 0) return []`
  // guard in chunkLinesAsWindows below, and produced exactly one chunk
  // with content: '' instead. That chunk then failed real Mongoose
  // schema validation at chunk-persistence time (`content` is a
  // required field) - and because insertManyIdempotent only tolerates
  // duplicate-key errors, re-throwing everything else, a SINGLE empty
  // file anywhere in a large repository (a common, ordinary occurrence
  // - an empty __init__.py, for instance) was enough to fail an entire
  // import outright at the final persistence step, discarding all the
  // real, expensive work (clone through embedding) that had already
  // succeeded. Trimmed here explicitly, rather than relying on
  // String.split's own behavior for this edge case.
  if (fileContent.trim().length === 0) return [];

  const lines = fileContent.split('\n');
  return chunkLinesAsWindows(lines, 1, windowSize, overlap);
}
