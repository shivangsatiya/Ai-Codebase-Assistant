import { posix } from 'path';
import { extractImportSpecifiers } from './import-extraction';
import type { CandidateNode, CandidateEdge } from './types';

export interface ExtractorFileInput {
  relativePath: string; // already canonicalized (forward slashes) - matches walkRepoFiles' existing output
  content: string;
  extension: string;
}

export interface ExtractorSymbolInput {
  filePath: string;
  chunkType: string; // 'class' | 'method' | 'function' | 'line-window' - only class/method/function become nodes
  symbolName?: string;
  language: string;
}

const SOURCE = 'DeterministicExtractor';
const SOURCE_VERSION = '1';
const SYMBOL_NODE_TYPES = new Set(['class', 'method', 'function']);

/**
 * Why does this class accept full file content directly, rather than
 * reading from already-persisted Chunk documents?
 *
 * The cloned repository's files are deleted (RepositoryImportService's
 * cleanup(), in a finally block) immediately after chunking completes.
 * Import extraction needs a file's FULL source - a chunk only ever
 * contains a slice of one function/class, and an import statement often
 * isn't inside any function at all. This means extraction has to run
 * INLINE during the same import pipeline execution, before cleanup, not
 * as a separate later job reading from the database - wiring that in is
 * Task 3's job; this class just needs the right inputs handed to it.
 */
export class DeterministicExtractor {
  async extract(
    repositoryId: string,
    files: ExtractorFileInput[],
    symbols: ExtractorSymbolInput[],
  ): Promise<{ nodes: CandidateNode[]; edges: CandidateEdge[] }> {
    const nodes: CandidateNode[] = [];
    const edges: CandidateEdge[] = [];
    const knownFilePaths = new Set(files.map((f) => f.relativePath));

    this.extractFoldersAndFiles(repositoryId, files, nodes, edges);
    this.extractSymbols(symbols, nodes, edges);
    await this.extractImports(files, knownFilePaths, nodes, edges);

    return { nodes, edges };
  }

  /**
   * Folder and file nodes, plus the full `contains` chain connecting
   * every one of them back to the repository root - the direct,
   * concrete requirement Task 1's own tests proved necessary: a node
   * with no path back to the root is correctly rejected as an orphan.
   */
  private extractFoldersAndFiles(
    repositoryId: string,
    files: ExtractorFileInput[],
    nodes: CandidateNode[],
    edges: CandidateEdge[],
  ): void {
    const knownFolders = new Set<string>();

    for (const file of files) {
      const segments = file.relativePath.split('/').filter(Boolean);
      const fileName = segments.pop()!;
      let currentPath = '';

      // Every ancestor folder, root-most first, so each one's `contains`
      // edge can reference an already-known parent.
      for (const segment of segments) {
        const parentPath = currentPath;
        currentPath = currentPath ? `${currentPath}/${segment}` : segment;

        if (!knownFolders.has(currentPath)) {
          knownFolders.add(currentPath);
          nodes.push({
            type: 'folder',
            idComponents: [currentPath],
            label: segment,
            filePath: currentPath,
            metadata: {},
            source: SOURCE,
            sourceVersion: SOURCE_VERSION,
            certainty: 'deterministic',
          });

          edges.push(
            parentPath
              ? this.containsEdge('folder', [parentPath], 'folder', [currentPath])
              : this.containsEdge('repository', [repositoryId], 'folder', [currentPath]),
          );
        }
      }

      nodes.push({
        type: 'file',
        idComponents: [file.relativePath],
        label: fileName,
        filePath: file.relativePath,
        metadata: { extension: file.extension },
        source: SOURCE,
        sourceVersion: SOURCE_VERSION,
        certainty: 'deterministic',
      });

      edges.push(
        currentPath
          ? this.containsEdge('folder', [currentPath], 'file', [file.relativePath])
          : this.containsEdge('repository', [repositoryId], 'file', [file.relativePath]),
      );
    }
  }

  /**
   * class/method/function nodes directly from already-computed chunk
   * metadata - no new analysis, a reshaping step, exactly as the design
   * describes this tier. 'line-window' and any other non-symbol chunk
   * type is deliberately excluded - those aren't a named code symbol,
   * just a fallback slice of a file tree-sitter couldn't parse
   * structurally.
   */
  private extractSymbols(symbols: ExtractorSymbolInput[], nodes: CandidateNode[], edges: CandidateEdge[]): void {
    for (const symbol of symbols) {
      if (!SYMBOL_NODE_TYPES.has(symbol.chunkType) || !symbol.symbolName) continue;

      nodes.push({
        type: symbol.chunkType,
        idComponents: [symbol.filePath, symbol.symbolName],
        label: symbol.symbolName,
        filePath: symbol.filePath,
        metadata: { language: symbol.language },
        source: SOURCE,
        sourceVersion: SOURCE_VERSION,
        certainty: 'deterministic',
      });

      edges.push(
        this.containsEdge('file', [symbol.filePath], symbol.chunkType, [symbol.filePath, symbol.symbolName]),
      );
    }
  }

  /**
   * Resolves each file's raw import specifiers into either an edge to
   * another file already known in this repo (relative specifiers) or a
   * new external package node (bare specifiers). A relative specifier
   * that can't be resolved against the known file set is silently
   * skipped, not guessed at - the same "don't emit a wrong fact"
   * discipline this whole design applies to inference, applied here to
   * resolution instead.
   */
  private async extractImports(
    files: ExtractorFileInput[],
    knownFilePaths: Set<string>,
    nodes: CandidateNode[],
    edges: CandidateEdge[],
  ): Promise<void> {
    const knownPackages = new Set<string>();

    for (const file of files) {
      const specifiers = await extractImportSpecifiers(file.content, file.extension);

      for (const specifier of specifiers) {
        if (specifier.startsWith('.')) {
          const resolved = this.resolveRelativeImport(file.relativePath, specifier, knownFilePaths);
          if (!resolved) continue; // honestly unresolved - no edge, not a guess

          edges.push(this.importEdge('file', [file.relativePath], 'file', [resolved]));
        } else {
          const packageName = this.packageNameFromSpecifier(specifier, file.extension);
          if (!knownPackages.has(packageName)) {
            knownPackages.add(packageName);
            nodes.push({
              type: 'package',
              idComponents: [packageName],
              label: packageName,
              filePath: null,
              metadata: {},
              source: SOURCE,
              sourceVersion: SOURCE_VERSION,
              certainty: 'deterministic',
            });
          }
          edges.push(this.importEdge('file', [file.relativePath], 'package', [packageName]));
        }
      }
    }
  }

  private resolveRelativeImport(fromFilePath: string, specifier: string, knownFilePaths: Set<string>): string | null {
    const fromDir = posix.dirname(fromFilePath);
    const base = posix.normalize(posix.join(fromDir === '.' ? '' : fromDir, specifier));

    const candidates = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      `${base}.jsx`,
      `${base}.py`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
      `${base}/index.js`,
      `${base}/index.jsx`,
    ];

    return candidates.find((c) => knownFilePaths.has(c)) ?? null;
  }

  /**
   * A real bug found by self-review, not assumed correct: this used to
   * apply Python's dot-splitting logic to every language, including
   * JS/TS - which does nothing useful for a specifier like
   * "lodash/debounce" (no dots at all), producing a wrong "package"
   * node literally named "lodash/debounce" instead of "lodash". Fixed
   * to be language-aware: JS/TS specifiers split on '/' (handling a
   * scoped package like "@org/pkg/sub" -> "@org/pkg", two segments, not
   * one); Python specifiers split on '.' as before.
   */
  private packageNameFromSpecifier(specifier: string, extension: string): string {
    if (extension === '.py') {
      return specifier.split('.')[0]!;
    }

    const segments = specifier.split('/');
    if (specifier.startsWith('@') && segments.length >= 2) {
      return `${segments[0]}/${segments[1]}`;
    }
    return segments[0]!;
  }

  private containsEdge(
    sourceType: string,
    sourceIdComponents: string[],
    targetType: string,
    targetIdComponents: string[],
  ): CandidateEdge {
    return {
      type: 'contains',
      sourceType,
      sourceIdComponents,
      targetType,
      targetIdComponents,
      metadata: {},
      source: SOURCE,
      sourceVersion: SOURCE_VERSION,
      certainty: 'deterministic',
    };
  }

  private importEdge(
    sourceType: string,
    sourceIdComponents: string[],
    targetType: string,
    targetIdComponents: string[],
  ): CandidateEdge {
    return {
      type: 'imports',
      sourceType,
      sourceIdComponents,
      targetType,
      targetIdComponents,
      metadata: {},
      source: SOURCE,
      sourceVersion: SOURCE_VERSION,
      certainty: 'deterministic',
    };
  }
}
