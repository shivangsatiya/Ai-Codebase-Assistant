import { extractAstChunks } from '../src/parsing/ast-chunker';

describe('extractAstChunks - JavaScript', () => {
  it('extracts a top-level function declaration as its own chunk', async () => {
    const source = [
      'function add(a, b) {',
      '  return a + b;',
      '}',
    ].join('\n');

    const chunks = await extractAstChunks(source, '.js');

    expect(chunks).not.toBeNull();
    const fnChunk = chunks!.find((c) => c.chunkType === 'function');
    expect(fnChunk).toBeDefined();
    expect(fnChunk!.symbolName).toBe('add');
    expect(fnChunk!.startLine).toBe(1);
    expect(fnChunk!.endLine).toBe(3);
  });

  it('qualifies method names with their enclosing class name', async () => {
    const source = [
      'class UserService {',
      '  findById(id) {',
      '    return db.find(id);',
      '  }',
      '',
      '  create(data) {',
      '    return db.insert(data);',
      '  }',
      '}',
    ].join('\n');

    const chunks = await extractAstChunks(source, '.js');

    expect(chunks).not.toBeNull();
    const methodNames = chunks!.filter((c) => c.chunkType === 'method').map((c) => c.symbolName);
    expect(methodNames).toEqual(expect.arrayContaining(['UserService.findById', 'UserService.create']));

    // The class itself should NOT also appear as a whole-class chunk,
    // since its methods are already individually chunked - see the
    // class-node handling comment in ast-chunker.ts.
    expect(chunks!.some((c) => c.chunkType === 'class')).toBe(false);
  });

  it('emits a whole-class chunk when the class has no methods', async () => {
    const source = [
      'class Point {',
      '  x = 0;',
      '  y = 0;',
      '}',
    ].join('\n');

    const chunks = await extractAstChunks(source, '.js');

    expect(chunks).not.toBeNull();
    const classChunk = chunks!.find((c) => c.chunkType === 'class');
    expect(classChunk).toBeDefined();
    expect(classChunk!.symbolName).toBe('Point');
  });

  it('fills gaps between functions so imports/constants are still chunked', async () => {
    const source = [
      "const express = require('express');",
      '',
      'function handler(req, res) {',
      "  res.send('ok');",
      '}',
      '',
      'module.exports = handler;',
    ].join('\n');

    const chunks = await extractAstChunks(source, '.js');

    expect(chunks).not.toBeNull();
    // Line 1 (the require) and line 7 (module.exports) are not inside
    // the function - they must still show up in SOME chunk.
    const coversLine = (line: number) => chunks!.some((c) => c.startLine <= line && c.endLine >= line);
    expect(coversLine(1)).toBe(true);
    expect(coversLine(7)).toBe(true);
  });

  it('returns null for a file with nothing chunkable, letting the caller fall back', async () => {
    const source = "const PI = 3.14;\nconst E = 2.71;\n";

    const chunks = await extractAstChunks(source, '.js');

    expect(chunks).toBeNull();
  });
});

describe('extractAstChunks - TypeScript', () => {
  it('extracts a typed function declaration', async () => {
    const source = [
      'function multiply(a: number, b: number): number {',
      '  return a * b;',
      '}',
    ].join('\n');

    const chunks = await extractAstChunks(source, '.ts');

    expect(chunks).not.toBeNull();
    expect(chunks!.some((c) => c.symbolName === 'multiply' && c.chunkType === 'function')).toBe(true);
  });
});

describe('extractAstChunks - Python', () => {
  it('extracts function and class definitions with the right node types', async () => {
    const source = [
      'class Greeter:',
      '    def greet(self, name):',
      '        return f"Hello, {name}"',
    ].join('\n');

    const chunks = await extractAstChunks(source, '.py');

    expect(chunks).not.toBeNull();
    const method = chunks!.find((c) => c.symbolName === 'Greeter.greet');
    expect(method).toBeDefined();
    expect(method!.chunkType).toBe('method');
  });
});

describe('extractAstChunks - unsupported language', () => {
  it('returns null immediately for an extension with no configured grammar', async () => {
    const chunks = await extractAstChunks('SELECT * FROM users;', '.sql');
    expect(chunks).toBeNull();
  });
});
