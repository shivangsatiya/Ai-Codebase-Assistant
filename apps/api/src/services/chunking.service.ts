import { createHash } from 'crypto';
import { extractAstChunks } from '../parsing/ast-chunker';
import { lineWindowChunkFile } from '../parsing/line-window-chunker';
import { isStructurallyChunkable } from '../parsing/language-registry';
import type { RawChunk } from '../parsing/types';

export interface EnrichedChunk extends RawChunk {
  filePath: string;
  language: string;
  contentHash: string;
}

function extensionToLanguageLabel(extension: string): string {
  // Deliberately a display label, not the tree-sitter grammar identifier -
  // used for filtering/display, e.g. "TypeScript" in a future UI, not for
  // choosing a parser (that's language-registry.ts's job).
  const map: Record<string, string> = {
    '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
    '.ts': 'TypeScript', '.tsx': 'TypeScript',
    '.py': 'Python',
    '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.rb': 'Ruby', '.php': 'PHP',
    '.c': 'C', '.cpp': 'C++', '.cs': 'C#',
    '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.md': 'Markdown',
  };
  return map[extension] ?? 'Plaintext';
}

/**
 * Why hash chunk content (not just record file path + line range) for
 * idempotency, rather than just checking "does this repo already have
 * chunks"?
 *
 * The design doc's non-functional requirement is "re-importing the same
 * repo/commit shouldn't duplicate embeddings" - keyed on
 * (repositoryId, commitSha, contentHash) at the database layer (see
 * chunk.repository.ts). Hashing the actual content, not just the
 * location, means if a file's content is byte-identical between two
 * commits, we still don't pay for a duplicate embedding call even though
 * the commitSha differs slightly elsewhere in the repo.
 */
function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Same reasoning as IGitHubClient/IGitClonerClient - lets
 * RepositoryImportService be tested against a fake that never invokes
 * the real tree-sitter WASM parser.
 */
export interface IChunkingService {
  chunkFile(filePath: string, content: string, extension: string): Promise<EnrichedChunk[]>;
}

export class ChunkingService implements IChunkingService {
  /**
   * Chunk a single file's content. Tries AST-based chunking first for
   * configured languages; falls back to line-window chunking whenever
   * AST chunking isn't applicable (unsupported language) or fails
   * (syntax the grammar couldn't parse, e.g. a file using bleeding-edge
   * syntax the bundled grammar version doesn't support yet).
   */
  async chunkFile(filePath: string, content: string, extension: string): Promise<EnrichedChunk[]> {
    let rawChunks: RawChunk[] | null = null;

    if (isStructurallyChunkable(extension)) {
      rawChunks = await extractAstChunks(content, extension);
    }

    if (!rawChunks) {
      rawChunks = lineWindowChunkFile(content);
    }

    const language = extensionToLanguageLabel(extension);

    return rawChunks.map((chunk) => ({
      ...chunk,
      filePath,
      language,
      contentHash: hashContent(chunk.content),
    }));
  }
}
