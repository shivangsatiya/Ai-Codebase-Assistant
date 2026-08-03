import Parser from 'web-tree-sitter';
import { join } from 'path';

export interface LanguageConfig {
  /** Grammar file name inside the tree-sitter-wasms package's out/ directory. */
  wasmFile: string;
  /**
   * Node types that represent a standalone, chunkable function/method.
   * These become individual chunks - the whole point of AST-aware
   * chunking over fixed-size windows.
   */
  functionNodeTypes: string[];
  /**
   * Node types representing a class. Only used to name a chunk (e.g.
   * "UserService.findById") when a matched function is nested inside one -
   * we deliberately don't emit a separate whole-class chunk when it has
   * matched methods, to avoid one giant chunk duplicating content already
   * captured by its individual methods.
   */
  classNodeTypes: string[];
}

// Deliberately scoped to the languages we can meaningfully chunk by
// structure for this milestone (JS/TS family + Python) - not all 35
// grammars tree-sitter-wasms bundles. Any extension not listed here (or
// listed but whose parse fails) falls back to line-window chunking; see
// ast-chunker.ts and chunking.service.ts for how that fallback is wired.
const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
  '.js': {
    wasmFile: 'tree-sitter-javascript.wasm',
    functionNodeTypes: ['function_declaration', 'method_definition', 'generator_function_declaration'],
    classNodeTypes: ['class_declaration'],
  },
  '.jsx': {
    wasmFile: 'tree-sitter-javascript.wasm',
    functionNodeTypes: ['function_declaration', 'method_definition', 'generator_function_declaration'],
    classNodeTypes: ['class_declaration'],
  },
  '.mjs': {
    wasmFile: 'tree-sitter-javascript.wasm',
    functionNodeTypes: ['function_declaration', 'method_definition', 'generator_function_declaration'],
    classNodeTypes: ['class_declaration'],
  },
  '.cjs': {
    wasmFile: 'tree-sitter-javascript.wasm',
    functionNodeTypes: ['function_declaration', 'method_definition', 'generator_function_declaration'],
    classNodeTypes: ['class_declaration'],
  },
  '.ts': {
    wasmFile: 'tree-sitter-typescript.wasm',
    functionNodeTypes: ['function_declaration', 'method_definition', 'generator_function_declaration'],
    classNodeTypes: ['class_declaration'],
  },
  '.tsx': {
    wasmFile: 'tree-sitter-tsx.wasm',
    functionNodeTypes: ['function_declaration', 'method_definition', 'generator_function_declaration'],
    classNodeTypes: ['class_declaration'],
  },
  '.py': {
    wasmFile: 'tree-sitter-python.wasm',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['class_definition'],
  },
};

let parserInitialized = false;
const languageCache = new Map<string, Parser.Language>();

async function ensureParserInitialized(): Promise<void> {
  if (!parserInitialized) {
    await Parser.init();
    parserInitialized = true;
  }
}

/**
 * Why lazy-load and cache per-language, instead of loading all grammars
 * at startup?
 *
 * A given repo import might only touch 2-3 languages. Loading all 5
 * configured grammars (let alone all 35 tree-sitter-wasms bundles) up
 * front wastes memory and startup time for no benefit. Caching means the
 * second file of a given language in the same import is instant.
 */
export async function getLanguageForExtension(extension: string): Promise<LanguageConfig | null> {
  const config = LANGUAGE_CONFIGS[extension];
  if (!config) return null;

  await ensureParserInitialized();

  if (!languageCache.has(extension)) {
    const wasmPath = join(
      require.resolve('tree-sitter-wasms/package.json'),
      '..',
      'out',
      config.wasmFile,
    );
    const language = await Parser.Language.load(wasmPath);
    languageCache.set(extension, language);
  }

  return config;
}

export async function createParserForExtension(extension: string): Promise<Parser | null> {
  const config = LANGUAGE_CONFIGS[extension];
  if (!config) return null;

  await getLanguageForExtension(extension); // ensures it's loaded into the cache
  const language = languageCache.get(extension);
  if (!language) return null;

  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

export function getLanguageConfig(extension: string): LanguageConfig | null {
  return LANGUAGE_CONFIGS[extension] ?? null;
}

export function isStructurallyChunkable(extension: string): boolean {
  return extension in LANGUAGE_CONFIGS;
}
