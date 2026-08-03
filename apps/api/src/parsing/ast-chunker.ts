import Parser from 'web-tree-sitter';
import { createParserForExtension, getLanguageConfig } from './language-registry';
import { chunkLinesAsWindows } from './line-window-chunker';
import type { RawChunk } from './types';

type SyntaxNode = Parser.SyntaxNode;

/**
 * Why chunk at function/class boundaries instead of every N lines?
 *
 * A fixed-size window has no idea where a function starts or ends - it
 * will happily cut one in half, so a question like "what does
 * validateUser do?" retrieves half the function body with no signature
 * and no closing brace. The embedding for that half-function chunk is
 * semantically incoherent, which is exactly what tanks retrieval
 * accuracy. Parsing the real AST and chunking at
 * function/method/class boundaries means every chunk is a complete,
 * meaningful unit of code - which is also why voyage-code-3 (or any
 * code-specific embedding model) actually earns its retrieval-quality
 * advantage: it's trained on units of code that look like this.
 *
 * Returns null when the extension has no configured grammar, or when
 * parsing throws - the caller (chunking.service.ts) treats null as "fall
 * back to line-window chunking for the whole file" rather than failing
 * the import.
 */
export async function extractAstChunks(sourceCode: string, extension: string): Promise<RawChunk[] | null> {
  const config = getLanguageConfig(extension);
  if (!config) return null;

  let parser;
  try {
    parser = await createParserForExtension(extension);
  } catch {
    return null;
  }
  if (!parser) return null;

  let tree;
  try {
    tree = parser.parse(sourceCode);
  } catch {
    return null;
  }
  if (!tree) return null;

  const lines = sourceCode.split('\n');
  const chunks: RawChunk[] = [];
  const coveredRanges: Array<[number, number]> = [];

  const nodeText = (node: SyntaxNode): string =>
    lines.slice(node.startPosition.row, node.endPosition.row + 1).join('\n');

  const walk = (node: SyntaxNode, enclosingClassName?: string): void => {
    if (config.classNodeTypes.includes(node.type)) {
      const className = node.childForFieldName('name')?.text ?? 'AnonymousClass';
      const hasMatchedMethod = node.descendantsOfType(config.functionNodeTypes).length > 0;

      if (!hasMatchedMethod) {
        // No methods inside (e.g. a data-only class) - the class itself
        // is the smallest useful unit; emit it whole and stop recursing.
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        chunks.push({
          startLine,
          endLine,
          content: nodeText(node),
          symbolName: className,
          chunkType: 'class',
          source: 'ast',
        });
        coveredRanges.push([startLine, endLine]);
        return;
      }

      // Has methods - don't also emit a whole-class chunk, or the class
      // body would be indexed twice (once as the class, once per method).
      // Recurse with the class name attached so methods become
      // "ClassName.methodName" rather than an unqualified name.
      for (const child of node.children) {
        if (child) walk(child, className);
      }
      return;
    }

    if (config.functionNodeTypes.includes(node.type)) {
      const rawName = node.childForFieldName('name')?.text;
      const symbolName = enclosingClassName
        ? `${enclosingClassName}.${rawName ?? '<anonymous>'}`
        : rawName ?? '<anonymous>';

      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      chunks.push({
        startLine,
        endLine,
        content: nodeText(node),
        symbolName,
        // Based on enclosing-class context, not the raw node type name:
        // Python's grammar uses `function_definition` for both top-level
        // functions AND methods (unlike JS's separate
        // `method_definition`), so checking node.type alone would
        // mislabel every Python method as a "function".
        chunkType: enclosingClassName ? 'method' : 'function',
        source: 'ast',
      });
      coveredRanges.push([startLine, endLine]);
      // Deliberately not recursing into a matched function's own body -
      // a nested closure inside it is still part of that function's
      // meaning, not a separate retrievable unit worth its own chunk.
      return;
    }

    for (const child of node.children) {
      if (child) walk(child, enclosingClassName);
    }
  };

  walk(tree.rootNode);

  if (chunks.length === 0) {
    // Parsed successfully but nothing chunkable was found (e.g. a file
    // that's all top-level constants) - let the caller fall back to pure
    // line-window chunking rather than silently indexing nothing for it.
    return null;
  }

  const gapChunks = fillUncoveredGaps(lines, coveredRanges);

  return [...chunks, ...gapChunks].sort((a, b) => a.startLine - b.startLine);
}

/**
 * Imports, top-level constants, and decorators between functions aren't
 * inside any function/class node, so the walk above never chunks them -
 * without this step, "where do we import express?" would have no chunk
 * to retrieve. This finds every line range NOT covered by an extracted
 * chunk and line-window-chunks just those gaps.
 */
function fillUncoveredGaps(lines: string[], coveredRanges: Array<[number, number]>): RawChunk[] {
  const sorted = [...coveredRanges].sort((a, b) => a[0] - b[0]);
  const gaps: Array<[number, number]> = [];
  let cursor = 1;

  for (const [start, end] of sorted) {
    if (start > cursor) {
      gaps.push([cursor, start - 1]);
    }
    cursor = Math.max(cursor, end + 1);
  }
  if (cursor <= lines.length) {
    gaps.push([cursor, lines.length]);
  }

  const gapChunks: RawChunk[] = [];
  for (const [gapStart, gapEnd] of gaps) {
    const gapLines = lines.slice(gapStart - 1, gapEnd);
    if (gapLines.every((line) => line.trim().length === 0)) continue; // skip blank-only gaps

    gapChunks.push(...chunkLinesAsWindows(gapLines, gapStart, 40, 0));
  }
  return gapChunks;
}
