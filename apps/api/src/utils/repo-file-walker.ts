import { readdir, stat } from 'fs/promises';
import { join, extname, relative, sep } from 'path';
import { ValidationError } from './errors';

export interface WalkedFile {
  absolutePath: string;
  relativePath: string;
  extension: string;
  sizeBytes: number;
}

// Directories that are never source code worth indexing — walking into
// them wastes time and, for node_modules especially, could blow well past
// any file-count ceiling on a single dependency tree.
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  'target', // Rust/Java build output
]);

// Extensions worth indexing at all. Matches the languages tree-sitter-wasms
// bundles grammars for (see language-registry.ts) plus a few plain-text
// formats (json/yaml/markdown) that are useful context even without
// structural chunking - they fall back to line-window chunking.
const INDEXABLE_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs',
  '.ts', '.tsx',
  '.py',
  '.go', '.rs', '.java', '.rb', '.php', '.c', '.cpp', '.cs',
  '.json', '.yaml', '.yml', '.md',
]);

/**
 * Why enforce MAX_REPO_FILES and MAX_FILE_SIZE_KB here, at the walking
 * stage, rather than after chunking/embedding?
 *
 * Rejecting an oversized repo before any parsing or embedding work starts
 * means the cost (embedding compute, CPU for tree-sitter) is never spent
 * on a job that's going to fail anyway. This is the non-functional
 * requirement "reject oversized repos" from the design doc, enforced at
 * the earliest possible point.
 */
export async function walkRepoFiles(
  rootPath: string,
  maxFiles: number,
  maxFileSizeBytes: number,
): Promise<WalkedFile[]> {
  const results: WalkedFile[] = [];

  async function walk(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      if (results.length > maxFiles) {
        throw new ValidationError(
          `Repository exceeds the ${maxFiles}-file limit for indexing`,
        );
      }

      const entryPath = join(currentPath, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
          await walk(entryPath);
        }
        continue;
      }

      if (!entry.isFile()) continue;

      const extension = extname(entry.name).toLowerCase();
      if (!INDEXABLE_EXTENSIONS.has(extension)) continue;

      const stats = await stat(entryPath);
      if (stats.size > maxFileSizeBytes) {
        // Skip, don't fail the whole import - one generated/minified file
        // over the size ceiling shouldn't block indexing the rest of a
        // repo. Oversized-*repo* (too many files) is a hard failure above;
        // oversized *file* is just excluded.
        continue;
      }

      results.push({
        absolutePath: entryPath,
        // Normalized to forward slashes regardless of host OS - Node's
        // path.relative() returns backslashes on Windows, which would
        // otherwise leak into stored chunk paths and LLM citations
        // (e.g. "test\suites\function.js" instead of
        // "test/suites/function.js"), inconsistent with how the same
        // repo would be indexed on Linux (Render, CI, most contributors'
        // machines).
        relativePath: relative(rootPath, entryPath).split(sep).join('/'),
        extension,
        sizeBytes: stats.size,
      });
    }
  }

  await walk(rootPath);
  return results;
}
