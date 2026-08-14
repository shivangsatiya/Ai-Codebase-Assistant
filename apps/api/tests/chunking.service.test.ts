import { ChunkingService } from '../src/services/chunking.service';

describe('ChunkingService.chunkFile - defensive empty-content filter (Milestone 4 Task 5)', () => {
  const chunkingService = new ChunkingService();

  it(
    'REGRESSION: an empty file produces zero chunks - the real, confirmed bug found via a benchmark run ' +
      'against a large repository (pandas), where a single empty file anywhere caused the entire import ' +
      'to fail outright at chunk-persistence time, discarding all the expensive prior work',
    async () => {
      const chunks = await chunkingService.chunkFile('empty.py', '', '.py');
      expect(chunks).toEqual([]);
    },
  );

  it('a whitespace-only file also produces zero chunks', async () => {
    const chunks = await chunkingService.chunkFile('blank.js', '\n\n  \n\t\n', '.js');
    expect(chunks).toEqual([]);
  });

  it('a genuinely non-empty file still produces real chunks - the fix does not affect real content', async () => {
    const chunks = await chunkingService.chunkFile('real.js', 'const x = 1;\nconsole.log(x);', '.js');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.content.trim().length > 0)).toBe(true);
  });

  it('every returned chunk always has a real, non-empty contentHash - never hashes empty content', async () => {
    const chunks = await chunkingService.chunkFile('real.py', 'x = 1\ny = 2', '.py');
    for (const chunk of chunks) {
      expect(chunk.contentHash.length).toBeGreaterThan(0);
      expect(chunk.content.trim().length).toBeGreaterThan(0);
    }
  });
});
