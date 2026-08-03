import mongoose from 'mongoose';
import { MongoChunkRepository, type ChunkToInsert } from '../src/repositories/chunk.repository';

function makeChunk(overrides: Partial<ChunkToInsert> = {}): ChunkToInsert {
  return {
    repositoryId: new mongoose.Types.ObjectId().toString(),
    commitSha: 'abc123',
    filePath: 'src/index.ts',
    startLine: 1,
    endLine: 10,
    content: 'function foo() {}',
    embedding: [0.1, 0.2, 0.3],
    language: 'TypeScript',
    chunkType: 'function',
    contentHash: 'hash-1',
    ...overrides,
  };
}

describe('MongoChunkRepository', () => {
  it('inserts new chunks and reports the correct count', async () => {
    const repo = new MongoChunkRepository();
    const chunks = [makeChunk({ contentHash: 'a' }), makeChunk({ contentHash: 'b' })];

    const result = await repo.insertManyIdempotent(chunks);

    expect(result).toEqual({ inserted: 2, skippedDuplicates: 0 });
  });

  it('is idempotent: re-inserting the same (repositoryId, commitSha, contentHash) skips duplicates without throwing', async () => {
    const repo = new MongoChunkRepository();
    const repositoryId = new mongoose.Types.ObjectId().toString();
    const chunk = makeChunk({ repositoryId, commitSha: 'same-commit', contentHash: 'same-hash' });

    const firstImport = await repo.insertManyIdempotent([chunk]);
    expect(firstImport).toEqual({ inserted: 1, skippedDuplicates: 0 });

    // Simulates re-importing the exact same commit - same repositoryId,
    // same commitSha, byte-identical chunk content (same contentHash).
    const secondImport = await repo.insertManyIdempotent([chunk]);
    expect(secondImport).toEqual({ inserted: 0, skippedDuplicates: 1 });

    const total = await repo.countByRepository(repositoryId);
    expect(total).toBe(1); // not 2 - the whole point of the unique index
  });

  it('inserts the new ones and skips only the duplicates in a mixed batch', async () => {
    const repo = new MongoChunkRepository();
    const repositoryId = new mongoose.Types.ObjectId().toString();
    const existing = makeChunk({ repositoryId, commitSha: 'c1', contentHash: 'existing-hash' });
    await repo.insertManyIdempotent([existing]);

    const mixedBatch = [
      makeChunk({ repositoryId, commitSha: 'c1', contentHash: 'existing-hash' }), // duplicate
      makeChunk({ repositoryId, commitSha: 'c1', contentHash: 'new-hash' }), // new
    ];

    const result = await repo.insertManyIdempotent(mixedBatch);

    expect(result.skippedDuplicates).toBe(1);
    expect(result.inserted).toBe(1);

    const total = await repo.countByRepository(repositoryId);
    expect(total).toBe(2); // the original + the one genuinely new chunk
  });
});
