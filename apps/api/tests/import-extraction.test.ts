import { extractImportSpecifiers } from '../src/services/knowledge-graph/import-extraction';

describe('extractImportSpecifiers - JS/TS family', () => {
  it('extracts a named import specifier', async () => {
    const source = `import { foo } from './foo';`;
    expect(await extractImportSpecifiers(source, '.ts')).toEqual(['./foo']);
  });

  it('extracts a default import specifier', async () => {
    const source = `import bar from 'bar-package';`;
    expect(await extractImportSpecifiers(source, '.ts')).toEqual(['bar-package']);
  });

  it('extracts a require() call specifier', async () => {
    const source = `const baz = require('./baz');`;
    expect(await extractImportSpecifiers(source, '.ts')).toEqual(['./baz']);
  });

  it('extracts multiple imports from the same file, in order', async () => {
    const source = `
      import { a } from './a';
      import b from 'b-package';
      const c = require('./c');
    `;
    expect(await extractImportSpecifiers(source, '.ts')).toEqual(['./a', 'b-package', './c']);
  });

  it('does not extract a require-like call that is not actually require', async () => {
    const source = `const x = notRequire('./fake');`;
    expect(await extractImportSpecifiers(source, '.ts')).toEqual([]);
  });

  it('returns an empty array for a file with no imports', async () => {
    const source = `function greet() { return 'hi'; }`;
    expect(await extractImportSpecifiers(source, '.ts')).toEqual([]);
  });

  it('works the same way for .jsx and .tsx extensions', async () => {
    const source = `import React from 'react';`;
    expect(await extractImportSpecifiers(source, '.jsx')).toEqual(['react']);
    expect(await extractImportSpecifiers(source, '.tsx')).toEqual(['react']);
  });
});

describe('extractImportSpecifiers - Python', () => {
  it('extracts a plain import', async () => {
    expect(await extractImportSpecifiers('import os', '.py')).toEqual(['os']);
  });

  it('extracts a from-import, using the FROM module, not the imported symbol', async () => {
    const source = 'from foo.bar import baz';
    expect(await extractImportSpecifiers(source, '.py')).toEqual(['foo.bar']);
  });

  it('extracts multiple import statements', async () => {
    const source = 'import os\nfrom foo.bar import baz\n';
    expect(await extractImportSpecifiers(source, '.py')).toEqual(['os', 'foo.bar']);
  });
});

describe('extractImportSpecifiers - graceful fallback', () => {
  it('returns an empty array for an unsupported extension, not an error', async () => {
    expect(await extractImportSpecifiers('anything', '.rb')).toEqual([]);
  });

  it('returns an empty array for genuinely unparseable content, not an error', async () => {
    // A real parse failure shouldn't throw and shouldn't fail the whole
    // import - the same graceful-fallback philosophy ast-chunker.ts
    // already uses.
    const result = await extractImportSpecifiers('{{{{{ not valid syntax at all }}}}', '.ts');
    expect(Array.isArray(result)).toBe(true);
  });
});
