import { lineWindowChunkFile, chunkLinesAsWindows } from '../src/parsing/line-window-chunker';

describe('lineWindowChunkFile', () => {
  it('produces a single chunk for a file smaller than the window size', () => {
    const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');

    const chunks = lineWindowChunkFile(content, 40, 5);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine).toBe(10);
  });

  it('produces overlapping windows for a file larger than the window size', () => {
    const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');

    const chunks = lineWindowChunkFile(content, 40, 5);

    // step = 40 - 5 = 35, so windows start at 1, 36, 71
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 40 });
    expect(chunks[1]).toMatchObject({ startLine: 36, endLine: 75 });
    expect(chunks[2]).toMatchObject({ startLine: 71, endLine: 100 });
    expect(chunks).toHaveLength(3);
  });

  it('covers every line with zero gaps, even at the file boundary', () => {
    const content = Array.from({ length: 83 }, (_, i) => `line ${i + 1}`).join('\n');
    const chunks = lineWindowChunkFile(content, 40, 5);

    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk!.endLine).toBe(83);
  });

  it('supports zero overlap for gap-filling use (ast-chunker.ts)', () => {
    const lines = ['a', 'b', 'c', 'd', 'e'];
    const chunks = chunkLinesAsWindows(lines, 10, 2, 0);

    // window size 2, no overlap -> step 2: [10-11], [12-13], [14-14]
    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
      [10, 11],
      [12, 13],
      [14, 14],
    ]);
  });

  it(
    'REGRESSION (Milestone 4 Task 5): a genuinely empty file produces zero chunks, not one chunk with ' +
      "empty content - found via a real benchmark run, where \"\".split('\\n') returning [''] (length 1, " +
      "not 0) meant the file's own guard clause never actually triggered for a real empty file",
    () => {
      expect(lineWindowChunkFile('')).toEqual([]);
    },
  );

  it('a whitespace-only file (e.g. a file with just blank lines) also produces zero chunks, not meaningless ones', () => {
    expect(lineWindowChunkFile('\n\n\n')).toEqual([]);
    expect(lineWindowChunkFile('   \n\t\n  ')).toEqual([]);
  });

  it('a genuinely non-empty file still chunks normally - the fix does not affect real content', () => {
    const chunks = lineWindowChunkFile('const x = 1;\nconst y = 2;');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.content).toContain('const x = 1;');
  });
});
