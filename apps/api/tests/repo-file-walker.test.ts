import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { walkRepoFiles } from '../src/utils/repo-file-walker';
import { ValidationError } from '../src/utils/errors';

describe('walkRepoFiles', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'walker-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns indexable files with forward-slash relative paths regardless of host OS', async () => {
    // Node's path.relative() returns backslashes on Windows - this
    // caught a real bug where citations looked like
    // "test\suites\function.js" instead of "test/suites/function.js".
    await mkdir(join(testDir, 'src', 'nested'), { recursive: true });
    await writeFile(join(testDir, 'src', 'nested', 'file.ts'), 'export const x = 1;');

    const files = await walkRepoFiles(testDir, 100, 1024 * 1024);

    expect(files).toHaveLength(1);
    expect(files[0]!.relativePath).toBe('src/nested/file.ts');
    expect(files[0]!.relativePath).not.toContain('\\');
  });

  it('only includes files with indexable extensions', async () => {
    await writeFile(join(testDir, 'code.ts'), 'const x = 1;');
    await writeFile(join(testDir, 'binary.exe'), 'not real binary content');
    await writeFile(join(testDir, 'image.png'), 'not real image content');

    const files = await walkRepoFiles(testDir, 100, 1024 * 1024);

    expect(files.map((f) => f.relativePath)).toEqual(['code.ts']);
  });

  it('skips ignored directories like node_modules and .git', async () => {
    await mkdir(join(testDir, 'node_modules', 'some-package'), { recursive: true });
    await writeFile(join(testDir, 'node_modules', 'some-package', 'index.js'), 'module.exports = {};');
    await mkdir(join(testDir, '.git'), { recursive: true });
    await writeFile(join(testDir, '.git', 'config'), 'irrelevant');
    await writeFile(join(testDir, 'real-code.ts'), 'const x = 1;');

    const files = await walkRepoFiles(testDir, 100, 1024 * 1024);

    expect(files.map((f) => f.relativePath)).toEqual(['real-code.ts']);
  });

  it('excludes individual files larger than the size ceiling without failing the whole walk', async () => {
    await writeFile(join(testDir, 'small.ts'), 'const x = 1;');
    await writeFile(join(testDir, 'huge.ts'), 'x'.repeat(10_000));

    const files = await walkRepoFiles(testDir, 100, 100); // 100-byte ceiling

    expect(files.map((f) => f.relativePath)).toEqual(['small.ts']);
  });

  it('throws ValidationError when the repo exceeds the file-count ceiling', async () => {
    for (let i = 0; i < 10; i++) {
      await writeFile(join(testDir, `file${i}.ts`), 'const x = 1;');
    }

    await expect(walkRepoFiles(testDir, 5, 1024 * 1024)).rejects.toThrow(ValidationError);
  });
});
