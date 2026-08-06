import Parser from 'web-tree-sitter';
import { createParserForExtension } from '../../parsing/language-registry';

type SyntaxNode = Parser.SyntaxNode;

const JS_FAMILY_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);

/**
 * Finds the first descendant of the given type using a simple
 * depth-first walk - AST shapes here were verified directly against
 * real tree-sitter output before writing this (an import_statement's
 * module path lives at string > string_fragment; a require() call's
 * argument at call_expression > arguments > string > string_fragment),
 * not assumed from documentation or memory.
 */
function findFirstDescendantOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  if (node.type === type) return node;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      const found = findFirstDescendantOfType(child, type);
      if (found) return found;
    }
  }
  return null;
}

function extractJsFamilyImports(root: SyntaxNode): string[] {
  const specifiers: string[] = [];

  function walk(node: SyntaxNode): void {
    if (node.type === 'import_statement') {
      const stringFragment = findFirstDescendantOfType(node, 'string_fragment');
      if (stringFragment) specifiers.push(stringFragment.text);
      // Deliberately not recursing into an import_statement's own
      // children further - nothing meaningful for import extraction
      // lives deeper than the string literal already found.
      return;
    }

    if (node.type === 'call_expression') {
      const callee = node.child(0);
      if (callee?.type === 'identifier' && callee.text === 'require') {
        const stringFragment = findFirstDescendantOfType(node, 'string_fragment');
        if (stringFragment) specifiers.push(stringFragment.text);
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  }

  walk(root);
  return specifiers;
}

function extractPythonImports(root: SyntaxNode): string[] {
  const specifiers: string[] = [];

  function walk(node: SyntaxNode): void {
    // Both import_statement ("import os") and import_from_statement
    // ("from foo.bar import baz") carry the module path as their FIRST
    // dotted_name child - import_from_statement has a second dotted_name
    // for the imported symbol, which isn't a module dependency and is
    // deliberately not collected here.
    if (node.type === 'import_statement' || node.type === 'import_from_statement') {
      const dottedName = node.children.find((c) => c?.type === 'dotted_name');
      if (dottedName) specifiers.push(dottedName.text);
      return;
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  }

  walk(root);
  return specifiers;
}

/**
 * Returns the raw, unresolved specifier strings found in a file's
 * import/require statements - e.g. "./foo", "react", "foo.bar".
 * Resolving these into actual graph edges (relative path -> another
 * file in the repo, bare specifier -> an external package node) is
 * DeterministicExtractor's job, not this module's - this module's only
 * responsibility is finding what a file's source code actually says,
 * accurately, for the languages this project already chunks by AST.
 *
 * Returns an empty array (not an error) for an unsupported extension or
 * a parse failure - the same "fall back gracefully, don't fail the
 * whole import" philosophy ast-chunker.ts already uses for chunking.
 */
export async function extractImportSpecifiers(sourceCode: string, extension: string): Promise<string[]> {
  let parser: Parser | null;
  try {
    parser = await createParserForExtension(extension);
  } catch {
    return [];
  }
  if (!parser) return [];

  let tree;
  try {
    tree = parser.parse(sourceCode);
  } catch {
    return [];
  }
  if (!tree) return [];

  if (JS_FAMILY_EXTENSIONS.has(extension)) {
    return extractJsFamilyImports(tree.rootNode);
  }
  if (extension === '.py') {
    return extractPythonImports(tree.rootNode);
  }
  return [];
}
